package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("需要显式 TEST_DATABASE_URL，隔离 schema")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	schema := "test_" + randomToken()[:16]
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(ctx, pool, "tester", "测试账号")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return store
}
func createTest(t *testing.T, s *Store, key string) Job {
	t.Helper()
	j, _, err := s.Create(context.Background(), CreateInput{
		RequestID: key,
		Platform:  "csdn",
		Kind:      "save_draft",
		Title:     "测试文章标题",
		Markdown:  "# body\n\n内容",
	})
	if err != nil {
		t.Fatal(err)
	}
	return j
}
func TestPostgresIdempotencyAndConcurrentClaimFencing(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "same")
	got, created, err := s.Create(ctx, CreateInput{
		RequestID: "same",
		Platform:  "csdn",
		Kind:      "save_draft",
		Title:     "测试文章标题",
		Markdown:  "# body\n\n内容",
	})
	if err != nil || created || got.ID != j.ID {
		t.Fatalf("idempotency failed: %v", err)
	}
	if _, _, err = s.Create(ctx, CreateInput{
		RequestID: "same",
		Platform:  "csdn",
		Kind:      "save_draft",
		Title:     "不同文章标题",
		Markdown:  "changed",
	}); err != ErrConflict {
		t.Fatalf("wanted conflict got %v", err)
	}
	var wg sync.WaitGroup
	mu := sync.Mutex{}
	claims := []*Claim{}
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c, e := s.Claim(ctx, fmt.Sprintf("w%d", n))
			if e != nil {
				t.Error(e)
			}
			if c != nil {
				mu.Lock()
				claims = append(claims, c)
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if len(claims) != 1 {
		t.Fatalf("duplicate claims %d", len(claims))
	}
	c := claims[0]
	if _, err = s.Heartbeat(ctx, j.ID, "wrong"); err != ErrConflict {
		t.Fatal("wrong lease accepted")
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Now().UTC().Add(61 * time.Second) }
	if _, err = s.Heartbeat(ctx, j.ID, c.LeaseToken); err != ErrConflict {
		t.Fatal("expired lease renewed")
	}
	if next, err := s.Claim(ctx, "new"); err != nil || next != nil {
		t.Fatal("unknown operation reclaimed automatically", err)
	}
	got, err = s.Get(ctx, j.ID)
	if err != nil || got.Status != "reconciling" || got.Outcome != "unknown" {
		t.Fatalf("recovery failed %+v %v", got, err)
	}
	createTest(t, s, "second")
	if next, err := s.Claim(ctx, "other"); err != nil || next != nil {
		t.Fatal("unknown result did not block account", err)
	}
}
func TestPostgresResolveRequiresOwningWorkersFreshProof(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "resolve")
	c, err := s.Claim(ctx, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling"}); err != nil {
		t.Fatal(err)
	}
	in := ActionInput{ConfirmedBrowserStopped: true, Note: "保留草稿"}
	s.WorkerHeartbeat(ctx, "other", true, true)
	if _, err = s.Action(ctx, j.ID, "resolve", in); err != ErrConflict {
		t.Fatal("different worker proof resolved")
	}
	s.WorkerHeartbeat(ctx, "owner", true, true)
	if _, err = s.Action(ctx, j.ID, "resolve", in); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(ctx, j.ID)
	if !got.ManualResolved || got.RetryAllowed {
		t.Fatal("invalid resolution")
	}
	if _, err = s.Action(ctx, j.ID, "retry", ActionInput{}); err != ErrConflict {
		t.Fatal("manual resolved task retried")
	}
}
func TestHTTPAuthCSRFAndInputBoundaries(t *testing.T) {
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
	request := func(method, path, body string, cookie *http.Cookie, csrf, origin, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if csrf != "" {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, p := range []string{"/api/jobs", "/api/logs", "/api/settings", "/api/account", "/api/overview"} {
		if w := request("GET", p, "", nil, "", "", ""); w.Code != 401 {
			t.Fatalf("%s: %d", p, w.Code)
		}
	}
	if w := request("POST", "/api/login", `{"username":"admin","password":"private-test-password"}`, nil, "", "http://evil", ""); w.Code != 403 {
		t.Fatal("cross origin login accepted")
	}
	w := request("POST", "/api/login", `{"username":"admin","password":"private-test-password"}`, nil, "", "http://localhost", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var data struct {
		CSRF string `json:"csrf_token"`
	}
	json.Unmarshal(w.Body.Bytes(), &data)
	cookies := w.Result().Cookies()
	if len(cookies) == 0 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	cookie := cookies[0]
	for _, tc := range []struct{ csrf, origin string }{{"", "http://localhost"}, {data.CSRF, "http://evil"}} {
		if w := request("POST", "/api/jobs", "{}", cookie, tc.csrf, tc.origin, ""); w.Code != 403 {
			t.Fatal("CSRF bypass")
		}
	}
	if w := request("POST", "/internal/worker/claim", `{"worker_id":"test"}`, cookie, data.CSRF, "http://localhost", ""); w.Code != 401 {
		t.Fatal("admin called worker endpoint")
	}
	if w := request("GET", "/api/jobs", "", nil, "", "", "private-test-worker-token-32-characters"); w.Code != 401 {
		t.Fatal("worker called admin")
	}
	for _, body := range []string{`{"request_id":"a","kind":"publish","platform":"csdn","title":"valid title","markdown":"body"}`, `{"request_id":"a","kind":"save_draft","platform":"zhihu","title":"valid title","markdown":"body"}`, `{"request_id":"a","kind":"save_draft","platform":"csdn","title":"valid title","markdown":"<script>bad</script>"}`, `{"request_id":"a","kind":"save_draft","platform":"csdn","title":"valid title","markdown":"body","account_id":"foreign"}`} {
		if w := request("POST", "/api/jobs", body, cookie, data.CSRF, "http://localhost", ""); w.Code != 400 {
			t.Fatal("invalid input accepted", w.Code, w.Body.String())
		}
	}
	body := `{"request_id":"a","kind":"save_draft","platform":"csdn","title":"valid title","markdown":"body"}`
	if w := request("POST", "/api/jobs", body, cookie, data.CSRF, "http://localhost", ""); w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request("GET", "/api/jobs", "", cookie, "", "", ""); w.Code != 200 || strings.Contains(w.Body.String(), "\"markdown\"") {
		t.Fatal("list leaked body")
	}
	if w := request("POST", "/api/logout", "{}", cookie, data.CSRF, "http://localhost", ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request("GET", "/api/session", "", cookie, "", "", ""); w.Code != 401 {
		t.Fatal("revoked cookie accepted")
	}
}
