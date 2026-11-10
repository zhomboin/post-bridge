package bridge

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Config struct {
	Formatting             FormattingConfig
	Store                  *Store
	AdminUsername          string
	AdminPassword          string
	WorkerToken            string
	PlatformAccounts       []PlatformAccountConfig
	Origin                 string
	AdminDistDir           string
	RemoteLoginURL         string
	IntegrationMasterKey   string
	IntegrationEnvironment string
	IntegrationServiceID   string
}
type handler struct {
	formattingConfig FormattingConfig
	formattingRuns   formattingRuns
	store            *Store
	username         string
	hash             []byte
	workerToken      string
	workerAccounts   map[string]string
	origin           string
	secure           bool
	dist             string
	mux              *http.ServeMux
	integrations     *IntegrationService
	remoteLoginProxy *remoteLoginProxy
	accountLoginMu   sync.Mutex
	accountLogins    map[string]*remoteLoginProxy
	attempts         map[string]loginWindow
	mu               sync.Mutex
}
type loginWindow struct {
	Count int
	Until time.Time
}
type session struct{ UserID, Username, Role, CSRF string }

func NewHandler(ctx context.Context, cfg Config) (http.Handler, error) {
	var bypass bool
	if cfg.Store != nil {
		if err := cfg.Store.pool.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user").Scan(&bypass); err != nil {
			return nil, err
		}
		if bypass {
			return nil, errors.New("API 数据库账号不得具有超级用户或绕过行权限的能力")
		}
	}
	origin, err := url.Parse(cfg.Origin)
	if err != nil || origin.Host == "" || !(origin.Scheme == "http" || origin.Scheme == "https") || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || !(origin.Path == "" || origin.Path == "/") || cfg.Store == nil || cfg.AdminUsername == "" || len(cfg.AdminPassword) < 12 || len(cfg.AdminPassword) > 72 || len(cfg.WorkerToken) < 32 {
		return nil, ErrInvalid
	}
	remote, err := newRemoteLoginProxy(cfg.RemoteLoginURL)
	if err != nil {
		return nil, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(cfg.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	if _, err = cfg.Store.pool.Exec(ctx, "INSERT INTO admins(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO NOTHING", cfg.AdminUsername, string(hash)); err != nil {
		return nil, err
	}
	if err = cfg.Store.pool.QueryRow(ctx, "SELECT password_hash FROM admins WHERE username=$1", cfg.AdminUsername).Scan(&hash); err != nil {
		return nil, err
	}
	h := &handler{
		formattingConfig: cfg.Formatting,
		store:            cfg.Store,
		username:         cfg.AdminUsername,
		hash:             hash,
		workerToken:      cfg.WorkerToken,
		origin:           strings.TrimSuffix(cfg.Origin, "/"),
		secure:           origin.Scheme == "https",
		dist:             cfg.AdminDistDir,
		mux:              http.NewServeMux(),
		attempts:         map[string]loginWindow{},
	}
	h.remoteLoginProxy = remote
	if err = h.initializeUsers(ctx, cfg.AdminUsername); err != nil {
		return nil, err
	}
	if err = cfg.Store.ConfigurePlatformAccounts(ctx, cfg.PlatformAccounts); err != nil {
		return nil, err
	}
	h.workerAccounts = map[string]string{cfg.WorkerToken: "csdn-main"}
	for _, a := range cfg.PlatformAccounts {
		if len(a.WorkerToken) < 32 || h.workerAccounts[a.WorkerToken] != "" {
			return nil, ErrInvalid
		}
		h.workerAccounts[a.WorkerToken] = a.ID
	}
	h.userRoutes()
	h.browserSlotRoutes()
	if err = h.provisionConnections(ctx); err != nil {
		return nil, err
	}
	h.accountManagementRoutes()
	h.platformAccountRoutes()
	h.routes()
	h.remoteLoginRoutes()
	h.articleRoutes()
	h.contentRoutes()
	h.csdnPublishPresetRoutes()
	h.csdnPublishRoutes()
	if cfg.IntegrationMasterKey != "" {
		h.integrations, err = NewIntegrationService(cfg.Store, cfg.IntegrationMasterKey, cfg.IntegrationEnvironment, cfg.IntegrationServiceID, cfg.Origin)
		if err != nil {
			return nil, err
		}
		cfg.Store.integrations = h.integrations
		h.integrations.RegisterRoutes(h)
	} else {
		h.disabledIntegrationRoutes()
	}
	h.integrationRoutes()
	h.formattingRoutes()
	return h, nil
}
func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://profile-avatar.csdnimg.cn https://img.xiaohongshu.com https://*.xhscdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/internal/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	h.mux.ServeHTTP(w, r)
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}
func replyError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalid):
		fail(w, 400, "invalid_request", "请求内容不符合当前功能限制")
	case errors.Is(err, ErrConflict):
		fail(w, 409, "conflict", "请求与当前任务状态冲突，请刷新后核对")
	case errors.Is(err, ErrNotFound):
		fail(w, 404, "not_found", "未找到任务")
	default:
		fail(w, 500, "internal_error", "服务暂时无法完成请求")
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool { return decodeLimit(w, r, v, 1<<20) }
func decodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		fail(w, 400, "invalid_request", "请求需要 JSON 格式")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "invalid_request", "请求格式或大小不符合限制")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		fail(w, 400, "invalid_request", "请求只允许一个 JSON 对象")
		return false
	}
	return true
}
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
func (h *handler) session(r *http.Request) (session, error) {
	cookie, err := r.Cookie("post_bridge_session")
	if err != nil || len(cookie.Value) != 64 {
		return session{}, ErrNotFound
	}
	var s session
	err = h.store.pool.QueryRow(r.Context(), "SELECT u.id,u.username,u.role,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.enabled AND s.auth_version=u.auth_version", hashToken(cookie.Value), h.store.now()).Scan(&s.UserID, &s.Username, &s.Role, &s.CSRF)
	return s, err
}
func (h *handler) authenticated(next func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, err := h.session(r)
		if err != nil {
			fail(w, 401, "unauthorized", "请先登录管理后台")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			csrf := r.Header.Get("X-CSRF-Token")
			if r.Header.Get("Origin") != h.origin || csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(s.CSRF)) != 1 {
				fail(w, 403, "csrf_failed", "请求验证失败，请刷新页面")
				return
			}
		}
		ctx, err := h.userContext(r, s)
		if err != nil {
			replyError(w, err)
			return
		}
		next(w, r.WithContext(ctx), s)
	}
}

type workerAccountKey struct{}

func (h *handler) worker(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID := ""
		for token, id := range h.workerAccounts {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) == 1 {
				accountID = id
			}
		}
		var owner string
		var version int64
		if accountID == "" {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			_ = h.store.pool.QueryRow(r.Context(), "SELECT a.id,a.owner_user_id,a.connection_version FROM account_connections c JOIN account a ON a.id=c.account_id JOIN users u ON u.id=a.owner_user_id WHERE c.worker_token_hash=$1 AND c.enabled AND a.enabled AND u.enabled AND c.version=a.connection_version", hashToken(token)).Scan(&accountID, &owner, &version)
		} else {
			if err := h.store.pool.QueryRow(r.Context(), "SELECT a.owner_user_id,a.connection_version FROM account a JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1 AND a.enabled AND u.enabled AND a.connection_version=1", accountID).Scan(&owner, &version); err != nil {
				accountID = ""
			}
		}
		if accountID == "" {
			fail(w, 401, "unauthorized", "需要执行器身份")
			return
		}
		r = r.WithContext(scoped(r.Context(), tenantScope{UserID: owner, AccountID: accountID, CallerID: "worker:" + accountID, ConnectionVersion: version}))
		if id := r.PathValue("id"); id != "" {
			job, err := h.store.Get(r.Context(), id)
			if err != nil {
				replyError(w, err)
				return
			}
			if job.AccountID != accountID {
				fail(w, 403, "forbidden", "执行器不能访问其他账号任务")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), workerAccountKey{}, accountID)))
	}
}
func (h *handler) limited(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.store.now()
	for key, b := range h.attempts {
		if now.After(b.Until) {
			delete(h.attempts, key)
		}
	}
	b := h.attempts[ip]
	if b.Until.IsZero() {
		b.Until = now.Add(15 * time.Minute)
	}
	if b.Count >= 10 || len(h.attempts) >= 10000 && b.Count == 0 {
		return true
	}
	b.Count++
	h.attempts[ip] = b
	return false
}
func (h *handler) login(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != h.origin {
		fail(w, 403, "csrf_failed", "请求来源验证失败")
		return
	}
	if h.limited(r) {
		w.Header().Set("Retry-After", "900")
		fail(w, 429, "rate_limited", "尝试次数过多，请稍后重试")
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	var u User
	var passwordHash string
	err := h.store.pool.QueryRow(r.Context(), "SELECT id,username,role,password_hash FROM users WHERE username=$1 AND enabled", in.Username).Scan(&u.ID, &u.Username, &u.Role, &passwordHash)
	candidate := h.hash
	if err == nil {
		candidate = []byte(passwordHash)
	}
	matched := bcrypt.CompareHashAndPassword(candidate, []byte(in.Password)) == nil
	if err != nil || !matched {
		fail(w, 401, "unauthorized", "账号或密码错误")
		return
	}
	token := randomToken()
	csrf := randomToken()
	expires := h.store.now().Add(12 * time.Hour)
	if _, err := h.store.pool.Exec(r.Context(), "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,$2,$3,$4)", hashToken(token), u.Username, csrf, expires); err != nil {
		replyError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "post_bridge_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.secure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   43200,
		Expires:  expires,
	})
	writeJSON(w, 200, map[string]any{"user": map[string]string{"id": u.ID, "username": u.Username, "role": u.Role}, "csrf_token": csrf})
}
func (h *handler) routes() {
	h.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if h.store.Ready(r.Context()) != nil {
			fail(w, 503, "unavailable", "服务尚未就绪")
			return
		}
		writeJSON(w, 200, map[string]bool{"ready": true})
	})
	h.mux.HandleFunc("POST /api/login", h.login)
	h.mux.HandleFunc("GET /api/session", h.authenticated(func(w http.ResponseWriter, r *http.Request, s session) {
		writeJSON(w, 200, map[string]any{"user": map[string]string{"id": s.UserID, "username": s.Username, "role": s.Role}, "csrf_token": s.CSRF})
	}))
	h.mux.HandleFunc("POST /api/logout", h.authenticated(func(w http.ResponseWriter, r *http.Request, s session) {
		cookie, _ := r.Cookie("post_bridge_session")
		if _, err := h.store.pool.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", hashToken(cookie.Value)); err != nil {
			replyError(w, err)
			return
		}
		h.closeRemoteLogin(r.Context(), s.CSRF)
		http.SetCookie(w, &http.Cookie{
			Name:     "post_bridge_session",
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			Secure:   h.secure,
			SameSite: http.SameSiteStrictMode,
			MaxAge:   -1,
		})
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("GET /api/account", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		a, err := h.store.Account(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, a)
	}))
	h.mux.HandleFunc("GET /api/overview", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		counts, err := h.store.Counts(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		account, err := h.store.Account(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		seen, err := h.store.LastSeen(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"counts": counts, "worker_last_seen_at": seen, "account": account})
	}))
	h.mux.HandleFunc("GET /api/settings", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		seen, err := h.store.LastSeen(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{
			"draft_only": true,
			"platform":   "csdn",
			"limits": map[string]int{
				"title_min":              5,
				"title_max":              100,
				"markdown_max":           200000,
				"request_bytes":          1 << 20,
				"max_retries":            3,
				"lease_seconds":          60,
				"logs_retention_days":    30,
				"content_retention_days": 30,
				"audit_retention_days":   90,
			},
			"poll_interval_ms":    5000,
			"worker_last_seen_at": seen,
		})
	}))
	h.mux.HandleFunc("POST /api/account/check", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		h.create(w, r, CreateInput{RequestID: in.RequestID, Kind: "check_account", Platform: "csdn"})
	}))
	h.mux.HandleFunc("POST /api/jobs", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in CreateInput
		if !decode(w, r, &in) {
			return
		}
		if err := ValidateCreate(in); err != nil {
			replyError(w, err)
			return
		}
		h.create(w, r, in)
	}))
	h.mux.HandleFunc("GET /api/jobs", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		q, status := r.URL.Query().Get("q"), r.URL.Query().Get("status")
		if len(q) > 200 || status != "" && !validStatus(status) {
			replyError(w, ErrInvalid)
			return
		}
		jobs, total, err := h.store.Jobs(r.Context(), q, status, page, size)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": jobs, "total": total, "page": page, "page_size": size})
	}))
	h.mux.HandleFunc("GET /api/jobs/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		job, err := h.store.Get(r.Context(), r.PathValue("id"))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, job)
	}))
	for _, action := range []string{"cancel", "retry", "resume", "reconcile", "resolve"} {
		h.mux.HandleFunc("POST /api/jobs/{id}/"+action, h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
			var in ActionInput
			if action == "reconcile" || action == "resolve" {
				if !decode(w, r, &in) {
					return
				}
			} else if r.ContentLength > 0 {
				if !decode(w, r, &struct{}{}) {
					return
				}
			}
			if action != "reconcile" && in.RemoteID != "" || action != "resolve" && (in.Note != "" || in.ConfirmedBrowserStopped) {
				replyError(w, ErrInvalid)
				return
			}
			if action == "resume" || action == "retry" {
				existing, err := h.store.Get(r.Context(), r.PathValue("id"))
				if err != nil {
					replyError(w, err)
					return
				}
				if h.store.executableAccount(r.Context(), existing.AccountID) != nil {
					fail(w, http.StatusConflict, "account_disabled", "账号未配置，请先恢复私有账号配置")
					return
				}
			}
			job, err := h.store.Action(r.Context(), r.PathValue("id"), action, in)
			if err != nil {
				replyError(w, err)
				return
			}
			writeJSON(w, 200, job)
		}))
	}
	h.mux.HandleFunc("GET /api/logs", h.authenticated(h.logs))
	h.processRoutes()
	h.mux.HandleFunc("POST /internal/worker/claim", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			WorkerID string `json:"worker_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		c, err := h.store.ClaimForAccount(r.Context(), in.WorkerID, r.Context().Value(workerAccountKey{}).(string))
		if err != nil {
			replyError(w, err)
			return
		}
		if c == nil {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, c)
	}))
	h.mux.HandleFunc("POST /internal/worker/heartbeat", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			WorkerID         string `json:"worker_id"`
			BrowserIdle      *bool  `json:"browser_idle"`
			ProfileAvailable *bool  `json:"profile_available"`
		}
		if !decode(w, r, &in) {
			return
		}
		if in.BrowserIdle == nil || in.ProfileAvailable == nil {
			replyError(w, ErrInvalid)
			return
		}
		if err := h.store.WorkerHeartbeatForAccount(r.Context(), in.WorkerID, r.Context().Value(workerAccountKey{}).(string), *in.BrowserIdle, *in.ProfileAvailable); err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("POST /internal/worker/jobs/{id}/heartbeat", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			LeaseToken string `json:"lease_token"`
		}
		if !decode(w, r, &in) {
			return
		}
		cancel, err := h.store.Heartbeat(r.Context(), r.PathValue("id"), in.LeaseToken)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"cancel_requested": cancel})
	}))
	h.mux.HandleFunc("POST /internal/worker/jobs/{id}/progress", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in ProgressInput
		if !decode(w, r, &in) {
			return
		}
		if err := h.store.Progress(r.Context(), r.PathValue("id"), in); err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("POST /internal/worker/jobs/{id}/complete", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in CompleteInput
		if !decodeLimit(w, r, &in, 8<<20) {
			return
		}
		if err := h.store.Complete(r.Context(), r.PathValue("id"), in); err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "接口不存在") })
	h.mux.HandleFunc("/internal/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "接口不存在") })
	h.mux.HandleFunc("/", h.static)
}
func validStatus(s string) bool {
	switch s {
	case "queued", "running", "waiting_user", "reconciling", "succeeded", "failed", "cancelled":
		return true
	}
	return false
}
func (h *handler) create(w http.ResponseWriter, r *http.Request, in CreateInput) {
	job, created, err := h.store.Create(r.Context(), in)
	if err != nil {
		replyError(w, err)
		return
	}
	status := 200
	if created {
		status = 202
	}
	writeJSON(w, status, job)
}
func pagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	page, size := 1, 50
	var err error
	if raw := r.URL.Query().Get("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return 0, 0, false
		}
	}
	if raw := r.URL.Query().Get("page_size"); raw != "" {
		size, err = strconv.Atoi(raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return 0, 0, false
		}
	}
	if page < 1 || page > 1000000 || size < 1 || size > 100 {
		replyError(w, ErrInvalid)
		return 0, 0, false
	}
	return page, size, true
}
func (h *handler) logs(w http.ResponseWriter, r *http.Request, _ session) {
	page, size, ok := pagination(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	to := h.store.now()
	from := to.Add(-24 * time.Hour)
	var err error
	if raw := q.Get("to"); raw != "" {
		to, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return
		}
		from = to.Add(-24 * time.Hour)
	}
	if raw := q.Get("from"); raw != "" {
		from, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return
		}
	}
	level := q.Get("level")
	if to.Before(from) || to.Sub(from) > 31*24*time.Hour || len(q.Get("q")) > 200 || level != "" && level != "info" && level != "warning" && level != "error" {
		replyError(w, ErrInvalid)
		return
	}
	items, total, err := h.store.Logs(r.Context(), q.Get("job_id"), level, q.Get("q"), from, to, page, size)
	if err != nil {
		replyError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": size})
}
func (h *handler) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		fail(w, 405, "method_not_allowed", "不支持此请求方法")
		return
	}
	if h.dist == "" {
		fail(w, 404, "not_found", "管理界面尚未构建")
		return
	}
	path := filepath.Join(h.dist, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
	rel, err := filepath.Rel(h.dist, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		fail(w, 404, "not_found", "文件不存在")
		return
	}
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
		http.ServeFile(w, r, path)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		fail(w, 404, "not_found", "文件不存在")
		return
	}
	http.ServeFile(w, r, filepath.Join(h.dist, "index.html"))
}
