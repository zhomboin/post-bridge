package bridge

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestContentPartialCapacityAndRollback(t *testing.T) {
	s := syntheticContentStore(t)
	ctx := context.Background()
	snapshot := syntheticContentSnapshot()
	completeContent(t, s, "seed-limit", snapshot)
	raw, _ := json.Marshal(snapshot.Items[0])
	if _, err := s.pool.Exec(ctx, `INSERT INTO contents(account_id,id,record) SELECT 'synthetic-account','post:limit-'||n,jsonb_set($1::jsonb,'{id}',to_jsonb('post:limit-'||n)) FROM generate_series(1,1998) n`, raw); err != nil {
		t.Fatal(err)
	}
	partial := syntheticContentSnapshot()
	partial.Complete = false
	partial.Items[0].Title = "不应提交的改动"
	partial.Items[1].ID = "post:overflow"
	c := claimContent(t, s, "overflow")
	if err := s.Complete(ctx, c.Job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Contents: partial, ContentIdentity: &partial.Identity}); err != ErrInvalid {
		t.Fatal("cumulative limit", err)
	}
	page, err := s.Contents(ctx, "synthetic-account", "", "", 1, 20)
	if err != nil || page.Total != 2000 {
		t.Fatal("rollback count", page.Total, err)
	}
	detail, err := s.Content(ctx, "synthetic-account", snapshot.Items[0].ID)
	if err != nil || detail.Item.Title != snapshot.Items[0].Title {
		t.Fatal("partial write escaped transaction", err)
	}
}

func TestContentCancelledAndInvalidStageCannotReplaceSnapshot(t *testing.T) {
	s := syntheticContentStore(t)
	ctx := context.Background()
	snapshot := syntheticContentSnapshot()
	completeContent(t, s, "cancel-seed", snapshot)
	c := claimContent(t, s, "cancel-sync")
	if _, err := s.Action(ctx, c.Job.ID, "cancel", ActionInput{}); err != nil {
		t.Fatal(err)
	}
	snapshot.Items[0].Title = "取消后不应保存"
	if err := s.Complete(ctx, c.Job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Contents: snapshot, ContentIdentity: &snapshot.Identity}); err != ErrConflict {
		t.Fatal("cancelled snapshot accepted", err)
	}
	if err := s.Complete(ctx, c.Job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "cancelled"}); err != nil {
		t.Fatal(err)
	}
	job, _, err := s.CreateContentJob(ctx, "synthetic-account", "list", "", "invalid-stage")
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.ClaimForAccount(ctx, "synthetic-worker", "synthetic-account")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, job.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Contents: snapshot, ContentIdentity: &snapshot.Identity}); err != ErrConflict {
		t.Fatal("unverified snapshot accepted", err)
	}
	detail, err := s.Content(ctx, "synthetic-account", snapshot.Items[0].ID)
	if err != nil || detail.Item.Title == snapshot.Items[0].Title {
		t.Fatal("state failure did not roll back content", err)
	}
}

func TestContentArticleCacheCompatibility(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "cache-seed", sampleArticles())
	job, _, err := s.CreateContentJob(ctx, "csdn-main", "body", "101", "cache-body")
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Claim(ctx, "cache-worker")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, job.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	body := &ArticleBody{ID: "101", Title: "正文", Markdown: "缓存正文", PlatformStatus: "1"}
	if err = s.Complete(ctx, job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Article: body}); err != nil {
		t.Fatal(err)
	}
	detail, err := s.Content(ctx, "csdn-main", "101")
	if err != nil || detail.Body == nil || detail.Body.Tags == nil {
		t.Fatal("cache normalization", err)
	}
	current := s.now()
	s.now = func() time.Time { return current.Add(31 * 24 * time.Hour) }
	detail, err = s.Content(ctx, "csdn-main", "101")
	if err != nil || detail.Body != nil {
		t.Fatal("expired cache visible", err)
	}
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM content_bodies WHERE account_id='csdn-main'").Scan(&count); err != nil || count != 0 {
		t.Fatal("expired cache retained", err)
	}
}

func TestContentListOnlyCapability(t *testing.T) {
	s := syntheticContentStore(t)
	ctx := context.Background()
	completeContent(t, s, "list-only", syntheticContentSnapshot())
	a, _ := s.contents.get("synthetic")
	delete(a.Capabilities, "body")
	s.contents.adapters[a.ID] = a
	if _, err := s.Contents(ctx, "synthetic-account", "", "", 1, 20); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CreateContentJob(ctx, "synthetic-account", "body", "post:alpha/one", "disabled-body"); err != ErrInvalid {
		t.Fatal("missing body capability", err)
	}
	if _, _, err := s.CreateAccountJob(ctx, "synthetic-account", "check_account", "disabled-check"); err != ErrInvalid {
		t.Fatal("missing account check capability", err)
	}
}
