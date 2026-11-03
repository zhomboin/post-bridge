package bridge

import (
	"testing"
	"time"
)

func TestInputRejectsUnsupportedContentAndAllowsFencedExamples(t *testing.T) {
	for _, body := range []string{"![x](https://x/a.png)", "<script>alert(1)</script>", "<Widget />", "export const x = 1", "text {danger()}", "<img src=x>", "![x][image]\n\n[image]: https://x/y"} {
		if err := ValidateCreate(CreateInput{RequestID: "a", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: body}); err == nil {
			t.Errorf("accepted unsupported body %q", body)
		}
	}
	for _, body := range []string{"# hello\n\nplain Markdown", "```html\n<script>example</script>\n```", "~~~mdx\n<Widget />\n~~~"} {
		if err := ValidateCreate(CreateInput{RequestID: "a", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: body}); err != nil {
			t.Errorf("rejected fenced example: %v", err)
		}
	}
	for _, in := range []CreateInput{{RequestID: "a", Kind: "publish", Platform: "csdn", Title: "valid title", Markdown: "body"}, {RequestID: "a", Kind: "save_draft", Platform: "zhihu", Title: "valid title", Markdown: "body"}, {RequestID: "a", Kind: "save_draft", Platform: "csdn", Title: "x", Markdown: "body"}} {
		if ValidateCreate(in) == nil {
			t.Error("accepted invalid input")
		}
	}
}

func TestTransitionSafety(t *testing.T) {
	now := time.Now().UTC()
	r := newRecord(CreateInput{RequestID: "r", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: "body"}, now)
	r.Status = "running"
	r.Attempts = 1
	r.LeaseToken = "a"
	r.LeaseExpiresAt = now.Add(time.Minute)
	if err := r.progress(ProgressInput{Stage: "opening_editor", ExternalStarted: true}, now); err != nil {
		t.Fatal(err)
	}
	if err := r.complete(CompleteInput{Status: "failed", Retryable: true, ErrorCode: "network_error"}, now); err != nil {
		t.Fatal(err)
	}
	if r.Status != "reconciling" || r.Outcome != "unknown" || !r.Ready || r.RetryAllowed {
		t.Fatalf("unsafe retry: %+v", r)
	}
	if err := r.action("retry", ActionInput{}, now, nil); err == nil {
		t.Fatal("unknown outcome retried")
	}
	if err := r.action("reconcile", ActionInput{RemoteID: "123"}, now, nil); err != nil {
		t.Fatal(err)
	}
	if r.RemoteID != "" || r.ReconcileCandidateID != "123" {
		t.Fatal("candidate bound without verification")
	}
	r.Ready = false
	if err := r.action("reconcile", ActionInput{RemoteID: "456"}, now, nil); err != nil {
		t.Fatal(err)
	}
	if r.ReconcileCandidateID != "456" {
		t.Fatal("candidate could not be corrected")
	}
	r.Status = "running"
	r.RunMode = "reconcile"
	if err := r.progress(ProgressInput{Stage: "verifying", RemoteID: "999"}, now); err == nil {
		t.Fatal("bound unmatched candidate")
	}
	if err := r.progress(ProgressInput{Stage: "verifying"}, now); err != nil {
		t.Fatal(err)
	}
	if err := r.complete(CompleteInput{Status: "succeeded", RemoteID: "456"}, now); err != nil {
		t.Fatal(err)
	}
	if r.RemoteID != "456" || r.Outcome != "draft_saved" {
		t.Fatal("matched draft was not bound")
	}
}

func TestManualResolveRequiresFreshIdleProofAndNoLease(t *testing.T) {
	now := time.Now().UTC()
	makeRecord := func() *record {
		r := newRecord(CreateInput{RequestID: "r", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: "body"}, now)
		r.Status = "reconciling"
		r.ExternalStarted = true
		r.Outcome = "unknown"
		r.RemoteID = "123"
		return r
	}
	in := ActionInput{ConfirmedBrowserStopped: true, Note: "保留已有草稿"}
	for _, proof := range []*workerProof{nil, {SeenAt: now.Add(-46 * time.Second), BrowserIdle: true, ProfileAvailable: true}, {SeenAt: now, BrowserIdle: false, ProfileAvailable: true}, {SeenAt: now, BrowserIdle: true}} {
		if makeRecord().action("resolve", in, now, proof) == nil {
			t.Fatal("accepted unsafe proof")
		}
	}
	proof := &workerProof{SeenAt: now, BrowserIdle: true, ProfileAvailable: true}
	r := makeRecord()
	r.LeaseToken = "valid"
	r.LeaseExpiresAt = now.Add(time.Second)
	if r.action("resolve", in, now, proof) == nil {
		t.Fatal("resolved active lease")
	}
	r.LeaseExpiresAt = now.Add(-time.Second)
	if err := r.action("resolve", in, now, proof); err != nil {
		t.Fatal(err)
	}
	if r.Status != "failed" || !r.ManualResolved || r.Outcome != "unknown" || r.RemoteID != "123" || r.RetryAllowed {
		t.Fatalf("unsafe resolution: %+v", r)
	}
}

func TestCancelWaitsForWorkerAndSafeRetryIsBounded(t *testing.T) {
	now := time.Now().UTC()
	r := newRecord(CreateInput{RequestID: "r", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: "body"}, now)
	r.Status = "running"
	r.Attempts = 1
	if err := r.action("cancel", ActionInput{}, now, nil); err != nil {
		t.Fatal(err)
	}
	if r.Status != "running" || !r.CancelRequested {
		t.Fatal("cancelled before worker stopped")
	}
	if err := r.complete(CompleteInput{Status: "cancelled"}, now); err != nil {
		t.Fatal(err)
	}
	if r.Status != "cancelled" {
		t.Fatal(r.Status)
	}
	r = newRecord(CreateInput{RequestID: "s", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: "body"}, now)
	r.Status = "running"
	r.Attempts = 1
	if err := r.complete(CompleteInput{Status: "failed", Retryable: true, ErrorCode: "network_error"}, now); err != nil {
		t.Fatal(err)
	}
	if r.Status != "queued" || !r.AvailableAt.Equal(now.Add(5*time.Second)) {
		t.Fatal("wrong safe backoff")
	}
	r.Status = "running"
	r.Attempts = 4
	r.RetryCount = 3
	if err := r.complete(CompleteInput{Status: "failed", Retryable: true, ErrorCode: "network_error"}, now); err != nil {
		t.Fatal(err)
	}
	if r.Status != "failed" || r.RetryAllowed {
		t.Fatal("unbounded retry")
	}
}

func TestLoginAndReconcileClaimsDoNotSpendSafeRetryBudget(t *testing.T) {
	now := time.Now().UTC()
	r := newRecord(CreateInput{RequestID: "login-budget", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: "body"}, now)
	for i := 0; i < 6; i++ {
		r.Status = "running"
		r.Attempts++
		if err := r.complete(CompleteInput{Status: "waiting_user", ErrorCode: "needs_login"}, now); err != nil {
			t.Fatal(err)
		}
		if err := r.action("resume", ActionInput{}, now, nil); err != nil {
			t.Fatal(err)
		}
	}
	if r.RetryCount != 0 || r.Attempts != 6 {
		t.Fatal("login waits consumed network budget")
	}
	for i := 0; i < 3; i++ {
		r.Status = "running"
		r.Attempts++
		if err := r.complete(CompleteInput{Status: "failed", Retryable: true, ErrorCode: "network_error"}, now); err != nil {
			t.Fatal(err)
		}
		if r.Status != "queued" || r.RetryCount != i+1 {
			t.Fatal("wrong retry count")
		}
	}
	r.Status = "running"
	r.Attempts++
	if err := r.complete(CompleteInput{Status: "failed", Retryable: true, ErrorCode: "network_error"}, now); err != nil {
		t.Fatal(err)
	}
	if r.Status != "failed" || r.RetryAllowed || r.RetryCount != 3 {
		t.Fatal("safe retry budget not enforced")
	}
	if err := r.action("retry", ActionInput{}, now, nil); err != ErrConflict {
		t.Fatal("manual retry exceeded budget")
	}
}
