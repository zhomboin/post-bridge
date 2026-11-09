package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestRemoteLoginDisabledRequiresAdministrator(t *testing.T) {
	s := testStore(t)
	h, err := NewHandler(context.Background(), Config{
		Store:         s,
		AdminUsername: "admin",
		AdminPassword: "private-test-password",
		WorkerToken:   "private-test-worker-token-32-characters",
		Origin:        "http://localhost",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/api/account/login", nil)
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, request)
	if recorder.Code != 401 {
		t.Fatalf("remote login must require administrator, got %d", recorder.Code)
	}
}

func TestRuntimePublicOriginOverridesInternalAPI(t *testing.T) {
	dir := t.TempDir()
	password := filepath.Join(dir, "password")
	token := filepath.Join(dir, "token")
	if err := os.WriteFile(password, []byte("long-test-admin-password"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(token, []byte("worker-secret-at-least-thirty-two-chars"), 0600); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"DATABASE_URL":        "postgres://project/db",
		"ADMIN_USERNAME":      "admin",
		"ADMIN_PASSWORD_FILE": password,
		"WORKER_TOKEN_FILE":   token,
		"CSDN_USERNAME":       "tester",
		"CSDN_DISPLAY_NAME":   "tester",
		"API_ADDR":            "127.0.0.1:18080",
		"API_BASE_URL":        "http://127.0.0.1:18080",
		"PUBLIC_ORIGIN":       "https://post.example.com",
		"REMOTE_LOGIN_URL":    "",
	} {
		t.Setenv(key, value)
	}
	cfg, err := LoadRuntimeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Origin != "https://post.example.com" {
		t.Fatalf("public origin ignored: %s", cfg.Origin)
	}
}

type remoteCredential struct {
	cookie *http.Cookie
	csrf   string
}
type remoteFixture struct {
	mu                sync.Mutex
	state, id         string
	calls             []string
	credentialsLeaked bool
	image             []byte
}

func newRemoteFixture(t *testing.T) (*remoteFixture, *httptest.Server) {
	t.Helper()
	var picture bytes.Buffer
	if err := jpeg.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 1280, 800)), nil); err != nil {
		t.Fatal(err)
	}
	f := &remoteFixture{state: "idle", id: strings.Repeat("a", 64), image: picture.Bytes()}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer private-test-worker-token-32-characters" || r.Header.Get("Cookie") != "" || r.Header.Get("X-CSRF-Token") != "" || r.Header.Get("Origin") != "" {
			f.credentialsLeaked = true
		}
		if strings.HasSuffix(r.URL.Path, "/frame") {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write(f.image)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/login" {
			if data, _ := io.ReadAll(r.Body); len(data) != 0 {
				w.WriteHeader(400)
				return
			}
			f.state = "active"
			w.WriteHeader(202)
		}
		if r.Method == "DELETE" {
			f.state = "cancelled"
		}
		id, expiry := f.id, time.Now().Add(9*time.Minute).UTC().Format(time.RFC3339)
		if f.state == "idle" {
			id = ""
			expiry = ""
		}
		json.NewEncoder(w).Encode(map[string]any{"id": id, "status": f.state, "expires_at": expiry, "width": 1280, "height": 800})
	}))
	t.Cleanup(upstream.Close)
	return f, upstream
}
func remoteHandler(t *testing.T, url string) (http.Handler, *Store) {
	t.Helper()
	s := testStore(t)
	h, err := NewHandler(context.Background(), Config{
		Store:          s,
		AdminUsername:  "admin",
		AdminPassword:  "private-test-password",
		WorkerToken:    "private-test-worker-token-32-characters",
		Origin:         "http://localhost",
		RemoteLoginURL: url,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h, s
}
func remoteSession(t *testing.T, s *Store) remoteCredential {
	t.Helper()
	token, csrf := randomToken(), randomToken()
	if _, err := s.pool.Exec(context.Background(), "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin',$2,$3)", hashToken(token), csrf, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return remoteCredential{cookie: &http.Cookie{Name: "post_bridge_session", Value: token}, csrf: csrf}
}
func remoteRequest(h http.Handler, method, path, body string, c remoteCredential) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost")
	req.Header.Set("X-CSRF-Token", c.csrf)
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}
func TestRemoteLoginSessionIsolationAndLogout(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner, other := remoteSession(t, s), remoteSession(t, s)
	w := remoteRequest(h, "POST", "/api/account/login", "{}", remoteCredential{cookie: owner.cookie})
	if w.Code != 403 {
		t.Fatalf("missing CSRF: %d", w.Code)
	}
	w = remoteRequest(h, "POST", "/api/account/login", "{}", owner)
	if w.Code != 202 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("state cached")
	}
	w = remoteRequest(h, "GET", "/api/account/login", "", other)
	if w.Code != 200 || strings.Contains(w.Body.String(), f.id) || !strings.Contains(w.Body.String(), "busy") {
		t.Fatalf("other session saw login: %d %s", w.Code, w.Body.String())
	}
	for _, action := range []struct{ method, path, body string }{{"GET", "/frame", ""}, {"POST", "/input", `{"type":"key","key":"Enter"}`}, {"DELETE", "", ""}} {
		w = remoteRequest(h, action.method, "/api/account/login/"+f.id+action.path, action.body, other)
		if w.Code != 404 {
			t.Fatalf("cross-session %s: %d", action.path, w.Code)
		}
	}
	w = remoteRequest(h, "GET", "/api/account/login/"+f.id+"/frame", "", owner)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" || !bytes.Equal(w.Body.Bytes(), f.image) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("frame: %d", w.Code)
	}
	w = remoteRequest(h, "POST", "/api/logout", "{}", owner)
	if w.Code != 200 {
		t.Fatalf("logout: %d", w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != "cancelled" || f.credentialsLeaked {
		t.Fatal("logout did not close browser or credential boundary failed")
	}
}
func TestRemoteLoginRejectsMalformedInputBeforeForwarding(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	invalid := []string{`null`, `{}`, `{"type":"navigate","url":"https://evil.example"}`, `{"type":"click","x":1280,"y":0}`, `{"type":"click","x":-0.1,"y":0}`, `{"type":"click","x":0}`, `{"type":"text","text":""}`, `{"type":"text","text":"secret\n"}`, `{"type":"text","text":"` + strings.Repeat("a", 2001) + `"}`, `{"type":"key","key":"Control+L"}`, `{"type":"key","key":"Enter","text":"secret"}`, `{"type":"drag","points":[{"x":0,"y":0}]}`, `{"type":"drag","points":[{"x":0},{"x":0,"y":0}]}`, `{"type":"scroll","deltaY":0}`, `{"type":"scroll","deltaY":1601}`, `{"type":"click","x":1e999,"y":0}`, `{"type":"text","text":"` + strings.Repeat("a", 17000) + `"}`}
	f.mu.Lock()
	before := len(f.calls)
	f.mu.Unlock()
	for _, body := range invalid {
		if w := remoteRequest(h, "POST", "/api/account/login/"+f.id+"/input", body, owner); w.Code != 400 {
			t.Fatalf("invalid input status %d", w.Code)
		}
	}
	f.mu.Lock()
	after := len(f.calls)
	f.mu.Unlock()
	if after != before {
		t.Fatal("invalid input reached worker")
	}
	valid := []string{`{"type":"fill","field":"phone","text":"13800000000"}`, `{"type":"fill","field":"code","text":"654321"}`, `{"type":"click","x":1279.9,"y":799.9}`, `{"type":"text","text":"test-password"}`, `{"type":"key","key":"Shift+Tab"}`, `{"type":"drag","points":[{"x":0,"y":0},{"x":10.5,"y":10}]}`, `{"type":"scroll","deltaY":-1600}`}
	for _, body := range valid {
		if w := remoteRequest(h, "POST", "/api/account/login/"+f.id+"/input", body, owner); w.Code != 200 {
			t.Fatalf("valid input status %d", w.Code)
		}
	}
	for _, id := range []string{"bad.id", strings.Repeat("b", 129), "wrong-id"} {
		if w := remoteRequest(h, "GET", "/api/account/login/"+id+"/frame", "", owner); w.Code != 404 {
			t.Fatalf("invalid id status %d", w.Code)
		}
	}
}
func TestRemoteLoginUnavailableResponsesNeverLeak(t *testing.T) {
	for _, mode := range []string{"disabled", "unauthorized", "redirect", "large", "invalid-state"} {
		t.Run(mode, func(t *testing.T) {
			var escaped atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { escaped.Add(1) }))
			defer target.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "unauthorized":
					w.WriteHeader(401)
					w.Write([]byte("private-worker-secret"))
				case "redirect":
					http.Redirect(w, r, target.URL, 302)
				case "large":
					w.Write([]byte(strings.Repeat("private", 20000)))
				default:
					w.Write([]byte(`{"status":"active","id":"../../bad","error":"private-password"}`))
				}
			}))
			defer upstream.Close()
			endpoint := upstream.URL
			if mode == "disabled" {
				endpoint = ""
			}
			h, s := remoteHandler(t, endpoint)
			owner := remoteSession(t, s)
			w := remoteRequest(h, "GET", "/api/account/login", "", owner)
			wanted := 502
			if mode == "disabled" {
				wanted = 503
			}
			if w.Code != wanted || strings.Contains(w.Body.String(), "private") || escaped.Load() != 0 {
				t.Fatalf("unsafe upstream handling: %d %s redirects %d", w.Code, w.Body.String(), escaped.Load())
			}
		})
	}
}
func TestRemoteLoginRefusesOrphanAndExpiredAdministrator(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	f.state = "active"
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	w := remoteRequest(h, "POST", "/api/account/login", "{}", owner)
	if w.Code != 409 || strings.Contains(w.Body.String(), f.id) {
		t.Fatalf("orphan adopted: %d %s", w.Code, w.Body.String())
	}
	f.mu.Lock()
	f.state = "idle"
	f.mu.Unlock()
	if w = remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	if _, err := s.pool.Exec(context.Background(), "UPDATE sessions SET expires_at=$1 WHERE csrf_token=$2", time.Now().Add(-time.Second), owner.csrf); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	before := len(f.calls)
	f.mu.Unlock()
	if w = remoteRequest(h, "GET", "/api/account/login/"+f.id+"/frame", "", owner); w.Code != 401 {
		t.Fatal("expired administrator viewed frame", w.Code)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) != before {
		t.Fatal("expired session refreshed browser")
	}
}
func TestRemoteLoginConfigurationRejectsNonLoopback(t *testing.T) {
	s := testStore(t)
	for _, endpoint := range []string{"https://127.0.0.1:8081", "http://localhost:8081", "http://127.1:8081", "http://[::1]:8081", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://name:password@127.0.0.1:8081", "http://127.0.0.1:8081/", "http://127.0.0.1:8081/login", "http://127.0.0.1:8081?x=1", "http://127.0.0.1:8081#x"} {
		if _, err := NewHandler(context.Background(), Config{
			Store:          s,
			AdminUsername:  "admin",
			AdminPassword:  "private-test-password",
			WorkerToken:    "private-test-worker-token-32-characters",
			Origin:         "http://localhost",
			RemoteLoginURL: endpoint,
		}); err == nil {
			t.Fatalf("unsafe remote URL accepted: %s", endpoint)
		}
	}
}
func TestRemoteLoginSuccessResumesOnlyEligibleJobsOnce(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	ctx := context.Background()
	original := map[string]*record{}
	for _, kind := range []string{"execute", "reconcile", "cancelled", "other-error", "other-account"} {
		j := createTest(t, s, "remote-login-"+kind)
		err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
			r, err := load(ctx, tx, j.ID)
			if err != nil {
				return err
			}
			r.Status = "waiting_user"
			r.ErrorCode = "needs_login"
			r.Attempts = 2
			r.RetryCount = 2
			r.ReconcileCount = 3
			r.Ready = false
			switch kind {
			case "reconcile":
				r.ExternalStarted = true
				r.Outcome = "unknown"
				r.RunMode = "reconcile"
			case "cancelled":
				r.CancelRequested = true
			case "other-error":
				r.ErrorCode = "browser_busy"
			case "other-account":
				r.AccountID = "unrelated"
			}
			copy := *r
			original[kind] = &copy
			return save(ctx, tx, r)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	f.state = "succeeded"
	f.mu.Unlock()
	for i := 0; i < 2; i++ {
		if w := remoteRequest(h, "GET", "/api/account/login", "", owner); w.Code != 200 {
			t.Fatalf("success: %d %s", w.Code, w.Body.String())
		}
	}
	account, err := s.Account(ctx)
	if err != nil || account.Status != "connected" {
		t.Fatal("account not connected", err)
	}
	for kind, before := range original {
		got, err := s.Get(ctx, before.ID)
		if err != nil {
			t.Fatal(err)
		}
		want := "waiting_user"
		if kind == "execute" {
			want = "queued"
		}
		if kind == "reconcile" {
			want = "reconciling"
		}
		if got.Status != want || got.Attempts != before.Attempts || got.RetryCount != before.RetryCount || got.ReconcileCount != before.ReconcileCount || got.CancelRequested != before.CancelRequested || got.RunMode != before.RunMode {
			t.Fatalf("unsafe resume %s: %+v", kind, got)
		}
		var count int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM logs WHERE job_id=$1", before.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		expected := 1
		if kind == "execute" || kind == "reconcile" {
			expected = 2
		}
		if count != expected {
			t.Fatalf("duplicate resume side effects %s: %d", kind, count)
		}
	}
}

func TestRemoteLoginMaintenanceClosesExpiredOwner(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	if _, err := s.pool.Exec(context.Background(), "DELETE FROM sessions WHERE csrf_token=$1", owner.csrf); err != nil {
		t.Fatal(err)
	}
	if err := h.(*handler).maintainRemoteLogin(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != "cancelled" || h.(*handler).remoteLoginProxy.current != nil {
		t.Fatal("expired owner retained remote browser")
	}
}
func TestRemoteLoginShutdownClosesOnlyOwnedBrowser(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner, other := remoteSession(t, s), remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	if w := remoteRequest(h, "POST", "/api/logout", "{}", other); w.Code != 200 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	state := f.state
	f.mu.Unlock()
	if state != "active" {
		t.Fatal("another logout closed owned browser")
	}
	h.(*handler).closeRemoteLogin(context.Background(), "")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != "cancelled" {
		t.Fatal("shutdown left browser active")
	}
}
func TestRemoteLoginUpstreamTimeoutAndFrameBoundaries(t *testing.T) {
	for _, mode := range []string{"timeout", "oversized-frame", "wrong-frame-type"} {
		t.Run(mode, func(t *testing.T) {
			f, good := newRemoteFixture(t)
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "timeout" {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				if strings.HasSuffix(r.URL.Path, "/frame") {
					w.Header().Set("Content-Type", "image/jpeg")
					if mode == "wrong-frame-type" {
						w.Header().Set("Content-Type", "text/html")
						w.Write([]byte("private-password"))
						return
					}
					w.Write(make([]byte, 2<<20+1))
					return
				}
				good.Config.Handler.ServeHTTP(w, r)
			}))
			defer endpoint.Close()
			h, s := remoteHandler(t, endpoint.URL)
			owner := remoteSession(t, s)
			h.(*handler).remoteLoginProxy.client.Timeout = 100 * time.Millisecond
			path := "/api/account/login"
			if mode != "timeout" {
				if w := remoteRequest(h, "POST", path, "{}", owner); w.Code != 202 {
					t.Fatal(w.Code)
				}
				path += "/" + f.id + "/frame"
			}
			started := time.Now()
			w := remoteRequest(h, "GET", path, "", owner)
			if w.Code != 502 || strings.Contains(w.Body.String(), "private") || time.Since(started) > time.Second {
				t.Fatalf("unsafe/unbounded response: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
func TestRemoteLoginConfirmedStateCannotResetNewFailure(t *testing.T) {
	f, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	ctx := context.Background()
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	f.mu.Lock()
	f.state = "succeeded"
	f.mu.Unlock()
	if w := remoteRequest(h, "GET", "/api/account/login", "", owner); w.Code != 200 {
		t.Fatal(w.Code)
	}
	j := createTest(t, s, "login-after-confirmed")
	if err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		r, err := load(ctx, tx, j.ID)
		if err != nil {
			return err
		}
		r.Status = "waiting_user"
		r.ErrorCode = "needs_login"
		r.Ready = false
		if err = save(ctx, tx, r); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "UPDATE account SET status='needs_login' WHERE id='csdn-main'")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if w := remoteRequest(h, "GET", "/api/account/login", "", owner); w.Code != 200 {
		t.Fatal(w.Code)
	}
	account, err := s.Account(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if account.Status != "needs_login" || got.Status != "waiting_user" {
		t.Fatal("stale succeeded state restored a new login failure")
	}
}

func TestRemoteLoginMaintenanceDoesNotWaitForSlowFrame(t *testing.T) {
	f, good := newRemoteFixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/frame") {
			close(started)
			<-release
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write(f.image)
			return
		}
		good.Config.Handler.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	defer once.Do(func() { close(release) })
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	frame := make(chan int, 1)
	go func() { frame <- remoteRequest(h, "GET", "/api/account/login/"+f.id+"/frame", "", owner).Code }()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	maintained := make(chan error, 1)
	go func() { maintained <- h.(*handler).maintainRemoteLogin(ctx) }()
	select {
	case err := <-maintained:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(100 * time.Millisecond):
		once.Do(func() { close(release) })
		<-frame
		err := <-maintained
		t.Fatalf("remote maintenance blocked on frame and exhausted database deadline: %v", err)
	}
	once.Do(func() { close(release) })
	if status := <-frame; status != 200 {
		t.Fatal(status)
	}
}
func TestRemoteLoginFailedRevocationIsRetried(t *testing.T) {
	for _, reason := range []string{"logout", "expired", "delete"} {
		t.Run(reason, func(t *testing.T) {
			f, good := newRemoteFixture(t)
			var attempts atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "DELETE" && attempts.Add(1) == 1 {
					w.WriteHeader(503)
					return
				}
				good.Config.Handler.ServeHTTP(w, r)
			}))
			defer upstream.Close()
			h, s := remoteHandler(t, upstream.URL)
			owner, other := remoteSession(t, s), remoteSession(t, s)
			if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
				t.Fatal(w.Code)
			}
			f.mu.Lock()
			f.state = "pending"
			f.mu.Unlock()
			switch reason {
			case "logout":
				if w := remoteRequest(h, "POST", "/api/logout", "{}", owner); w.Code != 200 {
					t.Fatal(w.Code)
				}
			case "expired":
				if _, err := s.pool.Exec(context.Background(), "DELETE FROM sessions WHERE csrf_token=$1", owner.csrf); err != nil {
					t.Fatal(err)
				}
				if err := h.(*handler).maintainRemoteLogin(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "delete":
				if w := remoteRequest(h, "DELETE", "/api/account/login/"+f.id, "", owner); w.Code != 502 {
					t.Fatal(w.Code)
				}
				if w := remoteRequest(h, "GET", "/api/account/login/"+f.id+"/frame", "", owner); w.Code != 404 && w.Code != 409 {
					t.Fatalf("revoking session still delivered frame: %d", w.Code)
				}
			}
			if h.(*handler).remoteLoginProxy.current == nil {
				t.Fatal("failed DELETE discarded the only revocation target")
			}
			if w := remoteRequest(h, "POST", "/api/account/login", "{}", other); w.Code != 409 {
				t.Fatal("revocation allowed a new login", w.Code)
			}
			if err := h.(*handler).maintainRemoteLogin(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if attempts.Load() != 2 || f.state != "cancelled" || h.(*handler).remoteLoginProxy.current != nil {
				t.Fatal("revocation was not retried and confirmed")
			}
		})
	}
}
func TestRemoteLoginShutdownLockWaitIsBounded(t *testing.T) {
	_, upstream := newRemoteFixture(t)
	h, s := remoteHandler(t, upstream.URL)
	owner := remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	proxy := h.(*handler).remoteLoginProxy
	proxy.mu.Lock()
	var once sync.Once
	defer once.Do(proxy.mu.Unlock)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { h.(*handler).closeRemoteLogin(ctx, ""); close(done) }()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		once.Do(proxy.mu.Unlock)
		<-done
		t.Fatal("shutdown waited without a deadline for active browser I/O")
	}
}

func TestRemoteLoginExplicitFillBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"phone lower", `{"type":"fill","field":"phone","text":"12345"}`, true},
		{"phone upper", `{"type":"fill","field":"phone","text":"12345678901234567890"}`, true},
		{"code lower", `{"type":"fill","field":"code","text":"1234"}`, true},
		{"code upper", `{"type":"fill","field":"code","text":"12345678"}`, true},
		{"phone short", `{"type":"fill","field":"phone","text":"1234"}`, false},
		{"phone long", `{"type":"fill","field":"phone","text":"123456789012345678901"}`, false},
		{"phone country prefix", `{"type":"fill","field":"phone","text":"+8613800000000"}`, false},
		{"code short", `{"type":"fill","field":"code","text":"123"}`, false},
		{"code long", `{"type":"fill","field":"code","text":"123456789"}`, false},
		{"code non digit", `{"type":"fill","field":"code","text":"123a"}`, false},
		{"unicode digit", `{"type":"fill","field":"code","text":"１２３４"}`, false},
		{"whitespace", `{"type":"fill","field":"phone","text":"12345 "}`, false},
		{"newline", `{"type":"fill","field":"phone","text":"12345\n"}`, false},
		{"empty", `{"type":"fill","field":"phone","text":""}`, false},
		{"unknown field", `{"type":"fill","field":"password","text":"123456"}`, false},
		{"missing field", `{"type":"fill","text":"123456"}`, false},
		{"null field", `{"type":"fill","field":null,"text":"123456"}`, false},
		{"null text", `{"type":"fill","field":"phone","text":null}`, false},
		{"numeric text", `{"type":"fill","field":"code","text":1234}`, false},
		{"extra known field", `{"type":"fill","field":"code","text":"1234","key":"Enter"}`, false},
		{"extra unknown field", `{"type":"fill","field":"phone","text":"12345","submit":true}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validRemoteInput([]byte(tc.body)); got != tc.valid {
				t.Fatalf("fill validation = %v, want %v", got, tc.valid)
			}
		})
	}
}

func TestRemoteLoginExplicitFillPreservesAccessAndForwarding(t *testing.T) {
	f, good := newRemoteFixture(t)
	var forwarded []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/input") {
			data, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			forwarded = append(forwarded, string(data))
			r.Body = io.NopCloser(bytes.NewReader(data))
		}
		good.Config.Handler.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	h, s := remoteHandler(t, upstream.URL)
	owner, other := remoteSession(t, s), remoteSession(t, s)
	if w := remoteRequest(h, "POST", "/api/account/login", "{}", owner); w.Code != 202 {
		t.Fatal(w.Code)
	}
	path := "/api/account/login/" + f.id + "/input"
	phone := `{"type":"fill","field":"phone","text":"13800000000"}`
	for _, tc := range []struct {
		credential remoteCredential
		status     int
	}{
		{remoteCredential{}, 401}, {remoteCredential{cookie: owner.cookie}, 403}, {other, 404},
	} {
		if w := remoteRequest(h, "POST", path, phone, tc.credential); w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("fill boundary: %d", w.Code)
		}
	}
	if w := remoteRequest(h, "POST", path, `{"type":"fill","field":"phone","text":"1234"}`, owner); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if len(forwarded) != 0 {
		t.Fatal("unauthorized or invalid fill reached worker")
	}
	for _, body := range []string{phone, `{"type":"fill","field":"code","text":"654321"}`} {
		w := remoteRequest(h, "POST", path, body, owner)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("fill response: %d", w.Code)
		}
		if forwarded[len(forwarded)-1] != body {
			t.Fatal("fill input changed in transit")
		}
		if strings.Contains(w.Body.String(), "13800000000") || strings.Contains(w.Body.String(), "654321") {
			t.Fatal("fill response exposed private input")
		}
	}
	if len(forwarded) != 2 {
		t.Fatalf("unexpected forwarded input count: %d", len(forwarded))
	}
}

func TestRemoteLoginPageLoadErrorSanitization(t *testing.T) {
	const loadError = "CSDN 登录页面未能加载，请稍后重新开始"
	for _, tc := range []struct{ name, status, upstream, expected string }{
		{"page unavailable", "failed", loadError, loadError},
		{"untrusted suffix", "failed", loadError + " Cookie=synthetic-secret", "远程登录未完成，请重新验证"},
		{"untrusted message", "failed", "https://private.invalid/?token=synthetic-secret", "远程登录未完成，请重新验证"},
		{"invalid status for message", "active", loadError, "远程登录未完成，请重新验证"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(remoteLoginState{
					ID:        "synthetic-login",
					Status:    tc.status,
					ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
					Width:     1280,
					Height:    800,
					Error:     tc.upstream,
				})
			}))
			defer upstream.Close()
			proxy, err := newRemoteLoginProxy(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.client.CloseIdleConnections()
			state, _, err := proxy.state(context.Background(), "synthetic-token", "GET", "/login", nil)
			if err != nil || state.Error != tc.expected {
				t.Fatalf("unexpected sanitized error: got %q, err %v", state.Error, err)
			}
		})
	}
}
