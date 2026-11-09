package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func integrationSeedExistingClient(t *testing.T, s *Store) IntegrationClient {
	t.Helper()
	c, err := s.integrations.Client(context.Background(), "content-client")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestStandaloneDistributionExecutesConfirmedSnapshotWithoutSourceService(t *testing.T) {
	h, client, call := integrationHTTPFixture(t)
	s := h.store
	snapshot := IntegrationSnapshot{Title: "独立服务完整流程", Body: "# 原始正文", BodyFormat: "markdown"}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{
		RequestID:              "standalone-prepare",
		SourceID:               client.SourceID,
		ArticleID:              "standalone-article",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "standalone-grant",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	}
	rr := call("POST", "/api/integrations/v1/preparations", input, false)
	if rr.Code != 201 {
		t.Fatalf("prepare %d %s", rr.Code, rr.Body.String())
	}
	var prep IntegrationPreparation
	if err := json.Unmarshal(rr.Body.Bytes(), &prep); err != nil {
		t.Fatal(err)
	}
	rr = call("GET", "/api/integration-preparations/"+prep.ID, nil, true)
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), snapshot.Body) {
		t.Fatalf("preview %d %s", rr.Code, rr.Body.String())
	}
	rr = call("POST", "/api/integration-preparations/"+prep.ID+"/confirm", map[string]any{"revision": prep.Revision}, true)
	if rr.Code != 200 {
		t.Fatalf("confirm %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &prep); err != nil {
		t.Fatal(err)
	}
	submit := IntegrationSubmitInput{
		RequestID:               "standalone-submit",
		SourceID:                client.SourceID,
		ArticleID:               prep.ArticleID,
		SourceVersion:           prep.SourceVersion,
		StateSeq:                prep.StateSeq,
		ContentFingerprint:      fp,
		PreparationID:           prep.ID,
		DraftRevisionIDs:        prep.DraftRevisionIDs,
		ConfirmationFingerprint: prep.ConfirmationFingerprint,
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
	var states int
	if err := s.pool.QueryRow(context.Background(), "SELECT count(*) FROM integration_source_events").Scan(&states); err != nil || states != 0 {
		t.Fatalf("requires prior events: %d %v", states, err)
	}
	claim := guardClaim(t, s)
	for _, in := range []ProgressInput{
		{Stage: "opening_editor", ExternalStarted: true},
		{Stage: "draft_acquired", RemoteID: "998877"},
		{Stage: "filling"}, {Stage: "saving"}, {Stage: "verifying"},
	} {
		in.LeaseToken = claim.LeaseToken
		if err := s.Progress(context.Background(), d.JobIDs[0], in); err != nil {
			t.Fatalf("%s: %v", in.Stage, err)
		}
	}
	if err := s.Complete(context.Background(), d.JobIDs[0], CompleteInput{LeaseToken: claim.LeaseToken, Status: "succeeded", RemoteID: "998877"}); err != nil {
		t.Fatal(err)
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "succeeded" || r.Outcome != "draft_saved" {
		t.Fatalf("%+v", r)
	}
	if next, err := s.Claim(context.Background(), "another-worker"); err != nil || next != nil {
		t.Fatalf("duplicate execution %+v %v", next, err)
	}
}

func TestStandaloneAuthorizationDeadlineBlocksClaimProgressAndResume(t *testing.T) {
	for _, mode := range []string{"claim", "progress", "resume"} {
		t.Run(mode, func(t *testing.T) {
			h, s, _, d := guardFixture(t)
			var claim *Claim
			if mode == "progress" {
				claim = guardClaim(t, s)
			}
			deadline := s.now().Add(-time.Second)
			if _, err := s.pool.Exec(context.Background(), "UPDATE integration_preparations SET record=jsonb_set(record,'{authorization_expires_at}',to_jsonb($2::text)) WHERE id=$1", d.PreparationID, deadline.Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "claim":
				next, err := s.Claim(context.Background(), "expired")
				if err != nil || next != nil {
					t.Fatalf("expired authorization claimed %+v %v", next, err)
				}
			case "progress":
				if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err == nil {
					t.Fatal("expired authorization wrote")
				}
			case "resume":
				guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Status = "waiting_user"; r.Ready = false; r.SourceGuardBlocked = true })
				if _, err := h.resumeIntegrationDistribution(context.Background(), d.ID, d.ConfirmationFingerprint); !errors.Is(err, ErrIntegrationExpired) {
					t.Fatalf("expired authorization resumed: %v", err)
				}
			}
		})
	}
}

func TestStandaloneExternalCancellationIsOwnedAtomicAndIdempotent(t *testing.T) {
	h, s, c, d := guardFixture(t)
	wrong := c
	wrong.ID = "another-client"
	if _, err := h.cancelIntegrationDistribution(context.Background(), wrong, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ownership %v", err)
	}
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "cancelled" || r.Ready {
		t.Fatalf("%+v", r)
	}
	summary, err := h.integrationDistributionSummary(context.Background(), d)
	if err != nil || summary["status"] != "completed" {
		t.Fatalf("%+v %v", summary, err)
	}
	c.Status = "revoked"
	guardUpdateClient(t, s, c)
	if _, err = h.cancelIntegrationDistribution(context.Background(), c, d.ID); !errors.Is(err, ErrIntegrationAuthentication) {
		t.Fatalf("revoked client repeat cancel %v", err)
	}
}

func TestStandaloneCancellationStopsLeasedWorkerAndRejectsSideEffects(t *testing.T) {
	for _, mode := range []string{"leased", "external_started", "unknown", "saved", "candidate"} {
		t.Run(mode, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			claim := guardClaim(t, s)
			if mode != "leased" {
				guardMutateRecord(t, s, d.JobIDs[0], func(r *record) {
					switch mode {
					case "external_started":
						r.ExternalStarted = true
					case "unknown":
						r.Outcome = "unknown"
					case "saved":
						r.RemoteID = "remote"
					case "candidate":
						r.ReconcileCandidateID = "remote"
					}
				})
			}
			_, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID)
			if mode != "leased" {
				if !errors.Is(err, ErrIntegrationNotCancellable) {
					t.Fatalf("unsafe cancel %v", err)
				}
				r := guardReadRecord(t, s, d.JobIDs[0])
				if r.CancelRequested {
					t.Fatal("rejected cancel mutated child")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
				t.Fatal(err)
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			if !r.CancelRequested || r.LeaseToken != claim.LeaseToken || r.Status != "running" {
				t.Fatalf("lease not retained %+v", r)
			}
			if err = s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err == nil {
				t.Fatal("cancelled worker wrote")
			}
			if err = s.Complete(context.Background(), d.JobIDs[0], CompleteInput{LeaseToken: claim.LeaseToken, Status: "cancelled", ErrorCode: "cancelled"}); err != nil {
				t.Fatal(err)
			}
			if _, err = h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStandaloneSignedCancellationEndpoint(t *testing.T) {
	h, c, call := integrationHTTPFixture(t)
	snap := IntegrationSnapshot{Title: "标准接口取消测试", Body: "正文", BodyFormat: "markdown"}
	fp, _ := IntegrationContentFingerprint(snap)
	prep, _, err := h.prepareIntegration(context.Background(), c, IntegrationPrepareInput{
		RequestID:              "cancel-prepare",
		SourceID:               c.SourceID,
		ArticleID:              "cancel-article",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "cancel-grant",
		AuthorizationExpiresAt: h.store.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snap,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	prep, err = h.confirmIntegrationPreparation(context.Background(), prep.ID, prep.Revision)
	if err != nil {
		t.Fatal(err)
	}
	in := IntegrationSubmitInput{
		RequestID:               "cancel-submit",
		SourceID:                c.SourceID,
		ArticleID:               prep.ArticleID,
		SourceVersion:           1,
		StateSeq:                1,
		ContentFingerprint:      fp,
		PreparationID:           prep.ID,
		DraftRevisionIDs:        prep.DraftRevisionIDs,
		ConfirmationFingerprint: prep.ConfirmationFingerprint,
		Targets:                 prep.Targets,
	}
	rr := call("POST", "/api/integrations/v1/distributions", in, false)
	if rr.Code != 202 {
		t.Fatalf("submit %d %s", rr.Code, rr.Body.String())
	}
	var d IntegrationDistribution
	_ = json.Unmarshal(rr.Body.Bytes(), &d)
	for range 2 {
		rr = call("POST", "/api/integrations/v1/distributions/"+d.ID+"/cancel", nil, false)
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"status":"completed"`) {
			t.Fatalf("cancel %d %s", rr.Code, rr.Body.String())
		}
	}
}

func TestStandaloneKnownInvalidStateCannotAuthorizeSnapshot(t *testing.T) {
	for _, event := range []IntegrationSourceEvent{
		{StateSeq: 1, Type: "updated", Status: "draft", AuthorizationValid: true},
		{StateSeq: 1, Type: "updated", Status: "published", AuthorizationValid: false},
	} {
		if integrationAcceptState(event, 1, 0, strings.Repeat("a", 64)) {
			t.Errorf("invalid known state accepted: %+v", event)
		}
	}
}

func TestStandaloneConcurrentCancellationAndFirstWriteAreSerialized(t *testing.T) {
	for range 6 {
		h, s, c, d := guardFixture(t)
		claim := guardClaim(t, s)
		start := make(chan struct{})
		cancellation := make(chan error, 1)
		progress := make(chan error, 1)
		go func() {
			<-start
			_, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID)
			cancellation <- err
		}()
		go func() {
			<-start
			progress <- s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true})
		}()
		close(start)
		cancelErr, progressErr := <-cancellation, <-progress
		r := guardReadRecord(t, s, d.JobIDs[0])
		if cancelErr == nil {
			if progressErr == nil || r.ExternalStarted || !r.CancelRequested {
				t.Fatalf("cancelled write escaped: cancel=%v progress=%v %+v", cancelErr, progressErr, r)
			}
		} else if !errors.Is(cancelErr, ErrIntegrationNotCancellable) || progressErr != nil || !r.ExternalStarted || r.CancelRequested {
			t.Fatalf("invalid concurrent outcome: cancel=%v progress=%v %+v", cancelErr, progressErr, r)
		}
	}
}

func TestStandaloneCancellationRejectsMissingScopeAndExpiredCredentials(t *testing.T) {
	for _, mode := range []string{"scope_removed", "client_expired", "key_expired"} {
		t.Run(mode, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			switch mode {
			case "scope_removed":
				c.Scopes = []string{"distributions:read"}
				guardUpdateClient(t, s, c)
			case "client_expired":
				c.ExpiresAt = s.now()
				guardUpdateClient(t, s, c)
			case "key_expired":
				if _, err := s.pool.Exec(context.Background(), "UPDATE integration_keys SET expires_at=$1", s.now()); err != nil {
					t.Fatal(err)
				}
			}
			_, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID)
			want := ErrIntegrationAuthentication
			if mode == "scope_removed" {
				want = ErrIntegrationPermission
			}
			if !errors.Is(err, want) {
				t.Fatalf("%s cancel allowed: %v", mode, err)
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			if r.Status != "queued" || r.CancelRequested {
				t.Fatal("unauthorized cancellation changed task")
			}
		})
	}
}

func TestStandaloneCancellationFinalizesStoppedPendingRequest(t *testing.T) {
	h, s, c, d := guardFixture(t)
	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Status = "waiting_user"; r.CancelRequested = true; r.Ready = false })
	if _, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
		t.Fatal(err)
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "cancelled" {
		t.Fatalf("stopped cancellation did not finish: %+v", r)
	}
}

func TestStandaloneKnownVersionMustMatchAtSameSequence(t *testing.T) {
	for _, phase := range []string{"prepare", "confirm", "submit"} {
		t.Run(phase, func(t *testing.T) {
			h, s := integrationTestHandler(t)
			c := integrationSeedClient(t, h)
			ctx := context.Background()
			snap := IntegrationSnapshot{Title: "来源版本一致性测试", Body: "正文", BodyFormat: "markdown"}
			fp, _ := IntegrationContentFingerprint(snap)
			input := IntegrationPrepareInput{
				RequestID:              "version-prepare",
				SourceID:               c.SourceID,
				ArticleID:              "version-article",
				SourceVersion:          1,
				StateSeq:               1,
				AuthorizationID:        "version-grant",
				AuthorizationExpiresAt: s.now().Add(time.Hour),
				ContentFingerprint:     fp,
				Snapshot:               snap,
				Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
			}
			var prep IntegrationPreparation
			var err error
			if phase != "prepare" {
				prep, _, err = h.prepareIntegration(ctx, c, input)
				if err != nil {
					t.Fatal(err)
				}
			}
			if phase == "submit" {
				prep, err = h.confirmIntegrationPreparation(ctx, prep.ID, prep.Revision)
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err = h.applyIntegrationEvent(ctx, c, IntegrationSourceEvent{
				EventID:            "known-version",
				SourceID:           c.SourceID,
				ArticleID:          input.ArticleID,
				StateSeq:           1,
				SourceVersion:      2,
				Type:               "published",
				Status:             "published",
				AuthorizationValid: true,
				ContentFingerprint: fp,
			}); err != nil {
				t.Fatal(err)
			}
			switch phase {
			case "prepare":
				_, _, err = h.prepareIntegration(ctx, c, input)
			case "confirm":
				_, err = h.confirmIntegrationPreparation(ctx, prep.ID, prep.Revision)
			case "submit":
				_, _, err = h.commitIntegrationDistribution(ctx, c, IntegrationSubmitInput{
					RequestID:               "version-submit",
					SourceID:                c.SourceID,
					ArticleID:               input.ArticleID,
					SourceVersion:           1,
					StateSeq:                1,
					ContentFingerprint:      fp,
					PreparationID:           prep.ID,
					DraftRevisionIDs:        prep.DraftRevisionIDs,
					ConfirmationFingerprint: prep.ConfirmationFingerprint,
					Targets:                 prep.Targets,
				})
			}
			if !errors.Is(err, ErrIntegrationSourceChanged) {
				t.Fatalf("%s accepted contradictory known version: %v", phase, err)
			}
		})
	}
}

func TestStandaloneCancelledWorkerCannotReturnToWaitingOrRetry(t *testing.T) {
	for _, status := range []string{"waiting_user", "failed"} {
		t.Run(status, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			claim := guardClaim(t, s)
			if _, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
				t.Fatal(err)
			}
			if err := s.Complete(context.Background(), d.JobIDs[0], CompleteInput{LeaseToken: claim.LeaseToken, Status: status, ErrorCode: "needs_login", Retryable: true}); err != nil {
				t.Fatal(err)
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			if r.Status != "cancelled" || r.Ready || r.RetryAllowed || r.LeaseToken != "" {
				t.Fatalf("cancel reopened task: %+v", r)
			}
			for _, action := range []string{"resume", "retry"} {
				if _, err := s.Action(context.Background(), r.ID, action, ActionInput{}); err == nil {
					t.Fatalf("cancelled task allowed %s", action)
				}
			}
			if _, err := h.cancelIntegrationDistribution(context.Background(), c, d.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}
