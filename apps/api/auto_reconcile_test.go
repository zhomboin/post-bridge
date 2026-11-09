package bridge

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func uncertainRecord(now time.Time) *record {
	r := newRecord(CreateInput{
		RequestID: "auto",
		Kind:      "save_draft",
		Platform:  "csdn",
		Title:     "测试自动核对",
		Markdown:  "正文",
	}, now)
	r.Status = "running"
	r.ExternalStarted = true
	r.Outcome = "unknown"
	r.Stage = "filling"
	return r
}
func TestAutoReconcileSchedulesAndRequiresTwoAbsentReports(t *testing.T) {
	now := time.Now().UTC()
	r := uncertainRecord(now)
	if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "timeout"}, now); err != nil {
		t.Fatal(err)
	}
	if !r.Ready || r.RunMode != "reconcile" || !r.AvailableAt.Equal(now.Add(20*time.Second)) {
		t.Fatalf("not scheduled: %+v", r)
	}
	for n := 0; n < 2; n++ {
		now = now.Add(20 * time.Second)
		r.Status = "running"
		r.Stage = "verifying"
		if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "draft_absent"}, now); err != nil {
			t.Fatal(err)
		}
		if n == 0 && (r.Status != "reconciling" || !r.ExternalStarted || r.RetryCount != 0) {
			t.Fatal("single empty query allowed writing")
		}
	}
	if r.Status != "queued" || r.RunMode != "execute" || r.ExternalStarted || !r.Ready || r.RetryCount != 1 || r.Outcome != "not_submitted" {
		t.Fatalf("absence not recovered: %+v", r)
	}
}
func TestAutoReconcileFailureBoundAndCancellation(t *testing.T) {
	now := time.Now().UTC()
	r := uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	for n := 0; n < 4; n++ {
		r.Status = "running"
		if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "reconcile_unavailable"}, now); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Minute)
	}
	if r.Status != "failed" || r.Ready || r.Outcome != "unknown" || r.RetryCount != 0 {
		t.Fatalf("unbounded query: %+v", r)
	}
	r = uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	r.CancelRequested = true
	for n := 0; n < 2; n++ {
		r.Status = "running"
		if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "draft_absent"}, now); err != nil {
			t.Fatal(err)
		}
		now = now.Add(20 * time.Second)
	}
	if r.Status != "cancelled" || r.Ready || r.RetryCount != 0 {
		t.Fatalf("cancel resumed writing: %+v", r)
	}
}
func TestAutoReconcileDiscoveredIDAndBoundIDProtection(t *testing.T) {
	now := time.Now().UTC()
	r := uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "456"}, now); err != nil {
		t.Fatalf("discovered match rejected: %v", err)
	}
	if r.Status != "succeeded" || r.RemoteID != "456" || r.ErrorCode != "" {
		t.Fatal(r)
	}
	r = uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	r.RemoteID = "123"
	for n := 0; n < 2; n++ {
		r.Status = "running"
		if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "draft_absent"}, now); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Minute)
	}
	if !r.ExternalStarted || r.RetryCount != 0 || r.RunMode != "reconcile" {
		t.Fatal("bound draft was discarded")
	}
}

func TestPostgresAutoReconcileLegacyRecoveryAndRetry(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	j := createTest(t, s, "legacy-auto")
	now := time.Now().UTC()
	s.now = func() time.Time { return now }
	r := newRecord(CreateInput{RequestID: j.RequestID, Kind: j.Kind, Platform: j.Platform, Title: j.Title, Markdown: j.Markdown}, now)
	r.ID = j.ID
	r.Status = "reconciling"
	r.ExternalStarted = true
	r.RunMode = "reconcile"
	r.Outcome = "unknown"
	r.Ready = false
	data, _ := json.Marshal(r)
	if _, err := s.pool.Exec(ctx, "UPDATE jobs SET record=$2 WHERE id=$1", j.ID, data); err != nil {
		t.Fatal(err)
	}
	if c, err := s.Claim(ctx, "owner"); err != nil || c != nil {
		t.Fatal("legacy task claimed without settling", err)
	}
	for i := 0; i < 2; i++ {
		now = now.Add(20 * time.Second)
		c, err := s.Claim(ctx, "owner")
		if err != nil || c == nil || c.Job.ID != j.ID {
			t.Fatal("missing auto read claim", err)
		}
		if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
			t.Fatal(err)
		}
		if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling", ErrorCode: "draft_absent"}); err != nil {
			t.Fatal(err)
		}
		if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling", ErrorCode: "draft_absent"}); err != ErrConflict {
			t.Fatal("duplicate report accepted", err)
		}
	}
	now = now.Add(5 * time.Second)
	c, err := s.Claim(ctx, "owner")
	if err != nil || c == nil || c.Job.RunMode != "execute" || c.Job.RetryCount != 1 {
		t.Fatal("missing safe write retry", err)
	}
}
func TestPostgresAutoDiscoveredDraftCannotBelongToAnotherJob(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	s.now = func() time.Time { return now }
	first := createTest(t, s, "first-binding")
	c, err := s.Claim(ctx, "owner")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, first.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", ExternalStarted: true, RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, first.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	second := createTest(t, s, "second-binding")
	c, err = s.Claim(ctx, "owner")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, second.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, second.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "reconciling", ErrorCode: "timeout"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(20 * time.Second)
	c, err = s.Claim(ctx, "owner")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, second.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, second.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, second.ID)
	if err != nil || got.Status != "failed" || got.RemoteID != "" || got.ErrorCode != "draft_conflict" {
		t.Fatalf("wrong association %+v %v", got, err)
	}
}

func TestCancelledReconcileLoginResumeNeverWrites(t *testing.T) {
	now := time.Now().UTC()
	r := uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	r.CancelRequested = true
	if err := r.complete(CompleteInput{Status: "waiting_user", ErrorCode: "needs_login"}, now); err != nil {
		t.Fatal(err)
	}
	if err := r.action("resume", ActionInput{}, now, nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		now = now.Add(20 * time.Second)
		r.Status = "running"
		r.Stage = "verifying"
		if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "draft_absent"}, now); err != nil {
			t.Fatal(err)
		}
	}
	if r.Status != "cancelled" || r.RetryCount != 0 {
		t.Fatal("login resumed cancelled write", r.Status)
	}
}
func TestPostgresProgressRejectsAnotherJobsRemoteID(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	first := createTest(t, s, "progress-first")
	c, _ := s.Claim(ctx, "owner")
	if err := s.Progress(ctx, first.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", ExternalStarted: true, RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, first.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", RemoteID: "123"}); err != nil {
		t.Fatal(err)
	}
	second := createTest(t, s, "progress-second")
	c, _ = s.Claim(ctx, "owner")
	if err := s.Progress(ctx, second.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying", ExternalStarted: true, RemoteID: "123"}); err != ErrConflict {
		t.Fatal("duplicate id persisted", err)
	}
	got, _ := s.Get(ctx, second.ID)
	if got.RemoteID != "" {
		t.Fatal("cross task link exposed")
	}
}

func TestExplicitRecheckConflictKeepsConcreteError(t *testing.T) {
	now := time.Now().UTC()
	r := uncertainRecord(now)
	r.RunMode = "reconcile"
	r.Stage = "verifying"
	r.ReconcileCount = 4
	if err := r.complete(CompleteInput{Status: "reconciling", ErrorCode: "draft_mismatch"}, now); err != nil {
		t.Fatal(err)
	}
	if r.ErrorCode != "draft_mismatch" {
		t.Fatal("concrete conflict was hidden", r.ErrorCode)
	}
}
