package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func integrationHTTPFixture(t *testing.T) (*handler, IntegrationClient, func(string, string, any, bool) *httptest.ResponseRecorder) {
	t.Helper()
	h, s := integrationTestHandler(t)
	client := integrationSeedClient(t, h)
	var keyID string
	if err := s.pool.QueryRow(context.Background(), "SELECT id FROM integration_keys WHERE client_id=$1", client.ID).Scan(&keyID); err != nil {
		t.Fatal(err)
	}
	secret, err := h.integrations.Secret(context.Background(), keyID)
	if err != nil {
		t.Fatal(err)
	}
	csrf := "content-csrf"
	cookie := strings.Repeat("a", 64)
	if _, err = s.pool.Exec(context.Background(), "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin',$2,$3)", hashToken(cookie), csrf, s.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	call := func(method, path string, body any, admin bool) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, h.origin+path, bytes.NewReader(raw))
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if admin {
			req.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: cookie})
			req.Header.Set("Origin", h.origin)
			req.Header.Set("X-CSRF-Token", csrf)
		} else {
			identity := IntegrationSigningIdentity{ClientID: client.ID, KeyID: keyID, Environment: "test", ServiceID: "bridge"}
			if e := SignIntegrationRequest(req, raw, identity, secret, s.now(), randomToken()); e != nil {
				t.Fatal(e)
			}
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	return h, client, call
}
func TestIntegrationSignedHTTPDraftLifecycle(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	snapshot := IntegrationSnapshot{
		Title:      "来源系统发出的文章",
		Body:       "# 内容\n\n正文",
		BodyFormat: "markdown",
		Tags:       []string{},
	}
	fp, _ := IntegrationContentFingerprint(snapshot)

	prepare := IntegrationPrepareInput{
		RequestID:              "http-prepare",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "preview-grant",
		AuthorizationExpiresAt: h.store.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	rr := call("POST", "/api/integrations/v1/preparations", prepare, false)
	if rr.Code != 201 {
		t.Fatalf("prepare %d %s", rr.Code, rr.Body.String())
	}
	var prep IntegrationPreparation
	if err := json.Unmarshal(rr.Body.Bytes(), &prep); err != nil {
		t.Fatal(err)
	}
	rr = call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": prep.Revision + 1}, true)
	if rr.Code != 409 {
		t.Fatalf("stale revision %d", rr.Code)
	}
	rr = call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": prep.Revision}, true)
	if rr.Code != 200 {
		t.Fatalf("confirm %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &prep); err != nil {
		t.Fatal(err)
	}
	submit := IntegrationSubmitInput{
		RequestID:               "http-distribution",
		SourceID:                "cms",
		ArticleID:               "article-1",
		SourceVersion:           1,
		StateSeq:                1,
		ContentFingerprint:      fp,
		PreparationID:           prep.ID,
		ConfirmationFingerprint: prep.ConfirmationFingerprint,
		DraftRevisionIDs:        prep.DraftRevisionIDs,
		Targets:                 prep.Targets,
	}
	rr = call("POST", "/api/integrations/v1/distributions", submit, false)
	if rr.Code != 202 {
		t.Fatalf("submit %d %s", rr.Code, rr.Body.String())
	}
	var d IntegrationDistribution
	if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.JobIDs) != 1 {
		t.Fatal("missing linked child")
	}
	// 丢失响应后可用原请求安全恢复结果。

	rr = call("POST", "/api/integrations/v1/distributions", submit, false)
	if rr.Code != 200 {
		t.Fatalf("lost response recovery %d %s", rr.Code, rr.Body.String())
	}
	rr = call("GET", "/api/integrations/v1/distributions?request_id="+submit.RequestID, nil, false)
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), d.ID) || strings.Contains(rr.Body.String(), snapshot.Body) {
		t.Fatalf("summary %d %s", rr.Code, rr.Body.String())
	}
	rr = call("GET", "/api/integration-preparations", nil, true)
	if rr.Code != 200 || strings.Contains(rr.Body.String(), "# 内容") {
		t.Fatal("list leaked full article body")
	}
	// A stale or mismatched target cannot reuse the confirmation.
	submit.RequestID = "http-altered"
	submit.Targets[0].Operation = "publish"
	rr = call("POST", "/api/integrations/v1/distributions", submit, false)
	if rr.Code != 410 && rr.Code != 422 && rr.Code != 409 {
		t.Fatalf("unsupported publication %d", rr.Code)
	}
	event := IntegrationSourceEvent{
		EventID:            "http-private",
		SourceID:           "cms",
		ArticleID:          "article-1",
		StateSeq:           3,
		SourceVersion:      3,
		Type:               "private",
		Status:             "private",
		AuthorizationValid: false,
	}
	rr = call("POST", "/api/integrations/v1/source-events", event, false)
	if rr.Code != 200 {
		t.Fatalf("event %d %s", rr.Code, rr.Body.String())
	}
	job, _ := h.store.Get(context.Background(), d.JobIDs[0])
	if job.Status != "cancelled" {
		t.Fatalf("private source job continued %+v", job)
	}
}
func TestIntegrationSignedHTTPSourceIsolationAndFrozenRevision(t *testing.T) {
	h, client, call := integrationHTTPFixture(t)
	snapshot := IntegrationSnapshot{Title: "来源系统发出的文章", Body: "原文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)

	prepare := IntegrationPrepareInput{
		RequestID:              "edit-prepare",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant",
		AuthorizationExpiresAt: h.store.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	rr := call("POST", "/api/integrations/v1/preparations", prepare, false)
	if rr.Code != 201 {
		t.Fatal(rr.Body.String())
	}
	var prep IntegrationPreparation
	_ = json.Unmarshal(rr.Body.Bytes(), &prep)
	previous := prep
	previousDraftID := prep.Drafts[0].ID
	prep.Drafts[0].Markdown = "仅平台稿修改"
	rr = call("PUT", "/api/integration-preparations/"+prep.ID, map[string]any{"revision": prep.Revision, "drafts": prep.Drafts}, true)
	if rr.Code != 200 {
		t.Fatalf("edit %d %s", rr.Code, rr.Body.String())
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &prep)
	if prep.Revision != previous.Revision+1 || prep.Drafts[0].ID == previousDraftID || prep.Snapshot.Body != "原文" {
		t.Fatal("immutable revision or original body changed")
	}
	rr = call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": previous.Revision}, true)
	if rr.Code != 409 {
		t.Fatal("another page silently confirmed latest content")
	}
	// An application cannot impersonate another registered source.
	prepare.RequestID = "source-forgery"
	prepare.SourceID = "another"
	rr = call("POST", "/api/integrations/v1/preparations", prepare, false)
	if rr.Code != 400 && rr.Code != 403 {
		t.Fatal("source identity override accepted")
	}
	// Permission changes invalidate a previous draft confirmation.
	rr = call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": prep.Revision}, true)
	_ = json.Unmarshal(rr.Body.Bytes(), &prep)
	client.GrantVersion++
	client.Operations = []string{}
	raw, _ := json.Marshal(client)
	_, _ = h.store.pool.Exec(context.Background(), "UPDATE integration_clients SET metadata=$2 WHERE id=$1", client.ID, raw)
	submit := IntegrationSubmitInput{
		RequestID:               "old-grant",
		SourceID:                "cms",
		ArticleID:               "article-1",
		SourceVersion:           1,
		StateSeq:                1,
		ContentFingerprint:      fp,
		PreparationID:           prep.ID,
		ConfirmationFingerprint: prep.ConfirmationFingerprint,
		DraftRevisionIDs:        prep.DraftRevisionIDs,
		Targets:                 prep.Targets,
	}
	rr = call("POST", "/api/integrations/v1/distributions", submit, false)
	if rr.Code != 403 && rr.Code != 409 {
		t.Fatalf("revoked operation accepted %d %s", rr.Code, rr.Body.String())
	}
}

func TestIntegrationDistributionFiltersBeforePagination(t *testing.T) {
	h, client, call := integrationHTTPFixture(t)
	ctx := context.Background()
	for i := range 2 {
		article := fmt.Sprintf("list-%d", i)
		snapshot := IntegrationSnapshot{Title: "分页筛选测试文章", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
		fp, _ := IntegrationContentFingerprint(snapshot)
		input := IntegrationPrepareInput{
			RequestID:              article,
			SourceID:               "cms",
			ArticleID:              article,
			SourceVersion:          1,
			StateSeq:               1,
			AuthorizationID:        article,
			AuthorizationExpiresAt: h.store.now().Add(time.Hour),
			ContentFingerprint:     fp,
			Snapshot:               snapshot,
			Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
		}
		p, _, err := h.prepareIntegration(ctx, client, input)
		if err != nil {
			t.Fatal(err)
		}
		p, err = h.confirmIntegrationPreparation(ctx, p.ID, p.Revision)
		if err != nil {
			t.Fatal(err)
		}

		d, _, err := h.commitIntegrationDistribution(ctx, client, IntegrationSubmitInput{
			RequestID:               article,
			SourceID:                "cms",
			ArticleID:               article,
			SourceVersion:           1,
			StateSeq:                1,
			ContentFingerprint:      fp,
			PreparationID:           p.ID,
			DraftRevisionIDs:        p.DraftRevisionIDs,
			ConfirmationFingerprint: p.ConfirmationFingerprint,
			Targets:                 p.Targets,
		})
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			if _, err = h.store.pool.Exec(ctx, "UPDATE jobs SET record=jsonb_set(record,'{status}','\"waiting_user\"') WHERE id=$1", d.JobIDs[0]); err != nil {
				t.Fatal(err)
			}
		}
	}
	rr := call("GET", "/api/integration-distributions?status=needs_attention&page=1&page_size=1", nil, true)
	var listing struct {
		Total int              `json:"total"`
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &listing)
	if rr.Code != 200 || listing.Total != 1 || len(listing.Items) != 1 || listing.Items[0]["status"] != "needs_attention" {
		t.Fatalf("filter before pagination failed %d %s", rr.Code, rr.Body.String())
	}
	rr = call("GET", "/api/integration-distributions?status=completed", nil, true)
	_ = json.Unmarshal(rr.Body.Bytes(), &listing)
	if rr.Code != 200 || listing.Total != 0 || len(listing.Items) != 0 {
		t.Fatalf("empty filtered total failed %s", rr.Body.String())
	}
}

func TestIntegrationAdminClientFailureDoesNotInvalidateSession(t *testing.T) {
	h, client, call := integrationHTTPFixture(t)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{Title: "后台会话边界测试", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{
		RequestID:              "admin-state",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant",
		AuthorizationExpiresAt: h.store.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	prep, _, err := h.prepareIntegration(ctx, client, input)
	if err != nil {
		t.Fatal(err)
	}
	client.Status = "suspended"
	raw, _ := json.Marshal(client)
	_, _ = h.store.pool.Exec(ctx, "UPDATE integration_clients SET metadata=$2 WHERE id=$1", client.ID, raw)
	rr := call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": prep.Revision}, true)
	if rr.Code != 409 {
		t.Fatalf("valid admin misidentified as expired session: %d %s", rr.Code, rr.Body.String())
	}
	rr = call("GET", "/api/session", nil, true)
	if rr.Code != 200 {
		t.Fatal("admin session invalidated")
	}
}
func TestIntegrationCancelledUnwrittenCopyCanUseNewAuthorization(t *testing.T) {
	h, client, call := integrationHTTPFixture(t)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{Title: "重新授权来源测试", Body: "正文", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{
		RequestID:              "new-after-cancel",
		SourceID:               "cms",
		ArticleID:              "article-1",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "grant-1",
		AuthorizationExpiresAt: h.store.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	p, _, err := h.prepareIntegration(ctx, client, input)
	if err != nil {
		t.Fatal(err)
	}
	p, err = h.confirmIntegrationPreparation(ctx, p.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}

	submit := IntegrationSubmitInput{
		RequestID:               "old-cancelled",
		SourceID:                "cms",
		ArticleID:               input.ArticleID,
		SourceVersion:           1,
		StateSeq:                1,
		ContentFingerprint:      fp,
		PreparationID:           p.ID,
		DraftRevisionIDs:        p.DraftRevisionIDs,
		ConfirmationFingerprint: p.ConfirmationFingerprint,
		Targets:                 p.Targets,
	}
	first, _, err := h.commitIntegrationDistribution(ctx, client, submit)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.applyIntegrationEvent(ctx, client, IntegrationSourceEvent{
		EventID:       "source-private",
		SourceID:      "cms",
		ArticleID:     input.ArticleID,
		StateSeq:      3,
		SourceVersion: 3,
		Type:          "private",
		Status:        "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.resumeIntegrationDistribution(ctx, first.ID, first.ConfirmationFingerprint); !errors.Is(err, ErrIntegrationExpired) {
		t.Fatalf("cleared snapshot resume must require reprepare: %v", err)
	}
	input.RequestID = "fresh-after-cancel"
	input.AuthorizationID = "grant-2"
	input.SourceVersion = 4
	input.StateSeq = 4
	p, _, err = h.prepareIntegration(ctx, client, input)
	if err != nil {
		t.Fatal(err)
	}
	p, err = h.confirmIntegrationPreparation(ctx, p.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}

	submit.RequestID = "fresh-distribution"
	submit.PreparationID = p.ID
	submit.ConfirmationFingerprint = p.ConfirmationFingerprint
	submit.DraftRevisionIDs = p.DraftRevisionIDs
	submit.SourceVersion = 4
	submit.StateSeq = 4
	second, created, err := h.commitIntegrationDistribution(ctx, client, submit)
	if err != nil || !created || second.ID == first.ID {
		t.Fatalf("safe cancelled copy permanently blocked: %+v %v", second, err)
	}
	rr := call("GET", "/api/integration-distributions/"+first.ID, nil, true)
	if rr.Code != 200 {
		t.Fatal("old audit no longer available")
	}
}

func TestIntegrationDisabledAdminRoutesExplainConfiguration(t *testing.T) {
	s := testStore(t)
	h, err := NewHandler(context.Background(), Config{
		Store:         s,
		AdminUsername: "admin",
		AdminPassword: "private-test-password",
		WorkerToken:   "private-test-worker-token-32-characters",
		Origin:        "http://localhost",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "http://localhost/api/integration-clients", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatalf("disabled admin route must still require login: %d", rr.Code)
	}
	token := strings.Repeat("d", 64)
	_, err = s.pool.Exec(context.Background(), "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin','csrf',$2)", hashToken(token), s.now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest("GET", "http://localhost/api/integration-clients", nil)
	req.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 503 || !strings.Contains(rr.Body.String(), "integration_disabled") {
		t.Fatalf("disabled module looks like missing API: %d %s", rr.Code, rr.Body.String())
	}
}
