package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/jpeg"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const remoteJSONLimit = 16 << 10
const remoteFrameLimit = 2 << 20

var remoteLoginID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

type remoteLoginState struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Error     string `json:"error,omitempty"`
}
type remoteLoginBinding struct {
	id, owner string
	expires   time.Time
	revoking  bool
}
type remoteLoginProxy struct {
	endpoint string
	client   *http.Client
	mu       sync.Mutex
	current  *remoteLoginBinding
	slots    chan struct{}
	disabled atomic.Bool
}
type remoteControlError struct{ status int }

func (e remoteControlError) Error() string { return "远程登录控制暂不可用" }

func validateRemoteLoginURL(value string) error {
	if value == "" {
		return nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(value, "#") || u.Opaque != "" {
		return ErrInvalid
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != "127.0.0.1:"+u.Port() {
		return ErrInvalid
	}
	return nil
}
func newRemoteLoginProxy(endpoint string) (*remoteLoginProxy, error) {
	if err := validateRemoteLoginURL(endpoint); err != nil {
		return nil, err
	}
	if endpoint == "" {
		return nil, nil
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext, MaxConnsPerHost: 8, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 16 << 10, DisableCompression: true}
	return &remoteLoginProxy{endpoint: endpoint, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, slots: make(chan struct{}, 8)}, nil
}
func (p *remoteLoginProxy) exchange(ctx context.Context, token, method, path string, body []byte, frame bool) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.endpoint+path, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := p.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 202 {
		return nil, 0, remoteControlError{response.StatusCode}
	}
	limit := int64(remoteJSONLimit)
	if frame {
		limit = remoteFrameLimit
	}
	if response.ContentLength > limit {
		return nil, 0, ErrInvalid
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, 0, ErrInvalid
	}
	if frame {
		if response.StatusCode != 200 || strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]) != "image/jpeg" {
			return nil, 0, ErrInvalid
		}
		dimensions, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || dimensions.Width != 1280 || dimensions.Height != 800 {
			return nil, 0, ErrInvalid
		}
	}
	return data, response.StatusCode, nil
}
func (p *remoteLoginProxy) state(ctx context.Context, token, method, path string, body []byte) (remoteLoginState, int, error) {
	data, status, err := p.exchange(ctx, token, method, path, body, false)
	if err != nil {
		return remoteLoginState{}, 0, err
	}
	var state remoteLoginState
	if !utf8.Valid(data) || json.Unmarshal(data, &state) != nil || state.Width != 1280 || state.Height != 800 {
		return state, 0, ErrInvalid
	}
	switch state.Status {
	case "idle":
		if state.ID != "" || state.ExpiresAt != "" {
			return state, 0, ErrInvalid
		}
	case "pending", "active", "succeeded", "failed", "expired", "cancelled":
		expires, err := time.Parse(time.RFC3339, state.ExpiresAt)
		if !remoteLoginID.MatchString(state.ID) || err != nil || expires.After(time.Now().Add(11*time.Minute)) {
			return state, 0, ErrInvalid
		}
	default:
		return state, 0, ErrInvalid
	}
	if state.Error != "" {
		state.Error = "远程登录未完成，请重新验证"
	}
	return state, status, nil
}
func remoteIdle() remoteLoginState { return remoteLoginState{Status: "idle", Width: 1280, Height: 800} }
func remoteBusy(w http.ResponseWriter, status int) {
	writeJSON(w, status, map[string]string{"status": "busy"})
}
func remoteFailure(w http.ResponseWriter, err error) {
	var upstream remoteControlError
	if errors.As(err, &upstream) {
		switch upstream.status {
		case 409:
			fail(w, 409, "remote_login_busy", "远程登录会话当前不可操作")
			return
		case 404:
			fail(w, 404, "remote_login_not_found", "登录会话已结束或不存在")
			return
		case 429:
			fail(w, 429, "remote_login_busy", "登录操作过于频繁，请稍后重试")
			return
		}
	}
	fail(w, 502, "remote_login_unavailable", "远程登录服务暂不可用")
}
func remoteSmallBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, remoteJSONLimit))
	if err != nil || !utf8.Valid(data) {
		fail(w, 400, "invalid_request", "登录操作格式或大小不符合限制")
		return nil, false
	}
	return data, true
}
func validRemoteInput(data []byte) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return false
	}
	var value struct {
		Type   string   `json:"type"`
		X      *float64 `json:"x"`
		Y      *float64 `json:"y"`
		Text   *string  `json:"text"`
		Key    *string  `json:"key"`
		Points *[]struct {
			X *float64 `json:"x"`
			Y *float64 `json:"y"`
		} `json:"points"`
		DeltaY *float64 `json:"deltaY"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return false
	}
	coordinate := func(x, y *float64) bool {
		return x != nil && y != nil && !math.IsNaN(*x) && !math.IsNaN(*y) && *x >= 0 && *x < 1280 && *y >= 0 && *y < 800
	}
	switch value.Type {
	case "click":
		return len(fields) == 3 && coordinate(value.X, value.Y)
	case "text":
		if len(fields) != 2 || value.Text == nil || utf8.RuneCountInString(*value.Text) < 1 || utf8.RuneCountInString(*value.Text) > 2000 {
			return false
		}
		for _, r := range *value.Text {
			if unicode.IsControl(r) {
				return false
			}
		}
		return true
	case "key":
		if len(fields) != 2 || value.Key == nil {
			return false
		}
		switch *value.Key {
		case "Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape", "Space":
			return true
		}
		return false
	case "drag":
		if len(fields) != 2 || value.Points == nil || len(*value.Points) < 2 || len(*value.Points) > 128 {
			return false
		}
		for _, point := range *value.Points {
			if !coordinate(point.X, point.Y) {
				return false
			}
		}
		return true
	case "scroll":
		return len(fields) == 2 && value.DeltaY != nil && !math.IsNaN(*value.DeltaY) && *value.DeltaY != 0 && math.Abs(*value.DeltaY) <= 1600
	}
	return false
}
func (h *handler) remoteLoginRoutes() {
	for _, pattern := range []string{"GET /api/account/login", "POST /api/account/login", "DELETE /api/account/login/{id}", "GET /api/account/login/{id}/frame", "POST /api/account/login/{id}/input"} {
		h.mux.HandleFunc(pattern, h.admin(h.remoteLogin))
	}
}
func (h *handler) remoteLogin(w http.ResponseWriter, r *http.Request, s session) {
	p := h.remoteLoginProxy
	if p == nil || p.disabled.Load() {
		fail(w, 503, "remote_login_disabled", "远程登录尚未启用")
		return
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		fail(w, 429, "remote_login_busy", "登录操作过于频繁，请稍后重试")
		return
	}
	id := r.PathValue("id")
	if id != "" && !remoteLoginID.MatchString(id) {
		fail(w, 404, "remote_login_not_found", "登录会话不存在")
		return
	}
	var input []byte
	if r.Method == "POST" {
		data, ok := remoteSmallBody(w, r)
		if !ok {
			return
		}
		if id != "" {
			if strings.TrimSpace(strings.Split(strings.ToLower(r.Header.Get("Content-Type")), ";")[0]) != "application/json" || !validRemoteInput(data) {
				fail(w, 400, "invalid_request", "登录操作不符合允许范围")
				return
			}
			input = data
		} else if len(bytes.TrimSpace(data)) != 0 && !bytes.Equal(bytes.TrimSpace(data), []byte("{}")) {
			fail(w, 400, "invalid_request", "创建登录会话无需填写内容")
			return
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.disabled.Load() {
		fail(w, 503, "remote_login_disabled", "远程登录正在关闭")
		return
	}
	var active bool
	if err := h.store.pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM sessions WHERE csrf_token=$1 AND expires_at>$2)", s.CSRF, h.store.now()).Scan(&active); err != nil {
		replyError(w, err)
		return
	}
	if !active {
		fail(w, 401, "unauthorized", "请先登录管理后台")
		return
	}
	if p.current != nil && !p.current.expires.After(time.Now()) {
		p.current.revoking = true
	}
	if p.current != nil && p.current.revoking && !(r.Method == "DELETE" && id != "" && p.current.id == id && p.current.owner == s.CSRF) {
		if id != "" {
			fail(w, 404, "remote_login_not_found", "登录会话正在关闭")
		} else if r.Method == "GET" {
			remoteBusy(w, 200)
		} else {
			remoteBusy(w, 409)
		}
		return
	}
	if id != "" {
		if p.current == nil || p.current.owner != s.CSRF || p.current.id != id {
			fail(w, 404, "remote_login_not_found", "登录会话不存在")
			return
		}
		if strings.HasSuffix(r.URL.Path, "/frame") {
			data, _, err := p.exchange(r.Context(), h.workerToken, "GET", "/login/"+id+"/frame", nil, true)
			if err != nil {
				remoteFailure(w, err)
				return
			}
			w.Header().Set("Content-Type", "image/jpeg")
			w.WriteHeader(200)
			w.Write(data)
			return
		}
		if r.Method == "DELETE" {
			p.current.revoking = true
			state, err := p.revoke(r.Context(), h.workerToken)
			if err != nil {
				remoteFailure(w, err)
				return
			}
			writeJSON(w, 200, state)
			return
		}
		state, _, err := p.state(r.Context(), h.workerToken, "POST", "/login/"+id+"/input", input)
		if err != nil {
			remoteFailure(w, err)
			return
		}
		if state.ID != id {
			remoteFailure(w, ErrInvalid)
			return
		}
		if state.Status == "succeeded" {
			if err = h.store.ConfirmRemoteLogin(r.Context(), id); err != nil {
				replyError(w, err)
				return
			}
		}
		writeJSON(w, 200, state)
		return
	}
	if p.current != nil && p.current.owner != s.CSRF && r.Method == "GET" {
		remoteBusy(w, 200)
		return
	}
	state, _, err := p.state(r.Context(), h.workerToken, "GET", "/login", nil)
	if err != nil {
		remoteFailure(w, err)
		return
	}
	if r.Method == "GET" {
		if p.current == nil || state.ID != p.current.id {
			if state.Status == "active" || state.Status == "pending" {
				remoteBusy(w, 200)
			} else {
				writeJSON(w, 200, remoteIdle())
			}
			return
		}
		if state.Status == "succeeded" {
			if err = h.store.ConfirmRemoteLogin(r.Context(), state.ID); err != nil {
				replyError(w, err)
				return
			}
		}
		writeJSON(w, 200, state)
		return
	}
	if state.Status == "pending" || state.Status == "active" {
		if p.current != nil && p.current.owner == s.CSRF && p.current.id == state.ID {
			writeJSON(w, 200, state)
		} else {
			remoteBusy(w, 409)
		}
		return
	}
	previousID := state.ID
	state, status, err := p.state(r.Context(), h.workerToken, "POST", "/login", nil)
	if err != nil {
		remoteFailure(w, err)
		return
	}
	if state.ID == "" || state.ID == previousID || !(state.Status == "pending" || state.Status == "active" || state.Status == "succeeded") {
		remoteFailure(w, ErrInvalid)
		return
	}
	expires, _ := time.Parse(time.RFC3339, state.ExpiresAt)
	if !expires.After(time.Now()) {
		remoteFailure(w, ErrInvalid)
		return
	}
	p.current = &remoteLoginBinding{id: state.ID, owner: s.CSRF, expires: expires}
	if state.Status == "succeeded" {
		if err = h.store.ConfirmRemoteLogin(r.Context(), state.ID); err != nil {
			replyError(w, err)
			return
		}
	}
	writeJSON(w, status, state)
}
func (p *remoteLoginProxy) revoke(ctx context.Context, token string) (remoteLoginState, error) {
	binding := p.current
	state, _, err := p.state(ctx, token, "DELETE", "/login/"+binding.id, nil)
	if err != nil {
		var upstream remoteControlError
		if errors.As(err, &upstream) && upstream.status == 404 {
			p.current = nil
			return remoteLoginState{ID: binding.id, Status: "cancelled", ExpiresAt: binding.expires.Format(time.RFC3339), Width: 1280, Height: 800}, nil
		}
		return remoteLoginState{}, err
	}
	if state.ID != binding.id || !(state.Status == "cancelled" || state.Status == "expired" || state.Status == "failed" || state.Status == "succeeded") {
		return remoteLoginState{}, ErrInvalid
	}
	p.current = nil
	return state, nil
}
func remoteLock(ctx context.Context, mu *sync.Mutex) bool {
	timer := time.NewTicker(5 * time.Millisecond)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return false
		}
		if mu.TryLock() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
		}
	}
}
func (h *handler) closeRemoteLogin(ctx context.Context, owner string) {
	p := h.remoteLoginProxy
	if p == nil {
		return
	}
	if owner == "" {
		p.disabled.Store(true)
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !remoteLock(bounded, &p.mu) {
		return
	}
	defer p.mu.Unlock()
	if p.current == nil || owner != "" && p.current.owner != owner {
		return
	}
	p.current.revoking = true
	_, _ = p.revoke(bounded, h.workerToken)
}
func (h *handler) maintainRemoteLogin(ctx context.Context) error {
	p := h.remoteLoginProxy
	if p == nil || ctx.Err() != nil || !p.mu.TryLock() {
		return nil
	}
	defer p.mu.Unlock()
	if p.current == nil {
		return nil
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !p.current.revoking {
		var active bool
		if err := h.store.pool.QueryRow(bounded, "SELECT EXISTS(SELECT 1 FROM sessions WHERE csrf_token=$1 AND expires_at>$2)", p.current.owner, h.store.now()).Scan(&active); err != nil {
			return err
		}
		if active && p.current.expires.After(time.Now()) {
			return nil
		}
		p.current.revoking = true
	}
	_, _ = p.revoke(bounded, h.workerToken)
	return nil
}
