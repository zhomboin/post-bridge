package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func processTestHandler(t *testing.T, s *Store) (http.Handler, *http.Cookie) {
	t.Helper()
	h, err := NewHandler(context.Background(), Config{Store: s, AdminUsername: "admin", AdminPassword: "private-test-password", WorkerToken: "private-test-worker-token-32-characters", Origin: "http://localhost"})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "http://localhost/api/login", strings.NewReader(`{"username":"admin","password":"private-test-password"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	return h, w.Result().Cookies()[0]
}
func processRequest(h http.Handler, c *http.Cookie, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", "http://localhost"+path, nil)
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestProcessRoutesAndHistoryPagination(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	old := s.now().Truncate(time.Microsecond).Add(-48 * time.Hour)
	s.now = func() time.Time { return old }
	first := createTest(t, s, "process-first")
	c, err := s.Claim(ctx, "process-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, first.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, first.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "adapter_mismatch"}); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return old.Add(48 * time.Hour) }
	second := createTest(t, s, "process-second")
	h, cookie := processTestHandler(t, s)
	for _, path := range []string{"/api/processes", "/api/jobs/" + first.ID + "/history", "/api/jobs/" + first.ID + "/changes"} {
		if w := processRequest(h, nil, path); w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unprotected %s: %d", path, w.Code)
		}
	}
	w := processRequest(h, cookie, "/api/processes?page_size=1")
	if w.Code != 200 {
		t.Fatalf("process endpoint: %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Items []struct{ ID string }
		Total int
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ID != second.ID || strings.Contains(w.Body.String(), "\"markdown\"") {
		t.Fatalf("wrong object page: %s", w.Body.String())
	}
	w = processRequest(h, cookie, "/api/jobs/"+first.ID+"/history?page=2&page_size=1")
	var history struct {
		Items       []Log
		Total       int
		Transitions []Log
	}
	json.Unmarshal(w.Body.Bytes(), &history)
	if w.Code != 200 || history.Total != 4 || len(history.Items) != 1 || history.Items[0].Message != "执行器已领取任务" || len(history.Transitions) < 3 {
		t.Fatalf("incomplete history: %d %s", w.Code, w.Body.String())
	}
	w = processRequest(h, cookie, "/api/processes?from="+old.Add(-time.Minute).Format(time.RFC3339)+"&to="+s.now().Add(time.Minute).Format(time.RFC3339)+"&page=3&page_size=1")
	json.Unmarshal(w.Body.Bytes(), &list)
	if w.Code != 200 || list.Total != 2 || len(list.Items) != 0 {
		t.Fatalf("empty page lost total %s", w.Body.String())
	}
	for _, q := range []string{"attempt=0", "attempt=-1", "attempt=bad"} {
		if w := processRequest(h, cookie, "/api/jobs/"+first.ID+"/changes?"+q); w.Code != 400 {
			t.Fatalf("bad attempt accepted %s: %d", q, w.Code)
		}
	}
	if w := processRequest(h, cookie, "/api/jobs/missing/history"); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestProcessObservationIsActualAndLeaseFenced(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "actual-observation")
	c, err := s.Claim(ctx, "actual-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	progress := func(token, stage, phase, title, body string) error {
		raw, _ := json.Marshal(map[string]any{"lease_token": token, "stage": stage, "external_started": true, "remote_id": "123", "observation": map[string]string{"phase": phase, "title": title, "markdown": body, "status": "draft", "remote_id": "123"}})
		var in ProgressInput
		if err := json.Unmarshal(raw, &in); err != nil {
			t.Fatal(err)
		}
		return s.Progress(ctx, j.ID, in)
	}
	if err = progress(c.LeaseToken, "filling", "before", "实际旧标题", "actual old"); err != nil {
		t.Fatal(err)
	}
	if err = progress(c.LeaseToken, "filling", "before", "实际旧标题", "actual old"); err != nil {
		t.Fatal("same snapshot not idempotent", err)
	}
	if err = progress(c.LeaseToken, "filling", "before", "不同旧标题", "different"); err != ErrConflict {
		t.Fatalf("conflicting snapshot accepted: %v", err)
	}
	if err = progress("wrong", "verifying", "after", "实际新标题", "actual new"); err != ErrConflict {
		t.Fatal("wrong lease accepted", err)
	}
	if err = progress(c.LeaseToken, "verifying", "after", "实际新标题", "actual new"); err != nil {
		t.Fatal(err)
	}
	h, cookie := processTestHandler(t, s)
	w := processRequest(h, cookie, "/api/jobs/"+j.ID+"/changes")
	var changes struct {
		Submitted struct{ Title, Markdown string }
		Snapshots []struct {
			Phase, Title, Markdown, Status string
			Attempt                        int
		}
		Attempts        []int
		ContentRetained bool `json:"content_retained"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &changes); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !changes.ContentRetained || len(changes.Snapshots) != 2 || changes.Snapshots[0].Markdown != "actual old" || changes.Snapshots[1].Markdown != "actual new" || changes.Submitted.Markdown == changes.Snapshots[0].Markdown {
		t.Fatalf("not actual snapshots: %d %s", w.Code, w.Body.String())
	}
	logs, _, err := s.Logs(ctx, j.ID, "", "", s.now().Add(-time.Hour), s.now().Add(time.Hour), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(logs)
	if strings.Contains(string(data), "actual old") || strings.Contains(string(data), "actual new") {
		t.Fatal("body leaked to logs")
	}
}

func TestProcessAccountSnapshotsAttemptsAndRetention(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := s.now()
	old := now.Add(-32 * 24 * time.Hour)
	s.now = func() time.Time { return old }
	first, _, err := s.Create(ctx, CreateInput{RequestID: "account-first", Kind: "check_account", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Claim(ctx, "account-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, first.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "network_error", Retryable: true}); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return old.Add(10 * time.Second) }
	c, err = s.Claim(ctx, "account-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, first.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	changes, err := s.Changes(ctx, first.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes.Attempts) != 2 || len(changes.Snapshots) != 2 || changes.Snapshots[0].Attempt != 1 || changes.Snapshots[1].Attempt != 2 || changes.Snapshots[0].Status != "unchecked" || changes.Snapshots[1].Status != "connected" {
		t.Fatalf("wrong account snapshots %+v", changes)
	}
	one, err := s.Changes(ctx, first.ID, 1)
	if err != nil || len(one.Snapshots) != 2 || one.Snapshots[1].Status != "unchecked" {
		t.Fatalf("wrong attempt %+v %v", one, err)
	}
	second, _, err := s.Create(ctx, CreateInput{RequestID: "account-second", Kind: "check_account", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.Claim(ctx, "account-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, second.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "adapter_mismatch"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return now }
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	changes, err = s.Changes(ctx, first.ID, 0)
	if err != nil || len(changes.Snapshots) != 0 || changes.ContentRetained {
		t.Fatalf("terminal snapshots retained %+v %v", changes, err)
	}
	changes, err = s.Changes(ctx, second.ID, 0)
	if err != nil || len(changes.Snapshots) != 2 || !changes.ContentRetained {
		t.Fatalf("retryable snapshots deleted %+v %v", changes, err)
	}
	items, total, err := s.Processes(ctx, ProcessFilter{From: old.Add(-time.Minute), To: now, Page: 1, Size: 1, Kind: "check_account"})
	if err != nil || total != 2 || len(items) != 1 || items[0].ObjectType != "account" || items[0].ObjectID != "csdn-main" || items[0].AccountName != "测试账号" {
		t.Fatalf("account rows %+v %d %v", items, total, err)
	}
}
func TestProcessObservationBoundariesAndRollback(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "observation-boundaries")
	c, err := s.Claim(ctx, "boundary-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	base := Observation{Phase: "before", Title: "", Markdown: "", Status: "editor"}
	invalid := []struct {
		stage string
		ob    Observation
	}{
		{"filling", Observation{Phase: "before", Title: strings.Repeat("中", 101), Status: "editor"}},
		{"filling", Observation{Phase: "before", Markdown: strings.Repeat("中", 200001), Status: "editor"}},
		{"filling", Observation{Phase: "before", Status: strings.Repeat("中", 101)}},
		{"filling", Observation{Phase: "before", Status: ""}},
		{"filling", Observation{Phase: "before", Title: string([]byte{0xff}), Status: "editor"}},
		{"filling", Observation{Phase: "before", Markdown: "a\x00b", Status: "editor"}},
		{"filling", Observation{Phase: "before", Status: "editor", RemoteID: "not-numeric"}},
		{"saving", base},
		{"filling", Observation{Phase: "after", Status: "draft"}},
	}
	for i, tc := range invalid {
		if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: tc.stage, ExternalStarted: true, Observation: &tc.ob}); err == nil {
			t.Fatalf("invalid observation %d accepted", i)
		}
	}
	var count int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM process_snapshots WHERE job_id=$1", j.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("snapshot persisted after rejection", count, err)
	}
	max := Observation{Phase: "before", Title: strings.Repeat("中", 100), Markdown: strings.Repeat("中", 200000), Status: "editor"}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", ExternalStarted: true, Observation: &max}); err != nil {
		t.Fatal("max observation rejected", err)
	}
	s.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", Observation: &Observation{Phase: "after", Status: "draft"}}); err != ErrConflict {
		t.Fatal("expired snapshot accepted", err)
	}
}
func TestProcessFiltersTransitionsAndMissingSnapshots(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "filter-process")
	c, err := s.Claim(ctx, "filter-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login"}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "adapter_mismatch"}); err != nil {
		t.Fatal(err)
	}
	_, err = s.pool.Exec(ctx, "INSERT INTO logs(job_id,attempt,level,stage,message,created_at) VALUES($1,0,'error','legacy','旧日志唯一检索词',$2)", j.ID, s.now())
	if err != nil {
		t.Fatal(err)
	}
	items, total, err := s.Processes(ctx, ProcessFilter{Q: "唯一检索词", Status: "failed", Platform: "csdn", Kind: "save_draft", JobID: j.ID, Level: "error", From: s.now().Add(-time.Hour), To: s.now().Add(time.Hour), Page: 1, Size: 1})
	if err != nil || total != 1 || len(items) != 1 || items[0].EventCount != 7 || items[0].ErrorCount != 1 || items[0].WarningCount != 1 {
		t.Fatalf("wrong filters %+v %d %v", items, total, err)
	}
	logs, n, trans, err := s.History(ctx, j.ID, 7, 1)
	if err != nil || n != 7 || len(logs) != 1 || len(trans) != 5 || logs[0].Status != "" || trans[0].Status != "queued" || trans[1].Status != "running" {
		t.Fatalf("wrong transitions %+v %+v %v", logs, trans, err)
	}
	changes, err := s.Changes(ctx, j.ID, 0)
	if err != nil || len(changes.Snapshots) != 0 || !changes.ContentRetained {
		t.Fatalf("missing snapshots were fabricated %+v %v", changes, err)
	}
	h, cookie := processTestHandler(t, s)
	for _, q := range []string{"status=bad", "platform=bad", "kind=bad", "level=bad", "q=" + strings.Repeat("中", 201), "from=bad", "from=2020-01-01T00:00:00Z", "q=%00", "job_id=%00"} {
		if w := processRequest(h, cookie, "/api/processes?"+q); w.Code != 400 {
			t.Fatalf("bad filter %s: %d", q, w.Code)
		}
	}
}

func TestProcessEmptyObservedContentAndCandidateFencing(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "empty-observed-content")
	c, err := s.Claim(ctx, "empty-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	in := ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", ExternalStarted: true, Observation: &Observation{Phase: "before", Status: "editor"}}
	if err = s.Progress(ctx, j.ID, in); err != nil {
		t.Fatal(err)
	}
	h, cookie := processTestHandler(t, s)
	w := processRequest(h, cookie, "/api/jobs/"+j.ID+"/changes")
	var raw struct{ Snapshots []map[string]any }
	if err = json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Snapshots) != 1 || raw.Snapshots[0]["title"] != "" || raw.Snapshots[0]["markdown"] != "" {
		t.Fatalf("observed empty content lost: %s", w.Body.String())
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Action(ctx, j.ID, "reconcile", ActionInput{RemoteID: "321"}); err != nil {
		t.Fatal(err)
	}
	c, err = s.Claim(ctx, "reconcile-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	in = ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", Observation: &Observation{Phase: "after", Title: "实际标题", Markdown: "实际正文", Status: "draft", RemoteID: "999"}}
	if err = s.Progress(ctx, j.ID, in); err != ErrConflict {
		t.Fatal("candidate mismatch accepted", err)
	}
	in.Observation.RemoteID = "321"
	if err = s.Progress(ctx, j.ID, in); err != nil {
		t.Fatal("matching candidate rejected", err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", Observation: &Observation{Phase: "before", Status: "editor"}}); err != ErrConflict {
		t.Fatal("reconcile before accepted", err)
	}
	changes, err := s.Changes(ctx, j.ID, 2)
	if err != nil || len(changes.Snapshots) != 1 || changes.Snapshots[0].RemoteID != "321" {
		t.Fatalf("mismatched candidate persisted %+v %v", changes, err)
	}
}
func TestProcessAccountCannotSubmitArticleObservation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j, _, err := s.Create(ctx, CreateInput{RequestID: "account-observation", Kind: "check_account", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Claim(ctx, "account-observation-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login", Observation: &Observation{Phase: "before", Status: "editor"}}); err != ErrInvalid {
		t.Fatal("account accepted article observation", err)
	}
	changes, err := s.Changes(ctx, j.ID, 0)
	if err != nil || len(changes.Snapshots) != 1 || changes.Snapshots[0].ObjectType != "account" {
		t.Fatalf("account observation polluted %+v %v", changes, err)
	}
}
func TestProcessArticleRetentionPreservesUnknownAndExpiresTerminal(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := s.now()
	old := now.Add(-32 * 24 * time.Hour)
	s.now = func() time.Time { return old }
	terminal := createTest(t, s, "terminal-snapshot")
	c, err := s.Claim(ctx, "retention-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	before := &Observation{Phase: "before", Status: "editor"}
	after := &Observation{Phase: "after", Title: "实际草稿标题", Markdown: "真实正文", Status: "draft", RemoteID: "456"}
	if err = s.Progress(ctx, terminal.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", ExternalStarted: true, RemoteID: "456", Observation: before}); err != nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, terminal.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", Observation: after}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, terminal.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	unknown := createTest(t, s, "unknown-snapshot")
	c, err = s.Claim(ctx, "retention-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, unknown.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "filling", ExternalStarted: true, Observation: before}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, unknown.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling"}); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return now }
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	changes, err := s.Changes(ctx, terminal.ID, 0)
	if err != nil || changes.ContentRetained || len(changes.Snapshots) != 0 || changes.Submitted.Markdown != "" {
		t.Fatalf("terminal body retained %+v %v", changes, err)
	}
	changes, err = s.Changes(ctx, unknown.ID, 0)
	if err != nil || !changes.ContentRetained || len(changes.Snapshots) != 1 || changes.Submitted.Markdown == "" {
		t.Fatalf("unknown body removed %+v %v", changes, err)
	}
}

func TestProcessAccountObservedEmptyFieldsRemainPresent(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, "UPDATE account SET username='',display_name='' WHERE id='csdn-main'"); err != nil {
		t.Fatal(err)
	}
	j, _, err := s.Create(ctx, CreateInput{RequestID: "empty-account-fields", Kind: "check_account", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	if c, err := s.Claim(ctx, "empty-account-worker"); err != nil || c == nil {
		t.Fatal(err)
	}
	changes, err := s.Changes(ctx, j.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(changes)
	if err != nil {
		t.Fatal(err)
	}
	var raw struct{ Snapshots []map[string]any }
	if err = json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Snapshots) != 1 || raw.Snapshots[0]["username"] != "" || raw.Snapshots[0]["display_name"] != "" {
		t.Fatalf("empty account observation lost: %s", data)
	}
}

func TestProcessTransitionsPreserveReturnToEarlierState(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := s.now()
	s.now = func() time.Time { return now }
	j := createTest(t, s, "transition-return")
	c, err := s.Claim(ctx, "transition-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling", ErrorCode: "draft_mismatch"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(21 * time.Second)
	c, err = s.Claim(ctx, "transition-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "draft_mismatch"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Action(ctx, j.ID, "reconcile", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	if err = s.WorkerHeartbeat(ctx, "transition-worker", true, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Action(ctx, j.ID, "resolve", ActionInput{ConfirmedBrowserStopped: true, Note: "确认保留平台结果并结束"}); err != nil {
		t.Fatal(err)
	}
	_, _, transitions, err := s.History(ctx, j.ID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(transitions) < 3 {
		t.Fatal("missing transitions", transitions)
	}
	last := transitions[len(transitions)-3:]
	if last[0].Status != "failed" || last[1].Status != "reconciling" || last[2].Status != "failed" || last[0].Attempt != 2 || last[2].Attempt != 2 || last[2].Message != "管理员保留草稿并人工结束任务" {
		t.Fatalf("return to failed was lost: %+v", last)
	}
}
