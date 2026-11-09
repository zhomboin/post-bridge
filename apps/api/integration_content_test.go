package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIntegrationSnapshotFingerprintAndCapability(t *testing.T) {
	snapshot := IntegrationSnapshot{
		Title:      "外部来源文章标题",
		Body:       "# 标题\n\n正文",
		BodyFormat: "markdown",
		Tags:       []string{},
	}
	got, err := IntegrationContentFingerprint(snapshot)
	if err != nil || len(got) != 64 {
		t.Fatalf("fingerprint: %q %v", got, err)
	}
	changed := snapshot
	changed.Body += "变化"
	other, _ := IntegrationContentFingerprint(changed)
	if got == other {
		t.Fatal("changed content shared fingerprint")
	}
	snapshot.OriginalURL = "https://blog.example.test/blog/abcdef"
	same, _ := IntegrationContentFingerprint(snapshot)
	if same != got {
		t.Fatal("display link changed content fingerprint")
	}
	if err := validateIntegrationSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot.Body = "<Widget />"
	if err := validateIntegrationSnapshot(snapshot); err == nil {
		t.Fatal("MDX component accepted")
	}
	snapshot.Body = "![图](https://images.example.test/image.png)"
	if err := validateIntegrationSnapshot(snapshot); err == nil {
		t.Fatal("unsupported image accepted")
	}
	snapshot.Body = "```tsx\n<Widget />\n```"
	if err := validateIntegrationSnapshot(snapshot); err != nil {
		t.Fatal("code example rejected", err)
	}
	snapshot.BodyFormat = "mdx"
	if err := validateIntegrationSnapshot(snapshot); err == nil {
		t.Fatal("unsupported format advertised")
	}
}

func integrationTestHandler(t *testing.T) (*handler, *Store) {
	t.Helper()
	s := testStore(t)
	h, err := NewHandler(context.Background(), Config{
		Store:                  s,
		AdminUsername:          "admin",
		AdminPassword:          "private-test-password",
		WorkerToken:            "private-test-worker-token-32-characters",
		Origin:                 "https://bridge.example.test",
		IntegrationMasterKey:   strings.Repeat("12", 32),
		IntegrationEnvironment: "test",
		IntegrationServiceID:   "bridge",
	})
	if err != nil {
		t.Fatal(err)
	}
	return h.(*handler), s
}

func integrationSeedClient(t *testing.T, h *handler) IntegrationClient {
	t.Helper()
	ctx := context.Background()
	// Metadata is seeded directly so content tests isolate the content lifecycle from enrollment HTTP tests.
	var client IntegrationClient
	encoded := []byte(`{"id":"content-client","name":"测试内容来源","source_id":"cms","environment":"test","service_id":"bridge","status":"active","scopes":["targets:read","preparations:write","preparations:read","distributions:write","distributions:read","source-events:write"],"accounts":["csdn-main"],"operations":["save_draft"],"grant_version":1,"expires_at":"2099-01-01T00:00:00Z"}`)
	if err := json.Unmarshal(encoded, &client); err != nil {
		t.Fatal(err)
	}
	if err := seedIntegrationClient(ctx, h.integrations, client); err != nil {
		t.Fatal(err)
	}
	client, err := h.integrations.Client(ctx, client.ID)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestIntegrationPreparationConfirmationAndAtomicDistribution(t *testing.T) {
	h, s := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{
		Title:      "外部来源文章标题",
		Body:       "# 标题\n\n正文",
		BodyFormat: "markdown",
		Tags:       []string{},
	}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{
		RequestID:              "prepare-1",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant-1",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	draft, created, err := h.prepareIntegration(ctx, client, input)
	if err != nil || !created {
		t.Fatalf("prepare %v", err)
	}
	again, created, err := h.prepareIntegration(ctx, client, input)
	if err != nil || created || again.ID != draft.ID {
		t.Fatalf("prepare idempotency %v", err)
	}
	conflict := input
	conflict.Snapshot.Body += "修改"
	if _, _, err = h.prepareIntegration(ctx, client, conflict); err == nil {
		t.Fatal("idempotency conflict accepted")
	}
	confirmed, err := h.confirmIntegrationPreparation(ctx, draft.ID, draft.Revision)
	if err != nil || !confirmed.Confirmed {
		t.Fatalf("confirm %v", err)
	}
	if _, err = h.confirmIntegrationPreparation(ctx, draft.ID, draft.Revision+1); err == nil {
		t.Fatal("stale confirmation accepted")
	}
	// 提交只使用已确认的不可变内容与本地授权。

	submit := IntegrationSubmitInput{
		RequestID:               "dispatch-1",
		SourceID:                "cms",
		ArticleID:               "article-1",
		SourceVersion:           1,
		StateSeq:                1,
		ContentFingerprint:      fp,
		PreparationID:           draft.ID,
		DraftRevisionIDs:        confirmed.DraftRevisionIDs,
		ConfirmationFingerprint: confirmed.ConfirmationFingerprint,
		Targets:                 input.Targets,
	}
	distribution, created, err := h.commitIntegrationDistribution(ctx, client, submit)
	if err != nil || !created || len(distribution.JobIDs) != 1 {
		t.Fatalf("submit %+v %v", distribution, err)
	}
	dupe, created, err := h.commitIntegrationDistribution(ctx, client, submit)
	if err != nil || created || dupe.ID != distribution.ID {
		t.Fatalf("submit duplicate %v", err)
	}
	job, err := s.Get(ctx, distribution.JobIDs[0])
	if err != nil || job.Markdown != snapshot.Body || job.IntegrationDistributionID != distribution.ID {
		t.Fatalf("job not atomically linked %+v %v", job, err)
	}
	changedOperation := submit
	changedOperation.RequestID = "dispatch-2"
	changedOperation.Targets = []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "publish"}}
	if _, _, err = h.commitIntegrationDistribution(ctx, client, changedOperation); err == nil {
		t.Fatal("operation upgraded")
	}
	// Reusing a confirmed preparation cannot create a second remote copy with a new request ID.
	submit.RequestID = "dispatch-another"
	if _, _, err = h.commitIntegrationDistribution(ctx, client, submit); err == nil {
		t.Fatal("confirmed draft reused")
	}
}

func TestIntegrationConcurrentPrepareAndLifecycleOrdering(t *testing.T) {
	h, s := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{Title: "外部来源文章标题", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{
		RequestID:              "parallel",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant-1",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, _, err := h.prepareIntegration(ctx, client, input)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- p.ID
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first != "" && id != first {
			t.Fatal("duplicate preparation")
		}
		first = id
	}
	event := IntegrationSourceEvent{
		EventID:            "private-2",
		SourceID:           "cms",
		ArticleID:          "article-1",
		StateSeq:           2,
		SourceVersion:      2,
		Type:               "private",
		Status:             "private",
		AuthorizationValid: false,
	}
	applied, err := h.applyIntegrationEvent(ctx, client, event)
	if err != nil || !applied {
		t.Fatalf("private event %v", err)
	}
	applied, err = h.applyIntegrationEvent(ctx, client, event)
	if err != nil || applied {
		t.Fatalf("duplicate event %v", err)
	}
	old := event
	old.EventID = "published-1"
	old.StateSeq = 1
	old.Type = "published"
	old.Status = "published"
	old.AuthorizationValid = true
	old.ContentFingerprint = fp
	applied, err = h.applyIntegrationEvent(ctx, client, old)
	if err != nil || applied {
		t.Fatalf("old event %v", err)
	}
	if _, err = h.confirmIntegrationPreparation(ctx, first, 1); err == nil {
		t.Fatal("private draft confirmed")
	}
	if _, _, err = h.prepareIntegration(ctx, client, input); err == nil {
		t.Fatal("stale authorization restored")
	}
}

func TestIntegrationAnonymousAndDisabledEndpoints(t *testing.T) {
	h, _ := integrationTestHandler(t)
	for _, path := range []string{"/api/integrations/v1/targets", "/api/integrations/v1/preparations/not-found", "/api/integrations/v1/distributions/not-found"} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "https://bridge.example.test"+path, nil)
		h.ServeHTTP(rr, req)
		if rr.Code != 401 {
			t.Fatal(fmt.Sprintf("%s anonymous returned %d", path, rr.Code))
		}
		if strings.Contains(rr.Body.String(), "secret") {
			t.Fatal("secret in error")
		}
	}
}

func TestIntegrationSourceRebindingBlocksInflightRequests(t *testing.T) {
	h, s := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	ctx := context.Background()
	snap := IntegrationSnapshot{Title: "来源隔离测试文章", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snap)
	in := IntegrationPrepareInput{
		RequestID:              "rebind",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snap,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	prep, _, err := h.prepareIntegration(ctx, client, in)
	if err != nil {
		t.Fatal(err)
	}
	changed := client
	changed.SourceID = "other-source"
	raw, _ := json.Marshal(changed)
	if _, err = s.pool.Exec(ctx, "UPDATE integration_clients SET metadata=$2 WHERE id=$1", client.ID, raw); err != nil {
		t.Fatal(err)
	}
	in.RequestID = "inflight-prepare"
	if _, _, err = h.prepareIntegration(ctx, client, in); err == nil {
		t.Fatal("inflight preparation registered under rebound source")
	}
	if _, err = h.confirmIntegrationPreparation(ctx, prep.ID, prep.Revision); err == nil {
		t.Fatal("old source preparation confirmed after rebinding")
	}
	event := IntegrationSourceEvent{
		EventID:       "inflight-event",
		SourceID:      "cms",
		ArticleID:     "article-1",
		StateSeq:      3,
		SourceVersion: 3,
		Type:          "private",
		Status:        "private",
	}
	if _, err = h.applyIntegrationEvent(ctx, client, event); err == nil {
		t.Fatal("old in-flight source event accepted after rebinding")
	}
}
func TestIntegrationVerifiedStateRejectsOlderNotification(t *testing.T) {
	h, s := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	ctx := context.Background()
	snap := IntegrationSnapshot{Title: "来源水位测试文章", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snap)
	in := IntegrationPrepareInput{
		RequestID:              "watermark",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          10,
		StateSeq:               10,
		AuthorizationID:        "grant",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snap,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	prep, _, err := h.prepareIntegration(ctx, client, in)
	if err != nil {
		t.Fatal(err)
	}
	prep, err = h.confirmIntegrationPreparation(ctx, prep.ID, prep.Revision)
	if err != nil {
		t.Fatal(err)
	}

	submit := IntegrationSubmitInput{
		RequestID:               "watermark-submit",
		SourceID:                "cms",
		ArticleID:               in.ArticleID,
		SourceVersion:           10,
		StateSeq:                10,
		ContentFingerprint:      fp,
		PreparationID:           prep.ID,
		DraftRevisionIDs:        prep.DraftRevisionIDs,
		ConfirmationFingerprint: prep.ConfirmationFingerprint,
		Targets:                 in.Targets,
	}
	d, _, err := h.commitIntegrationDistribution(ctx, client, submit)
	if err != nil {
		t.Fatal(err)
	}
	event := IntegrationSourceEvent{
		EventID:       "late-private",
		SourceID:      "cms",
		ArticleID:     in.ArticleID,
		SourceVersion: 7,
		StateSeq:      7,
		Type:          "private",
		Status:        "private",
	}
	applied, err := h.applyIntegrationEvent(ctx, client, event)
	if err != nil || applied {
		t.Fatalf("older notification applied: %t %v", applied, err)
	}
	job, _ := s.Get(ctx, d.JobIDs[0])
	if job.Status != "queued" {
		t.Fatal("older notification cancelled newer verified publication")
	}
	event.EventID = "same-state"
	event.StateSeq = 10
	event.SourceVersion = 10
	event.Type = "published"
	event.Status = "published"
	event.ContentFingerprint = fp
	event.AuthorizationValid = true
	applied, err = h.applyIntegrationEvent(ctx, client, event)
	if err != nil || applied {
		t.Fatalf("identical authoritative state conflicted: %t %v", applied, err)
	}
}
