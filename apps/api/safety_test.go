package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPostgresManualResolveCannotRaceAnotherAccountLease(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "unresolved")
	c, _ := s.Claim(ctx, "first")
	if err := s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling"}); err != nil {
		t.Fatal(err)
	}
	if err := s.WorkerHeartbeat(ctx, "first", true, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Create(ctx, CreateInput{RequestID: "check", Kind: "check_account", Platform: "csdn"}); err != nil {
		t.Fatal(err)
	}
	if c, err := s.Claim(ctx, "second"); err != nil || c == nil || c.Job.Kind != "check_account" {
		t.Fatal("safe account check was not claimed", err)
	}
	if _, err := s.Action(ctx, j.ID, "resolve", ActionInput{ConfirmedBrowserStopped: true, Note: "保留草稿"}); err != ErrConflict {
		t.Fatal("resolved account while another browser owns a live lease", err)
	}
}
func TestPostgresReadOnlyReconcileAndSanitizedLogs(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "readonly")
	c, _ := s.Claim(ctx, "owner")
	if err := s.Progress(ctx, j.ID, ProgressInput{
		LeaseToken:      c.LeaseToken,
		Stage:           "opening_editor",
		ExternalStarted: true,
		Message:         "Cookie=secret article body",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "draft_acquired", RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, j.ID, CompleteInput{
		LeaseToken:   c.LeaseToken,
		Status:       "failed",
		Retryable:    true,
		ErrorCode:    "raw-password-secret",
		ErrorMessage: "Cookie=secret article body",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Action(ctx, j.ID, "reconcile", ActionInput{RemoteID: "999"}); err != ErrInvalid {
		t.Fatal("bound ID changed", err)
	}
	if _, err := s.Action(ctx, j.ID, "reconcile", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	c, err := s.Claim(ctx, "owner")
	if err != nil || c == nil || c.Job.RunMode != "reconcile" || c.Job.RemoteID != "123" {
		t.Fatal("not a read-only claim", err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", ExternalStarted: true}); err != ErrConflict {
		t.Fatal("reconcile allowed editor mutation")
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", RemoteID: "123"}); err != ErrConflict {
		t.Fatal("reconcile skipped verifying")
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	logs, _, err := s.Logs(ctx, j.ID, "", "", time.Now().Add(-time.Hour), time.Now().Add(time.Hour), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(logs)
	if strings.Contains(string(data), "secret") || strings.Contains(string(data), "article body") {
		t.Fatal("worker raw text leaked to logs")
	}
	got, _ := s.Get(ctx, j.ID)
	if got.Markdown != j.Markdown || got.Outcome != "draft_saved" || got.RemoteURL != "https://editor.csdn.net/md/?articleId=123" {
		t.Fatal("snapshot/result changed")
	}
}
func TestPostgresFreshProofExpiresAndResolveIsSerialized(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "fresh")
	c, _ := s.Claim(ctx, "owner")
	s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true})
	s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling"})
	s.WorkerHeartbeat(ctx, "owner", true, true)
	base := s.now()
	s.now = func() time.Time { return base.Add(46 * time.Second) }
	in := ActionInput{ConfirmedBrowserStopped: true, Note: "保留草稿"}
	if _, err := s.Action(ctx, j.ID, "resolve", in); err != ErrConflict {
		t.Fatal("expired idle proof accepted", err)
	}
	s.WorkerHeartbeat(ctx, "owner", true, true)
	if _, err := s.Action(ctx, j.ID, "resolve", in); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Action(ctx, j.ID, "resolve", in); err != ErrConflict {
		t.Fatal("duplicate resolution accepted", err)
	}
}
func TestHTTPLoginRateLimitSessionExpiryAndStaticFallback(t *testing.T) {
	s := testStore(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>工作台</title>"), 0600)
	h, err := NewHandler(context.Background(), Config{
		Store:         s,
		AdminUsername: "admin",
		AdminPassword: "private-test-password",
		WorkerToken:   "private-test-worker-token-32-characters",
		Origin:        "https://localhost",
		AdminDistDir:  dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := func(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://localhost"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "https://localhost")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := req("POST", "/api/login", `{"username":"admin","password":"private-test-password"}`, nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.Secure {
		t.Fatal("HTTPS cookie missing Secure")
	}
	base := s.now()
	s.now = func() time.Time { return base.Add(13 * time.Hour) }
	if w = req("GET", "/api/session", "", cookie); w.Code != 401 {
		t.Fatal("expired session accepted")
	}
	for i := 0; i < 10; i++ {
		if w = req("POST", "/api/login", `{"username":"admin","password":"wrong"}`, nil); w.Code != 401 {
			t.Fatalf("wrong login %d: %d", i, w.Code)
		}
	}
	if w = req("POST", "/api/login", `{"username":"admin","password":"private-test-password"}`, nil); w.Code != 429 {
		t.Fatal("login rate limit bypassed")
	}
	if w = req("GET", "/jobs/deep-link", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "工作台") {
		t.Fatal("SPA deep link unavailable", w.Code, w.Body.String())
	}
	if w = req("GET", "/api/absent", "", nil); w.Code != 404 || strings.Contains(w.Body.String(), "doctype") {
		t.Fatal("API fallback served app")
	}
	if w = req("GET", "/assets/absent.js", "", nil); w.Code != 404 {
		t.Fatal("missing asset served HTML")
	}
}
