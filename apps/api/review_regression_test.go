package bridge

import (
	"context"
	"testing"
	"time"
)

func TestFenceRecognitionCannotHideUnsupportedContent(t *testing.T) {
	bad := "![image](https://example.test/image.png)"
	cases := []struct {
		name     string
		markdown string
		allowed  bool
	}{
		{"four-space opening", "    ```md\n" + bad, false},
		{"tab opening", "\t```md\n" + bad, false},
		{"unicode opening", "\u00a0```md\n" + bad, false},
		{"backtick in opening info", "```lang`info\n" + bad, false},
		{"three-space opening", "   ```md\n" + bad + "\n   ```", true},
		{"tilde info permits backtick", "~~~lang`info\n" + bad + "\n~~~", true},
		{"closing info is code", "```md\ncode\n```notclose\n" + bad + "\n```", true},
		{"short closing is code", "````md\ncode\n```\n" + bad + "\n````", true},
		{"other closing is code", "```md\ncode\n~~~\n" + bad + "\n```", true},
		{"four-space closing is code", "```md\ncode\n    ```\n" + bad + "\n```", true},
		{"tab closing is code", "```md\ncode\n\t```\n" + bad + "\n```", true},
		{"unicode trailing closing is code", "```md\ncode\n```\u00a0\n" + bad + "\n```", true},
		{"valid closing exposes following image", "```md\ncode\n   ``` \t\n" + bad, false},
		{"CRLF exposes following HTML", "```md\r\ncode\r\n```\r\n<script>bad</script>", false},
		{"CR exposes following HTML", "```md\rcode\r```\r<script>bad</script>", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateCreate(CreateInput{RequestID: "fence", Kind: "save_draft", Platform: "csdn", Title: "valid title", Markdown: tc.markdown})
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v, want %v", (err == nil), tc.allowed)
			}
		})
	}
}

func TestMaintainRetainsRetryableSnapshotAndExpiresTerminalData(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := s.now()
	old := now.Add(-91 * 24 * time.Hour)
	s.now = func() time.Time { return old }
	retry := createTest(t, s, "retained-retry")
	claim, err := s.Claim(ctx, "retention-worker")
	if err != nil || claim == nil {
		t.Fatal("claim", err)
	}
	if err = s.Complete(ctx, retry.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "failed", ErrorCode: "adapter_mismatch"}); err != nil {
		t.Fatal(err)
	}
	terminal := createTest(t, s, "expired-terminal")
	if _, err = s.Action(ctx, terminal.ID, "cancel", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	unknown := createTest(t, s, "retained-unknown")
	claim, err = s.Claim(ctx, "retention-worker")
	if err != nil || claim == nil {
		t.Fatal("claim", err)
	}
	if err = s.Progress(ctx, unknown.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, unknown.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "reconciling"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, "INSERT INTO admin_decisions(job_id,note,created_at) VALUES($1,$2,$3)", unknown.ID, "测试维护保留期", old); err != nil {
		t.Fatal(err)
	}

	// 30 天保留任务日志及已终结正文，90 天保留管理员决定。
	expired := now.Add(-30*24*time.Hour - time.Hour)
	s.now = func() time.Time { return expired }
	recentTerminal := createTest(t, s, "thirty-day-terminal")
	if _, err = s.Action(ctx, recentTerminal.ID, "cancel", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	recent := now.Add(-29 * 24 * time.Hour)
	s.now = func() time.Time { return recent }
	retainedTerminal := createTest(t, s, "within-retention")
	if _, err = s.Action(ctx, retainedTerminal.ID, "cancel", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, "INSERT INTO admin_decisions(job_id,note,created_at) VALUES($1,$2,$3)", unknown.ID, "保留期限内的操作审计", now.Add(-89*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{recentTerminal.ID, retainedTerminal.ID, unknown.ID} {
		if _, err := s.pool.Exec(ctx, "UPDATE jobs SET record=jsonb_set(record,'{platform_markdown}',to_jsonb($2::text)) WHERE id=$1", id, "已转存的图文正文"); err != nil {
			t.Fatal(err)
		}
	}

	s.now = func() time.Time { return now }
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, retry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.RetryAllowed || got.Markdown != retry.Markdown {
		t.Fatal("maintenance discarded a retryable immutable snapshot")
	}
	ended, err := s.Get(ctx, terminal.ID)
	if err != nil || ended.Markdown != "" || ended.RetryAllowed {
		t.Fatal("terminal snapshot was not expired", err)
	}
	unresolved, err := s.Get(ctx, unknown.ID)
	if err != nil || unresolved.Markdown != unknown.Markdown || unresolved.PlatformMarkdown == "" {
		t.Fatal("unknown snapshot was discarded", err)
	}
	cleared, err := s.Get(ctx, recentTerminal.ID)
	if err != nil || cleared.Markdown != "" || cleared.PlatformMarkdown != "" {
		t.Fatal("terminal content exceeded 30-day retention", err)
	}
	kept, err := s.Get(ctx, retainedTerminal.ID)
	if err != nil || kept.Markdown != retainedTerminal.Markdown || kept.PlatformMarkdown == "" {
		t.Fatal("terminal content expired before 30 days", err)
	}

	var logs, decisions int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM logs").Scan(&logs); err != nil {
		t.Fatal(err)
	}
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM admin_decisions").Scan(&decisions); err != nil {
		t.Fatal(err)
	}
	if logs != 2 || decisions != 1 {
		t.Fatalf("retention did not expire logs/audit: %d/%d", logs, decisions)
	}
	// 人工结束未知任务解除账号阻塞后，原失败任务仍可安全重试完整快照。
	if err = s.WorkerHeartbeat(ctx, "retention-worker", true, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Action(ctx, unknown.ID, "resolve", ActionInput{ConfirmedBrowserStopped: true, Note: "保留可能存在的草稿"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Action(ctx, retry.ID, "retry", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	claim, err = s.Claim(ctx, "retention-worker")
	if err != nil || claim == nil {
		t.Fatal("retry claim", err)
	}
	if claim.Job.ID != retry.ID || claim.Job.Markdown != retry.Markdown {
		t.Fatal("retry claimed an empty or changed snapshot")
	}
}
