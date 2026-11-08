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

func syntheticXHS() PlatformAccountConfig {
	return PlatformAccountConfig{ID: "xhs-main", Platform: "xiaohongshu", Username: "synthetic-red", UserID: "aaaaaaaaaaaaaaaaaaaaaaaa", DisplayName: "合成小红书账号", WorkerToken: strings.Repeat("x", 32)}
}
func configureXHS(t *testing.T, s *Store) {
	t.Helper()
	if err := s.ConfigurePlatformAccounts(context.Background(), []PlatformAccountConfig{syntheticXHS()}); err != nil {
		t.Fatal(err)
	}
}
func noteSnapshot() *NotesSnapshot {
	return &NotesSnapshot{Username: syntheticXHS().Username, UserID: syntheticXHS().UserID, Items: []Note{{ID: "bbbbbbbbbbbbbbbbbbbbbbbb", Title: "合成笔记", Status: "unknown"}}}
}
func claimNotes(t *testing.T, s *Store, key string) *Claim {
	t.Helper()
	ctx := context.Background()
	j, _, err := s.CreateAccountJob(ctx, "xhs-main", "sync_notes", key)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.ClaimForAccount(ctx, "xhs-worker", "xhs-main")
	if err != nil || c == nil || c.Job.ID != j.ID {
		t.Fatalf("claim: %v %+v", err, c)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	return c
}
func notesResult(c *Claim, snapshot *NotesSnapshot) CompleteInput {
	return CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Notes: snapshot, AccountIdentity: &AccountIdentity{Username: syntheticXHS().Username, UserID: syntheticXHS().UserID}}
}
func TestNotesValidation(t *testing.T) {
	if validateNotes(noteSnapshot(), syntheticXHS().Username, syntheticXHS().UserID) != nil {
		t.Fatal("valid snapshot")
	}
	cases := []func(*NotesSnapshot){func(n *NotesSnapshot) { n.Items = nil }, func(n *NotesSnapshot) { n.UserID = "other" }, func(n *NotesSnapshot) { n.Items = append(n.Items, n.Items[0]) }, func(n *NotesSnapshot) { v := int64(-1); n.Items[0].Views = &v }, func(n *NotesSnapshot) { n.Items[0].Status = "draft" }, func(n *NotesSnapshot) { n.Items[0].ID = "javascript:alert(1)" }, func(n *NotesSnapshot) { n.Items[0].PostedAt = "invalid" }, func(n *NotesSnapshot) { v := time.Now(); n.SyncedAt = &v }}
	for i, alter := range cases {
		n := noteSnapshot()
		alter(n)
		if validateNotes(n, syntheticXHS().Username, syntheticXHS().UserID) == nil {
			t.Fatalf("accepted invalid %d", i)
		}
	}
	n := noteSnapshot()
	n.Items = []Note{}
	if validateNotes(n, n.Username, n.UserID) != nil {
		t.Fatal("empty list rejected")
	}
}
func TestNotesIsolationLifecycleAndRetention(t *testing.T) {
	s := testStore(t)
	configureXHS(t, s)
	ctx := context.Background()
	csdn := createTest(t, s, "csdn")
	cc, err := s.Claim(ctx, "csdn-worker")
	if err != nil || cc == nil || cc.Job.ID != csdn.ID {
		t.Fatal(err)
	}
	c := claimNotes(t, s, "xhs-sync")
	j, created, err := s.CreateAccountJob(ctx, "xhs-main", "sync_notes", "xhs-coalesced")
	if err != nil || created || j.ID != c.Job.ID {
		t.Fatal("coalesce", err)
	}
	if _, _, err = s.CreateAccountJob(ctx, "xhs-main", "check_account", "csdn"); err != ErrConflict {
		t.Fatal("request scope", err)
	}
	if err = s.Complete(ctx, c.Job.ID, notesResult(c, noteSnapshot())); err != nil {
		t.Fatal(err)
	}
	p, err := s.Notes(ctx, "xhs-main", "合成", "unknown", 1, 20)
	if err != nil || p.Total != 1 || p.Snapshot == nil || p.Items[0].Views != nil {
		t.Fatalf("snapshot %+v %v", p, err)
	}
	if a, err := s.Articles(ctx, "", "", 1, 20); err != nil || a.Total != 0 {
		t.Fatal("CSDN leaked", err)
	}
	for _, failure := range []string{"failed", "cancelled", "waiting_user"} {
		c = claimNotes(t, s, "xhs-"+failure)
		if failure == "cancelled" {
			if _, err = s.Action(ctx, c.Job.ID, "cancel", ActionInput{}); err != nil {
				t.Fatal(err)
			}
			if err = s.Complete(ctx, c.Job.ID, notesResult(c, noteSnapshot())); err != ErrConflict {
				t.Fatal("cancel snapshot", err)
			}
		}
		if err = s.Complete(ctx, c.Job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: failure, ErrorCode: "network_error"}); err != nil {
			t.Fatal(err)
		}
		p, err = s.Notes(ctx, "xhs-main", "", "", 1, 20)
		if err != nil || p.Total != 1 {
			t.Fatal("snapshot lost", err)
		}
		if failure == "waiting_user" {
			if _, err = s.Action(ctx, c.Job.ID, "cancel", ActionInput{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	c = claimNotes(t, s, "empty")
	n := noteSnapshot()
	n.Items = []Note{}
	if err = s.Complete(ctx, c.Job.ID, notesResult(c, n)); err != nil {
		t.Fatal(err)
	}
	p, err = s.Notes(ctx, "xhs-main", "", "", 1, 20)
	if err != nil || p.Total != 0 || p.Snapshot == nil {
		t.Fatal("empty snapshot", err)
	}
	a, _ := s.AccountByID(ctx, "csdn-main")
	if a.Status != "unchecked" {
		t.Fatal("other account status changed")
	}
	rows, total, err := s.Processes(ctx, ProcessFilter{Platform: "xiaohongshu", From: time.Now().Add(-time.Hour), To: time.Now().Add(time.Hour), Page: 1, Size: 20})
	if err != nil || total != 5 || len(rows) != 5 {
		t.Fatalf("process duplicates %d %d %v", total, len(rows), err)
	}
}
func TestNotesLeaseAndIdentityFencing(t *testing.T) {
	s := testStore(t)
	configureXHS(t, s)
	ctx := context.Background()
	c := claimNotes(t, s, "fencing")
	bad := notesResult(c, noteSnapshot())
	bad.AccountIdentity.UserID = "other"
	if s.Complete(ctx, c.Job.ID, bad) != ErrInvalid {
		t.Fatal("wrong identity accepted")
	}
	bad = notesResult(c, noteSnapshot())
	bad.LeaseToken = "expired"
	if s.Complete(ctx, c.Job.ID, bad) != ErrConflict {
		t.Fatal("wrong lease accepted")
	}
	if s.Progress(ctx, c.Job.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "saving", ExternalStarted: true}) == nil {
		t.Fatal("write checkpoint accepted")
	}
	if _, _, err := s.Create(ctx, CreateInput{Platform: "csdn", Kind: "sync_notes", RequestID: "legacy"}); err != ErrInvalid {
		t.Fatal("legacy route accepted notes")
	}
	if s.WorkerHeartbeatForAccount(ctx, "xhs-worker", "csdn-main", true, true) != ErrConflict {
		t.Fatal("worker crossed accounts")
	}
	s.pool.Exec(ctx, "UPDATE account SET native_user_id=$1 WHERE id='xhs-main'", strings.Repeat("c", 24))
	if s.Complete(ctx, c.Job.ID, notesResult(c, noteSnapshot())) != ErrConflict {
		t.Fatal("changed identity accepted")
	}
	p, err := s.Notes(ctx, "xhs-main", "", "", 1, 20)
	if err != nil || p.Snapshot != nil {
		t.Fatal("identity cache leak")
	}
}
func TestPlatformAccountHTTPIsolation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: s, AdminUsername: "admin", AdminPassword: "test-password-long", WorkerToken: strings.Repeat("w", 32), Origin: "http://localhost", PlatformAccounts: []PlatformAccountConfig{syntheticXHS()}})
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("a", 64)
	s.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin','csrf',$2)", hashToken(token), time.Now().Add(time.Hour))
	request := func(method, path, body, worker string, admin, csrf bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "http://localhost")
		if admin {
			r.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
		}
		if csrf {
			r.Header.Set("X-CSRF-Token", "csrf")
		}
		if worker != "" {
			r.Header.Set("Authorization", "Bearer "+worker)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/api/accounts", "", "", false, false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w := request("GET", "/api/accounts", "", "", true, false)
	if w.Code != 200 || strings.Contains(w.Body.String(), syntheticXHS().WorkerToken) || !strings.Contains(w.Body.String(), `"sync_notes":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request("POST", "/api/accounts/xhs-main/notes/sync", `{"request_id":"no-csrf"}`, "", true, false); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w = request("POST", "/api/accounts/xhs-main/notes/sync", `{"request_id":"sync"}`, "", true, true)
	var job Job
	json.Unmarshal(w.Body.Bytes(), &job)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request("POST", "/internal/worker/claim", `{"worker_id":"csdn"}`, strings.Repeat("w", 32), false, false); w.Code != 204 {
		t.Fatal("CSDN claimed XHS", w.Code, w.Body.String())
	}
	if w = request("POST", "/internal/worker/jobs/"+job.ID+"/heartbeat", `{"lease_token":"any"}`, strings.Repeat("w", 32), false, false); w.Code != 403 {
		t.Fatal("cross account mutation", w.Code)
	}
	if w = request("POST", "/internal/worker/claim", `{"worker_id":"xhs"}`, syntheticXHS().WorkerToken, false, false); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var claimed Claim
	if err = json.Unmarshal(w.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	completion, _ := json.Marshal(CompleteInput{LeaseToken: claimed.LeaseToken, Status: "waiting_user", ErrorCode: "needs_login"})
	if w = request("POST", "/internal/worker/jobs/"+job.ID+"/complete", string(completion), syntheticXHS().WorkerToken, false, false); w.Code != 200 {
		t.Fatal("wait login", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/accounts/xhs-main/notes/upload", "/api/accounts/xhs-main/notes/draft", "/api/accounts/xhs-main/publish"} {
		if w = request("POST", path, "{}", "", true, true); w.Code != 404 {
			t.Fatal("unexpected write route", w.Code)
		}
	}
	h, err = NewHandler(ctx, Config{Store: s, AdminUsername: "admin", AdminPassword: "test-password-long", WorkerToken: strings.Repeat("w", 32), Origin: "http://localhost"})
	if err != nil {
		t.Fatal(err)
	}
	w = request("GET", "/api/accounts", "", "", true, false)
	var disabled struct {
		Items []struct {
			Account Account `json:"account"`
		} `json:"items"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &disabled); err != nil || w.Code != 200 || len(disabled.Items) != 1 || disabled.Items[0].Account.ID != "csdn-main" {
		t.Fatal("disabled account listed", w.Code, err)
	}
	for _, path := range []string{"/api/accounts/xhs-main", "/api/accounts/xhs-main/notes"} {
		if w = request("GET", path, "", "", true, false); w.Code != 404 {
			t.Fatal("disabled account readable", w.Code)
		}
	}
	if w = request("POST", "/api/accounts/xhs-main/notes/sync", `{"request_id":"disabled"}`, "", true, true); w.Code != 404 {
		t.Fatal("disabled task created", w.Code)
	}
	if w = request("POST", "/internal/worker/claim", `{"worker_id":"disabled-worker"}`, syntheticXHS().WorkerToken, false, false); w.Code != 401 {
		t.Fatal("disabled worker authorized", w.Code)
	}
	if w = request("POST", "/api/jobs/"+job.ID+"/resume", "{}", "", true, true); w.Code != 409 {
		t.Fatal("disabled task resumed", w.Code)
	}
	accounts, err := s.Accounts(ctx)
	if err != nil || len(accounts) != 2 {
		t.Fatal("disabled account metadata deleted", err)
	}

}
func TestPlatformAccountsPrivateConfig(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	os.WriteFile(token, []byte(strings.Repeat("x", 32)), 0600)
	a := syntheticXHS()
	a.ProfileDir = filepath.Join(dir, "profile")
	a.WorkerTokenFile = token
	raw, _ := json.Marshal(map[string]any{"accounts": []PlatformAccountConfig{a}})
	file := filepath.Join(dir, "accounts.json")
	os.WriteFile(file, raw, 0600)
	if _, err := loadPlatformAccounts(file, strings.Repeat("w", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := loadPlatformAccounts(file, strings.Repeat("x", 32)); err == nil {
		t.Fatal("shared token")
	}
	os.WriteFile(file, append(raw, []byte(" {}")...), 0600)
	if _, err := loadPlatformAccounts(file, ""); err == nil {
		t.Fatal("trailing JSON")
	}
	os.WriteFile(file, raw, 0600)
	os.Chmod(file, 0644)
	if _, err := loadPlatformAccounts(file, ""); err == nil {
		t.Fatal("public configuration")
	}
}
func TestPlatformAccountBindingCannotBeReplaced(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	configureXHS(t, s)
	a := syntheticXHS()
	a.Username = "different"
	if err := s.ConfigurePlatformAccounts(ctx, []PlatformAccountConfig{a}); err != ErrConflict {
		t.Fatal("identity silently replaced", err)
	}
	a = syntheticXHS()
	a.ID = "another-xhs"
	if err := s.ConfigurePlatformAccounts(ctx, []PlatformAccountConfig{a}); err == nil {
		t.Fatal("second account for platform accepted")
	}
	accounts, err := s.Accounts(ctx)
	if err != nil || len(accounts) != 2 {
		t.Fatal("binding changed", err)
	}
	c := claimNotes(t, s, "persistent")
	if err = s.Complete(ctx, c.Job.ID, notesResult(c, noteSnapshot())); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewStore(ctx, s.pool, "tester", "测试账号")
	if err != nil {
		t.Fatal("restart migration", err)
	}
	p, err := restarted.Notes(ctx, "xhs-main", "", "", 1, 20)
	if err != nil || p.Total != 1 || p.Snapshot == nil {
		t.Fatal("restart lost snapshot", err)
	}
}
