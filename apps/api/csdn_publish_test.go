package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func publishFixture(t *testing.T, tags []string, settings ...func(*CSDNPublishOptions)) (*handler, *Store, IntegrationClient, Job) {
	t.Helper()
	h, s := integrationTestHandler(t)
	c := integrationSeedClient(t, h)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{
		Title:      "已核验的正式发布文章",
		Body:       "# 内容\n\n正文",
		BodyFormat: "markdown",
		Tags:       tags,
	}
	fp, _ := IntegrationContentFingerprint(snapshot)
	p, _, err := h.prepareIntegration(ctx, c, IntegrationPrepareInput{
		RequestID:              "publish-prepare",
		SourceID:               c.SourceID,
		ArticleID:              "publish-article",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "publish-authorization",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(settings) > 0 {
		for _, change := range settings {
			change(p.Drafts[0].PublishOptions)
		}
		p, err = h.updateIntegrationPreparation(ctx, p.ID, p.Revision, p.Drafts)
		if err != nil {
			t.Fatal(err)
		}
	}
	p, err = h.confirmIntegrationPreparation(ctx, p.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}
	d, _, err := h.commitIntegrationDistribution(ctx, c, IntegrationSubmitInput{
		RequestID:               "publish-distribute",
		SourceID:                c.SourceID,
		ArticleID:               p.ArticleID,
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
	claim := guardClaim(t, s)
	if claim.Job.ID != d.JobIDs[0] {
		t.Fatal("wrong source draft claimed")
	}
	for _, progress := range []ProgressInput{
		{Stage: "opening_editor", ExternalStarted: true},
		{Stage: "draft_acquired", RemoteID: "24680"},
		{Stage: "verifying"},
	} {
		progress.LeaseToken = claim.LeaseToken
		if err := s.Progress(ctx, claim.Job.ID, progress); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Complete(ctx, claim.Job.ID, CompleteInput{LeaseToken: claim.LeaseToken, Status: "succeeded", RemoteID: "24680"}); err != nil {
		t.Fatal(err)
	}
	draft, err := s.Get(ctx, claim.Job.ID)
	if err != nil || draft.AccountUsername != "tester" || draft.Outcome != "draft_saved" {
		t.Fatalf("draft fixture: %+v %v", draft, err)
	}
	return h, s, c, draft
}

func enqueuePublish(t *testing.T, s *Store, id string) Job {
	t.Helper()
	ctx := context.Background()
	preview, err := s.csdnPublish(ctx, id, nil)
	if err != nil || preview.Job != nil || preview.ConfirmationToken == "" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	enqueued, err := s.csdnPublish(ctx, id, &preview.ConfirmationToken)
	if err != nil || enqueued.Job == nil {
		t.Fatalf("enqueue: %+v %v", enqueued, err)
	}
	return *enqueued.Job
}

func TestCSDNPublishAdminOnlyAndIdempotent(t *testing.T) {
	h, s, c, draft := publishFixture(t, []string{"Go"})
	ctx := context.Background()
	cookie := randomToken()
	if _, err := s.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin','publish-csrf',$2)", hashToken(cookie), s.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	path := "/api/jobs/" + draft.ID + "/publish"
	request := func(method, path, body string, admin, csrf bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, h.origin+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", h.origin)
		r.Header.Set("Authorization", "Bearer "+h.workerToken)
		if admin {
			r.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: cookie})
		}
		if csrf {
			r.Header.Set("X-CSRF-Token", "publish-csrf")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", path, "", false, false); w.Code != http.StatusUnauthorized {
		t.Fatalf("worker obtained admin preview: %d", w.Code)
	}
	if w := request("POST", path, "{}", true, false); w.Code != http.StatusForbidden {
		t.Fatalf("publish accepted without CSRF: %d", w.Code)
	}
	w := request("GET", path, "", true, false)
	var preview csdnPublishPreview
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &preview) != nil || preview.Job != nil ||
		preview.Title != draft.Title || preview.AccountUsername != "tester" || len(preview.Options.Tags) != 1 || len(preview.ConfirmationToken) != 64 {
		t.Fatalf("preview: %d %s", w.Code, w.Body)
	}
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"confirmation_token":"` + preview.ConfirmationToken + `","remote_id":"999"}`, http.StatusBadRequest},
		{`{"confirmation_token":"` + strings.Repeat("0", 64) + `"}`, http.StatusConflict},
	} {
		if w := request("POST", path, tc.body, true, true); w.Code != tc.code {
			t.Fatalf("invalid publish request: %d %s", w.Code, w.Body)
		}
	}
	body := `{"confirmation_token":"` + preview.ConfirmationToken + `"}`
	w = request("POST", path, body, true, true)
	var job Job
	if w.Code != http.StatusAccepted || json.Unmarshal(w.Body.Bytes(), &job) != nil || job.Kind != "publish" ||
		job.PublishFromJobID != draft.ID || job.RemoteID != draft.RemoteID || job.Markdown != draft.Markdown ||
		job.IntegrationDistributionID != "" || job.PublishOptions == nil {
		t.Fatalf("publication job: %d %s", w.Code, w.Body)
	}
	// Revocation must block new writes while allowing exact retry to recover the existing ID.
	c.Status = "suspended"
	guardUpdateClient(t, s, c)
	w = request("POST", path, body, true, true)
	var replay Job
	if w.Code != http.StatusAccepted || json.Unmarshal(w.Body.Bytes(), &replay) != nil || replay.ID != job.ID {
		t.Fatalf("idempotent replay: %d %s", w.Code, w.Body)
	}
	w = request("GET", path, "", true, false)
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &preview) != nil || preview.Job == nil || preview.Job.ID != job.ID {
		t.Fatalf("recover existing publication: %d %s", w.Code, w.Body)
	}
	if w := request("GET", "/api/processes?kind=publish", "", true, false); w.Code != http.StatusOK {
		t.Fatalf("publish process filter: %d %s", w.Code, w.Body)
	}
	if claim, err := s.Claim(ctx, "publish-worker"); err != nil || claim != nil {
		t.Fatalf("revoked grant permitted claim: %+v %v", claim, err)
	}
	stored := guardReadRecord(t, s, job.ID)
	if stored.Status != "waiting_user" || stored.ExternalStarted || stored.RemoteID != draft.RemoteID {
		t.Fatalf("revocation state: %+v", stored)
	}
	if _, err := s.Action(ctx, job.ID, "resume", ActionInput{}); !errors.Is(err, ErrConflict) {
		t.Fatalf("revoked grant permitted resume: %v", err)
	}
}

func TestCSDNPublishWriteGuardAndReadOnlyRecovery(t *testing.T) {
	for _, revokeAtCheckpoint := range []bool{true, false} {
		t.Run(map[bool]string{true: "revocation_blocks_click", false: "accepted_submission_read_only"}[revokeAtCheckpoint], func(t *testing.T) {
			_, s, c, draft := publishFixture(t, []string{"Go"})
			ctx := context.Background()
			job := enqueuePublish(t, s, draft.ID)
			claim := guardClaim(t, s)
			for _, stage := range []string{"opening_editor", "draft_acquired", "filling"} {
				if err := s.Progress(ctx, job.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: stage}); err != nil {
					t.Fatal(err)
				}
			}
			checkpoint := ProgressInput{
				LeaseToken:          claim.LeaseToken,
				Stage:               "saving",
				ExternalStarted:     true,
				RemoteID:            draft.RemoteID,
				PublishedHTMLSHA256: testPublishHTMLSHA256,
			}
			if revokeAtCheckpoint {
				c.Status = "suspended"
				guardUpdateClient(t, s, c)
				if err := s.Progress(ctx, job.ID, checkpoint); !errors.Is(err, ErrConflict) {
					t.Fatalf("revoked source reached submit: %v", err)
				}
				stored := guardReadRecord(t, s, job.ID)
				if stored.ExternalStarted || stored.Status != "waiting_user" || stored.RemoteID != draft.RemoteID {
					t.Fatalf("revocation before submit: %+v", stored)
				}
				return
			}
			missingRemote := checkpoint
			missingRemote.RemoteID = ""
			if err := s.Progress(ctx, job.ID, missingRemote); !errors.Is(err, ErrConflict) {
				t.Fatalf("checkpoint without draft identity: %v", err)
			}
			if err := s.Progress(ctx, job.ID, checkpoint); err != nil {
				t.Fatal(err)
			}
			if err := s.Progress(ctx, job.ID, checkpoint); !errors.Is(err, ErrConflict) {
				t.Fatalf("submission checkpoint accepted twice: %v", err)
			}
			c.Status = "suspended"
			guardUpdateClient(t, s, c)
			if err := s.Complete(ctx, job.ID, CompleteInput{
				LeaseToken:      claim.LeaseToken,
				Status:          "reconciling",
				RemoteID:        draft.RemoteID,
				PublishAccepted: true,
			}); err != nil {
				t.Fatal(err)
			}
			stored := guardReadRecord(t, s, job.ID)
			if stored.Outcome != "submitted" || stored.RunMode != "reconcile" || !stored.ExternalStarted || stored.RemoteID != draft.RemoteID {
				t.Fatalf("accepted submission state: %+v", stored)
			}
			for _, action := range []string{"retry", "resume"} {
				if _, err := s.Action(ctx, job.ID, action, ActionInput{}); !errors.Is(err, ErrConflict) {
					t.Fatalf("publication with checkpoint permitted %s: %v", action, err)
				}
			}
			for i := 0; i < 2; i++ {
				if _, err := s.Action(ctx, job.ID, "reconcile", ActionInput{}); err != nil {
					t.Fatal(err)
				}
				next := guardClaim(t, s)
				if next.Job.ID != job.ID || next.Job.RunMode != "reconcile" || next.Job.RemoteID != draft.RemoteID || next.Job.PublishedHTMLSHA256 != testPublishHTMLSHA256 {
					t.Fatalf("unsafe recovery claim: %+v", next)
				}
				if err := s.Progress(ctx, job.ID, ProgressInput{LeaseToken: next.LeaseToken, Stage: "verifying"}); err != nil {
					t.Fatal(err)
				}
				result := CompleteInput{LeaseToken: next.LeaseToken, Status: "reconciling", ErrorCode: "draft_absent"}
				if i == 1 {
					result.Status, result.RemoteID = "succeeded", draft.RemoteID
				}
				if err := s.Complete(ctx, job.ID, result); err != nil {
					t.Fatal(err)
				}
			}
			stored = guardReadRecord(t, s, job.ID)
			original := guardReadRecord(t, s, draft.ID)
			if stored.Outcome != "published" || stored.Status != "succeeded" || stored.RemoteID != draft.RemoteID ||
				stored.RemoteURL != "https://blog.csdn.net/tester/article/details/"+draft.RemoteID ||
				original.Outcome != "draft_saved" || original.Status != "succeeded" {
				t.Fatalf("publication/draft outcomes: %+v %+v", stored, original)
			}
		})
	}
}

func TestCSDNPublishRequiresBoundAccountAndTags(t *testing.T) {
	for _, tc := range []struct {
		name          string
		tags          []string
		changeAccount bool
		wantErr       error
	}{
		{"legacy_unbound", []string{"Go"}, false, ErrConflict},
		{"account_changed", []string{"Go"}, true, ErrConflict},
		{"missing_tags", nil, false, errCSDNPublishTags},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, s, _, draft := publishFixture(t, tc.tags)
			ctx := context.Background()
			if tc.name == "legacy_unbound" {
				guardMutateRecord(t, s, draft.ID, func(r *record) { r.AccountUsername = "" })
			}
			if tc.changeAccount {
				if _, err := s.pool.Exec(ctx, "UPDATE account SET connection_version=connection_version+1"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.csdnPublish(ctx, draft.ID, nil); !errors.Is(err, tc.wantErr) {
				t.Fatalf("ineligible draft offered for publication: %v", err)
			}
		})
	}
}

func TestCSDNPublishVerifiesFrozenRightsAndArticleType(t *testing.T) {
	for _, tc := range []struct {
		name, articleType, visibility string
		rights                        bool
		wantErr                       error
	}{
		{"repost", "repost", "public", true, nil},
		{"translated", "translated", "public", true, nil},
		{"unconfirmed_rights", "repost", "public", false, errCSDNPublishOptions},
		{"vip_repost", "repost", "vip", true, errCSDNPublishOptions},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const original = "https://source.example.test/article"
			_, s, _, draft := publishFixture(t, []string{"Go"}, func(o *CSDNPublishOptions) {
				o.ArticleType, o.Visibility = tc.articleType, tc.visibility
				o.OriginalURL, o.RightsConfirmed = original, tc.rights
			})
			preview, err := s.csdnPublish(context.Background(), draft.ID, nil)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("publication option validation: %+v %v", preview, err)
			}
			if tc.wantErr == nil && (preview.Options.OriginalURL != original || !preview.Options.RightsConfirmed || preview.Options.ArticleType != tc.articleType) {
				t.Fatalf("confirmation did not preserve rights: %+v", preview.Options)
			}
		})
	}
}
