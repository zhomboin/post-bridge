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

func sampleArticles() *ArticleSnapshot {
	return &ArticleSnapshot{Username: "tester", Profile: ArticleProfile{Nickname: "测试作者"}, Counts: ArticleCounts{Total: 2, Published: 1, Draft: 1}, Items: []Article{
		{
			ID:             "101",
			Title:          "已发布测试文章",
			Status:         "published",
			PlatformStatus: "1",
			PostedAt:       "2026-11-04T10:00:00+08:00",
			Type:           "original",
			Views:          12,
			Likes:          2,
			Comments:       1,
			Favorites:      3,
			Exposures:      20,
			CoverURLs:      []string{},
		},
		{
			ID:             "102",
			Title:          "草稿测试文章",
			Status:         "draft",
			PlatformStatus: "2",
			Type:           "unknown",
			CoverURLs:      []string{},
		},
	}, Trend: []ArticleTrend{}}
}
func completeArticles(t *testing.T, s *Store, key string, payload *ArticleSnapshot) Job {
	t.Helper()
	ctx := context.Background()
	j, _, err := s.Create(ctx, CreateInput{RequestID: key, Kind: "sync_articles", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Claim(ctx, "reader")
	if err != nil || c == nil || c.Job.ID != j.ID {
		t.Fatalf("claim: %+v %v", c, err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "checking_login"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Articles: payload}); err != nil {
		t.Fatal(err)
	}
	return j
}
func TestArticleSnapshotValidation(t *testing.T) {
	cases := []struct {
		name  string
		alter func(*ArticleSnapshot)
	}{
		{"错账号", func(v *ArticleSnapshot) { v.Username = "other" }},
		{"重复条目", func(v *ArticleSnapshot) { v.Items[1].ID = v.Items[0].ID }},
		{"数量不完整", func(v *ArticleSnapshot) { v.Counts.Total++ }},
		{"负统计", func(v *ArticleSnapshot) { v.Items[0].Views = -1 }},
		{"状态伪装", func(v *ArticleSnapshot) { v.Items[0].Status = "published"; v.Items[0].PlatformStatus = "99" }},
		{"危险封面", func(v *ArticleSnapshot) { v.Items[0].CoverURLs = []string{"javascript:alert(1)"} }},
		{"错误时间", func(v *ArticleSnapshot) { v.Items[0].PostedAt = "yesterday" }},
	}
	if err := validateArticles(sampleArticles(), "tester"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := sampleArticles()
			tc.alter(v)
			if validateArticles(v, "tester") == nil {
				t.Fatal("invalid payload accepted")
			}
		})
	}
}
func TestArticleReadOnlyLifecycleAndCache(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "sync-1", sampleArticles())
	page, err := s.Articles(ctx, "已发布", "published", 1, 20)
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Snapshot == nil {
		t.Fatalf("page %+v %v", page, err)
	}
	if page.Items[0].BlogURL != "https://blog.csdn.net/tester/article/details/101" || page.Items[0].EditorURL != "https://editor.csdn.net/md/?articleId=101" {
		t.Fatal("unsafe or missing fixed links")
	}
	if _, _, err = s.Create(ctx, CreateInput{RequestID: "unknown", Kind: "read_article", Platform: "csdn", ArticleID: "999"}); err != ErrNotFound {
		t.Fatalf("unknown article: %v", err)
	}
	j, created, err := s.Create(ctx, CreateInput{RequestID: "read-1", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil || !created {
		t.Fatal(err)
	}
	dup, created, err := s.Create(ctx, CreateInput{RequestID: "read-2", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil || created || dup.ID != j.ID {
		t.Fatal("active reads must coalesce", err)
	}
	c, err := s.Claim(ctx, "reader")
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != ErrConflict {
		t.Fatal("read task accepted write checkpoint", err)
	}
	if err = s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	body := &ArticleBody{
		ID:             "102",
		Title:          "正文",
		Markdown:       "# 只读正文",
		HTML:           "<script>unsafe</script>",
		Tags:           []string{},
		Categories:     []string{},
		PlatformStatus: "1",
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Article: body}); err != ErrInvalid {
		t.Fatal("mismatched body id accepted", err)
	}
	body.ID = "101"
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: "wrong", Status: "succeeded", Article: body}); err != ErrConflict {
		t.Fatal("stale lease accepted", err)
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Article: body}); err != nil {
		t.Fatal(err)
	}
	detail, err := s.Article(ctx, "101")
	if err != nil || detail.Body == nil || detail.Body.Markdown != body.Markdown {
		t.Fatalf("detail %+v %v", detail, err)
	}
	job, _ := s.Get(ctx, j.ID)
	if job.ExternalStarted || job.RemoteID != "" || job.Markdown != "" || job.Outcome != "not_submitted" {
		t.Fatal("read result polluted draft semantics")
	}
	completeArticles(t, s, "sync-2", sampleArticles())
	detail, err = s.Article(ctx, "101")
	if err != nil || detail.Body != nil {
		t.Fatal("resync retained stale body", err)
	}
}
func TestArticleFailedSyncRetainsSnapshotAndRejectsWrongAccount(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "initial", sampleArticles())
	j, _, _ := s.Create(ctx, CreateInput{RequestID: "next", Kind: "sync_articles", Platform: "csdn"})
	c, _ := s.Claim(ctx, "reader")
	if err := s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", Articles: sampleArticles()}); err != ErrInvalid {
		t.Fatal("failed result accepted payload", err)
	}
	if err := s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "failed", ErrorCode: "article_read_unavailable"}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.Articles(ctx, "", "", 1, 20)
	if p.Total != 2 || p.Snapshot == nil {
		t.Fatal("failed sync erased snapshot")
	}
	_, _, err := s.Create(ctx, CreateInput{RequestID: "late", Kind: "sync_articles", Platform: "csdn"})
	if err != nil {
		t.Fatal(err)
	}
	c, _ = s.Claim(ctx, "reader")
	s.Progress(ctx, c.Job.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"})
	if _, err = s.pool.Exec(ctx, "UPDATE account SET username='other' WHERE id='csdn-main'"); err != nil {
		t.Fatal(err)
	}
	if err = s.Complete(ctx, c.Job.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Articles: sampleArticles()}); err != ErrConflict {
		t.Fatal("old account late result accepted", err)
	}
	p, err = s.Articles(ctx, "", "", 1, 20)
	if err != nil || p.Total != 0 || p.Snapshot != nil {
		t.Fatal("account data leaked", err)
	}
}
func TestArticleHTTPPermissionsAndReadContracts(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{
		Store:         s,
		AdminUsername: "admin",
		AdminPassword: "test-password-long",
		WorkerToken:   strings.Repeat("w", 32),
		Origin:        "http://localhost",
	})
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("a", 64)
	csrfToken := "article-csrf"
	s.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin',$2,$3)", hashToken(token), csrfToken, time.Now().Add(time.Hour))
	request := func(method, path, body string, auth, csrf bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if auth {
			req.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
		}
		req.Header.Set("Origin", "http://localhost")
		req.Header.Set("Content-Type", "application/json")
		if csrf {
			req.Header.Set("X-CSRF-Token", csrfToken)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := request("GET", "/api/account/articles", "", false, false); rec.Code != 401 {
		t.Fatal(rec.Code)
	}
	if rec := request("POST", "/api/account/articles/sync", `{"request_id":"http-sync"}`, true, false); rec.Code != 403 {
		t.Fatal(rec.Code)
	}
	if rec := request("GET", "/api/account/articles?status=made-up", "", true, false); rec.Code != 400 {
		t.Fatal(rec.Code)
	}
	rec := request("GET", "/api/account/articles", "", true, false)
	var p ArticlePage
	json.Unmarshal(rec.Body.Bytes(), &p)
	if rec.Code != 200 || p.Snapshot != nil || p.Items == nil {
		t.Fatal(rec.Code, rec.Body.String())
	}
	rec = request("POST", "/api/account/articles/sync", `{"request_id":"http-sync"}`, true, true)
	if rec.Code != 202 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if rec := request("POST", "/api/account/articles/1/delete", "{}", true, true); rec.Code != 404 {
		t.Fatal("unexpected mutation endpoint", rec.Code)
	}
}
func TestArticleReadPayloadFencingAndRequestReuse(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "initial-reads", sampleArticles())
	j, _, err := s.Create(ctx, CreateInput{RequestID: "read-owner", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil {
		t.Fatal(err)
	}
	alias, created, err := s.Create(ctx, CreateInput{RequestID: "read-alias", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil || created || alias.ID != j.ID {
		t.Fatal("coalesce failed", err)
	}
	c, _ := s.Claim(ctx, "reader")
	s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"})
	body := &ArticleBody{
		ID:             "101",
		Title:          "正文",
		PlatformStatus: "1",
		Markdown:       "正文",
		Tags:           []string{},
		Categories:     []string{},
	}
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Article: body}); err != nil {
		t.Fatal(err)
	}
	repeated, created, err := s.Create(ctx, CreateInput{RequestID: "read-alias", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil || created || repeated.ID != j.ID {
		t.Fatal("coalesced request lost idempotency", err)
	}
	if _, _, err = s.Create(ctx, CreateInput{RequestID: "read-alias", Kind: "read_article", Platform: "csdn", ArticleID: "102"}); err != ErrConflict {
		t.Fatal("changed coalesced request accepted", err)
	}
	j, _, err = s.Create(ctx, CreateInput{RequestID: "cancel-read", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil {
		t.Fatal(err)
	}
	c, _ = s.Claim(ctx, "reader")
	s.Progress(ctx, j.ID, ProgressInput{LeaseToken: c.LeaseToken, Stage: "verifying"})
	s.Action(ctx, j.ID, "cancel", ActionInput{})
	body.Markdown = "取消后的正文不得写入"
	if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "succeeded", Article: body}); err != ErrConflict {
		t.Fatal("cancelled payload accepted", err)
	}
	detail, _ := s.Article(ctx, "101")
	if detail.Body.Markdown == body.Markdown {
		t.Fatal("cancelled result replaced cached body")
	}
}
func TestArticleSignedChangesAndUnknownStatus(t *testing.T) {
	v := sampleArticles()
	negative := int64(-2)
	quality := 82.5
	v.Stats.YesterdayFollowers = &negative
	v.Stats.YesterdayFavorites = &negative
	v.Items[0].QualityScore = &quality
	v.Trend = []ArticleTrend{{Date: "2026-11-03", Followers: &negative}}
	if err := validateArticles(v, "tester"); err != nil {
		t.Fatal("valid signed changes or decimal quality rejected", err)
	}
	v.Items[0].PlatformStatus = "999"
	v.Items[0].Status = "unknown"
	v.Counts.Published--
	v.Counts.Unknown++
	if err := validateArticles(v, "tester"); err != nil {
		t.Fatal("unknown platform state rejected", err)
	}
}
func TestArticleAccountSwitchRejectsFailureAndHeartbeat(t *testing.T) {
	for _, status := range []string{"waiting_user", "failed"} {
		t.Run(status, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			j, _, err := s.Create(ctx, CreateInput{RequestID: "old-account", Kind: "sync_articles", Platform: "csdn"})
			if err != nil {
				t.Fatal(err)
			}
			c, _ := s.Claim(ctx, "reader")
			s.pool.Exec(ctx, "UPDATE account SET username='new-account',status='connected' WHERE id='csdn-main'")
			if err = s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: status, ErrorCode: "needs_login"}); err != ErrConflict {
				t.Fatal("old account failure accepted", err)
			}
			if _, err = s.Heartbeat(ctx, j.ID, c.LeaseToken); err != ErrConflict {
				t.Fatal("old account lease renewed", err)
			}
			account, _ := s.Account(ctx)
			if account.Status != "connected" {
				t.Fatal("old task changed new account")
			}
			s.now = func() time.Time { return time.Now().UTC().Add(61 * time.Second) }
			if _, err = s.Claim(ctx, "reader-new"); err != nil {
				t.Fatal(err)
			}
			old, _ := s.Get(ctx, j.ID)
			if old.Status != "failed" || old.RetryAllowed {
				t.Fatal("old account task did not safely finish", old.Status)
			}
		})
	}
}
func TestArticleCancelLoginRaceAndWaitingCancellation(t *testing.T) {
	for _, before := range []bool{true, false} {
		t.Run(map[bool]string{true: "before", false: "after"}[before], func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			j, _, _ := s.Create(ctx, CreateInput{RequestID: "waiting-read", Kind: "sync_articles", Platform: "csdn"})
			c, _ := s.Claim(ctx, "reader")
			if before {
				if _, err := s.Action(ctx, j.ID, "cancel", ActionInput{}); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.Complete(ctx, j.ID, CompleteInput{LeaseToken: c.LeaseToken, Status: "waiting_user", ErrorCode: "needs_login"}); err != nil {
				t.Fatal(err)
			}
			if !before {
				if _, err := s.Action(ctx, j.ID, "cancel", ActionInput{}); err != nil {
					t.Fatal("cannot cancel waiting read", err)
				}
			}
			got, _ := s.Get(ctx, j.ID)
			if got.Status != "cancelled" {
				t.Fatal("cancelled read stuck", got.Status)
			}
			next, created, err := s.Create(ctx, CreateInput{RequestID: "new-read", Kind: "sync_articles", Platform: "csdn"})
			if err != nil || !created || next.ID == j.ID {
				t.Fatal("cancelled read still coalesced", err)
			}
		})
	}
}
func TestArticleProcessesUseReadObjects(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	completeArticles(t, s, "sync-process", sampleArticles())
	j, _, err := s.Create(ctx, CreateInput{RequestID: "read-process", Kind: "read_article", Platform: "csdn", ArticleID: "101"})
	if err != nil {
		t.Fatal(err)
	}
	f := ProcessFilter{From: time.Now().Add(-time.Hour), To: time.Now().Add(time.Hour), Page: 1, Size: 50}
	f.Kind = "sync_articles"
	items, total, err := s.Processes(ctx, f)
	if err != nil || total != 1 || items[0].ObjectType != "account" || items[0].ObjectID != "csdn-main" {
		t.Fatal("sync process is not account", items, err)
	}
	f.Kind = "read_article"
	items, total, err = s.Processes(ctx, f)
	if err != nil || total != 1 || items[0].ObjectType != "article" || items[0].ObjectID != "101" || items[0].ObjectName != "已发布测试文章" || items[0].ID != j.ID {
		t.Fatal("body process lost article identity", items, err)
	}
}
