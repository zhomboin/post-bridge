package bridge

import (
	"context"
	"encoding/json"
	"testing"
)

func syntheticContentAdapter() contentAdapter {
	return contentAdapter{ContentPlatform: ContentPlatform{
		ID: "synthetic", Label: "合成平台", IDPattern: `^post:[A-Za-z0-9_/-]+$`, UsernamePattern: `^author-[a-z]+$`, UserIDPattern: `^native-[a-z]+$`,
		SyncJob: "sync_contents", ReadJob: "read_content", SyncResult: "contents", ReadResult: "content", IdentityResult: "content_identity", ReadStatuses: []string{"published"},
		Capabilities: map[string]ContentCapability{"list": {Enabled: true, Kinds: []string{"document"}}, "body": {Enabled: true, Formats: []string{"text"}}},
	}, ValidateItem: func(item ContentItem) error {
		status := "unknown"
		if item.PlatformStatus == "LIVE" {
			status = "published"
		}
		if item.Status != status {
			return ErrInvalid
		}
		return nil
	}}
}
func syntheticContentSnapshot() *ContentSnapshot {
	return &ContentSnapshot{Identity: ContentIdentity{Username: "author-test", UserID: "native-test"}, Scope: "all", Complete: true, Items: []ContentItem{
		{ID: "post:alpha/one", Title: "合成文档一", Status: "published", PlatformStatus: "LIVE", PostedAt: "2026-11-09T00:00:00Z", Kind: "document", CoverURLs: []string{}, Metrics: map[string]ContentMetric{"views": {Value: nil, Unit: "count"}}, Extensions: json.RawMessage(`{}`)},
		{ID: "post:beta", Title: "合成文档二", Status: "unknown", PlatformStatus: "UNRECOGNIZED", Kind: "document", CoverURLs: []string{}, Metrics: map[string]ContentMetric{}, Extensions: json.RawMessage(`{}`)},
	}, Extensions: json.RawMessage(`{}`)}
}
func syntheticContentStore(t *testing.T) *Store {
	t.Helper()
	s := testStore(t)
	adapters := []contentAdapter{}
	for _, a := range s.contentRegistry().adapters {
		adapters = append(adapters, a)
	}
	adapters = append(adapters, syntheticContentAdapter())
	s.contents = newContentRegistry(adapters...)
	if err := s.ConfigurePlatformAccounts(context.Background(), []PlatformAccountConfig{{ID: "synthetic-account", Platform: "synthetic", Username: "author-test", UserID: "native-test", DisplayName: "合成平台账号"}}); err != nil {
		t.Fatal(err)
	}
	return s
}
func claimContent(t *testing.T, s *Store, key string) *Claim {
	t.Helper()
	ctx := context.Background()
	job, _, err := s.CreateContentJob(ctx, "synthetic-account", "list", "", key)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := s.ClaimForAccount(ctx, "synthetic-worker", "synthetic-account")
	if err != nil || claim == nil || claim.Job.ID != job.ID {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	for _, stage := range []string{"checking_login", "verifying"} {
		if err = s.Progress(ctx, job.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: stage}); err != nil {
			t.Fatal(err)
		}
	}
	return claim
}
func completeContent(t *testing.T, s *Store, key string, snapshot *ContentSnapshot) {
	t.Helper()
	claim := claimContent(t, s, key)
	if err := s.Complete(context.Background(), claim.Job.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "succeeded", Contents: snapshot, ContentIdentity: &snapshot.Identity}); err != nil {
		t.Fatal(err)
	}
}

func TestContentPlatformNeutralValidation(t *testing.T) {
	a := syntheticContentAdapter()
	snapshot := syntheticContentSnapshot()
	if err := a.validateSnapshot(snapshot, snapshot.Identity); err != nil {
		t.Fatal(err)
	}
	for _, alter := range []func(*ContentSnapshot){
		func(v *ContentSnapshot) { v.Items[1].ID = v.Items[0].ID },
		func(v *ContentSnapshot) { v.Identity.UserID = "wrong" },
		func(v *ContentSnapshot) { v.Items[0].Status = "unknown" },
		func(v *ContentSnapshot) { v.Items[0].Kind = "article" },
		func(v *ContentSnapshot) { v.Items[0].CoverURLs = []string{"https://unapproved.invalid/image"} },
		func(v *ContentSnapshot) { v.Scope = "filtered" },
		func(v *ContentSnapshot) {
			v.Items[0].Metrics["views"] = ContentMetric{BeginAt: "yesterday", EndAt: "today"}
		},
		func(v *ContentSnapshot) { v.Extensions = json.RawMessage(`{"unvalidated":true}`) },
	} {
		v := syntheticContentSnapshot()
		alter(v)
		if a.validateSnapshot(v, snapshot.Identity) == nil {
			t.Fatal("invalid content accepted")
		}
	}
	body := &ContentBody{ID: snapshot.Items[0].ID, Format: "text", Text: "合成正文", Images: []string{}, Tags: []string{}, Extensions: json.RawMessage(`{}`)}
	if a.validateContentBody(body, body.ID) != nil {
		t.Fatal("opaque id or text body rejected")
	}
	body.Format = "markdown"
	if a.validateContentBody(body, body.ID) == nil {
		t.Fatal("unsupported format accepted")
	}
}

func TestContentSyntheticLifecyclePartialSyncAndFencing(t *testing.T) {
	s := syntheticContentStore(t)
	ctx := context.Background()
	snapshot := syntheticContentSnapshot()
	c := claimContent(t, s, "first")
	alias, created, err := s.CreateContentJob(ctx, "synthetic-account", "list", "", "alias")
	if err != nil || created || alias.ID != c.Job.ID {
		t.Fatal("task coalescing", err)
	}
	bad := CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Contents: snapshot, ContentIdentity: &snapshot.Identity, Article: &ArticleBody{}}
	if s.Complete(ctx, c.Job.ID, bad) != ErrInvalid {
		t.Fatal("mixed platform payload accepted")
	}
	bad.Article = nil
	if err = s.Complete(ctx, c.Job.ID, bad); err != nil {
		t.Fatal(err)
	}
	page, err := s.Contents(ctx, "synthetic-account", "合成", "", 1, 1)
	if err != nil || page.Total != 2 || len(page.Items) != 1 || page.Items[0].Metrics["views"].Value != nil {
		t.Fatalf("page: %+v %v", page, err)
	}
	if _, _, err = s.CreateContentJob(ctx, "synthetic-account", "body", "post:beta", "unknown-body"); err != ErrConflict {
		t.Fatal("unknown status read", err)
	}
	job, _, err := s.CreateContentJob(ctx, "synthetic-account", "body", snapshot.Items[0].ID, "body")
	if err != nil {
		t.Fatal(err)
	}
	claim, err := s.ClaimForAccount(ctx, "synthetic-worker", "synthetic-account")
	if err != nil || claim == nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"checking_login", "verifying"} {
		if err = s.Progress(ctx, job.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: stage}); err != nil {
			t.Fatal(err)
		}
	}
	body := &ContentBody{ID: snapshot.Items[0].ID, Format: "text", Text: "正文保留", Images: []string{}, Tags: []string{}, Extensions: json.RawMessage(`{}`)}
	if err = s.Complete(ctx, job.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "succeeded", Content: body, ContentIdentity: &snapshot.Identity}); err != nil {
		t.Fatal(err)
	}
	partial := syntheticContentSnapshot()
	partial.Complete = false
	partial.Items = partial.Items[:1]
	partial.Items[0].Title = "更新的标题"
	completeContent(t, s, "partial", partial)
	page, err = s.Contents(ctx, "synthetic-account", "", "", 1, 20)
	if err != nil || page.Total != 2 || page.Snapshot.Complete {
		t.Fatal("partial sync removed data", err)
	}
	detail, err := s.Content(ctx, "synthetic-account", body.ID)
	if err != nil || detail.Body == nil || detail.Body.Text != body.Text {
		t.Fatal("body retention", err)
	}
	failed := claimContent(t, s, "failed")
	if err = s.Complete(ctx, failed.Job.ID, CompleteInput{LeaseToken: failed.LeaseToken, Status: "failed", ErrorCode: "network_error"}); err != nil {
		t.Fatal(err)
	}
	page, err = s.Contents(ctx, "synthetic-account", "", "", 2, 1)
	if err != nil || page.Total != 2 || len(page.Items) != 1 {
		t.Fatal("failed sync retention", err)
	}
	partial.Complete = true
	completeContent(t, s, "complete", partial)
	page, err = s.Contents(ctx, "synthetic-account", "", "", 1, 20)
	if err != nil || page.Total != 1 {
		t.Fatal("complete replacement", err)
	}
	if _, _, err = s.CreateContentJob(ctx, "synthetic-account", "publish", "", "publish"); err != ErrInvalid {
		t.Fatal("write capability escalation", err)
	}
	if _, err = s.Content(ctx, "csdn-main", body.ID); err != ErrInvalid {
		t.Fatal("cross platform id", err)
	}
	stale := claimContent(t, s, "stale")
	if _, err = s.pool.Exec(ctx, "UPDATE account SET connection_version=connection_version+1 WHERE id='synthetic-account'"); err != nil {
		t.Fatal(err)
	}
	if s.Complete(ctx, stale.Job.ID, CompleteInput{LeaseToken: stale.LeaseToken, Status: "succeeded", Contents: snapshot, ContentIdentity: &snapshot.Identity}) != ErrConflict {
		t.Fatal("stale connection accepted")
	}
}

func TestContentLegacyProjectionAndBackfill(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "legacy", sampleArticles())
	page, err := s.Contents(ctx, "csdn-main", "", "published", 1, 20)
	if err != nil || page.Total != 1 || page.Items[0].ID != "101" {
		t.Fatal("article projection", err)
	}
	if _, err = s.pool.Exec(ctx, "DELETE FROM content_snapshots WHERE account_id='csdn-main'"); err != nil {
		t.Fatal(err)
	}
	page, err = s.Contents(ctx, "csdn-main", "", "", 1, 20)
	if err != nil || page.Total != 2 {
		t.Fatal("backfill", err)
	}
	configureXHS(t, s)
	claim := claimNotes(t, s, "notes")
	if err = s.Complete(ctx, claim.Job.ID, notesResult(claim, publishedNoteSnapshot())); err != nil {
		t.Fatal(err)
	}
	page, err = s.Contents(ctx, "xhs-main", "", "", 1, 20)
	if err != nil || page.Total != 1 || page.Items[0].Kind != "image" {
		t.Fatal("note projection", err)
	}
	if _, err = s.pool.Exec(ctx, "DELETE FROM content_snapshots WHERE account_id='xhs-main'"); err != nil {
		t.Fatal(err)
	}
	page, err = s.Contents(ctx, "xhs-main", "", "", 1, 20)
	if err != nil || page.Total != 1 {
		t.Fatal("note backfill", err)
	}
}
