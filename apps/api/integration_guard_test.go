package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func guardFixture(t *testing.T) (*handler, *Store, IntegrationClient, IntegrationDistribution) {
	t.Helper()
	h, s := integrationTestHandler(t)
	c := integrationSeedClient(t, h)
	ctx := context.Background()
	snapshot := IntegrationSnapshot{
		Title:      "来源执行安全检查文章",
		Body:       "# 内容\n\n正文",
		BodyFormat: "markdown",
		Tags:       []string{},
	}
	fp, _ := IntegrationContentFingerprint(snapshot)
	p, _, err := h.prepareIntegration(ctx, c, IntegrationPrepareInput{
		RequestID:              "guard-prepare",
		SourceID:               c.SourceID,
		ArticleID:              "guard-article",
		SourceVersion:          1,
		StateSeq:               1,
		AuthorizationID:        "guard-authorization",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     fp,
		Snapshot:               snapshot,
		Targets:                []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err = h.confirmIntegrationPreparation(ctx, p.ID, p.Revision)
	if err != nil {
		t.Fatal(err)
	}

	d, _, err := h.commitIntegrationDistribution(ctx, c, IntegrationSubmitInput{
		RequestID:               "guard-distribute",
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
	return h, s, c, d
}
func guardReadRecord(t *testing.T, s *Store, id string) *record {
	t.Helper()
	var out *record
	if err := s.locked(context.Background(), func(tx pgx.Tx, _ time.Time) error {
		var err error
		out, err = load(context.Background(), tx, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return out
}
func guardMutateRecord(t *testing.T, s *Store, id string, fn func(*record)) {
	t.Helper()
	if err := s.locked(context.Background(), func(tx pgx.Tx, _ time.Time) error {
		r, err := load(context.Background(), tx, id)
		if err != nil {
			return err
		}
		fn(r)
		return save(context.Background(), tx, r)
	}); err != nil {
		t.Fatal(err)
	}
}
func guardUpdateClient(t *testing.T, s *Store, c IntegrationClient) {
	t.Helper()
	raw, _ := json.Marshal(c)
	if _, err := s.pool.Exec(context.Background(), "UPDATE integration_clients SET metadata=$2 WHERE id=$1", c.ID, raw); err != nil {
		t.Fatal(err)
	}
}
func guardClaim(t *testing.T, s *Store) *Claim {
	t.Helper()
	claim, err := s.Claim(context.Background(), "guard-worker")
	if err != nil || claim == nil {
		t.Fatalf("claim %v %+v", err, claim)
	}
	return claim
}

func TestIntegrationGuardClaimRejectsCurrentPermissionChanges(t *testing.T) {
	for _, mode := range []string{"disabled_config", "suspended", "grant_changed", "scope_removed", "account_removed", "operation_removed", "expired_key", "source_private"} {
		t.Run(mode, func(t *testing.T) {
			_, s, c, d := guardFixture(t)
			switch mode {
			case "disabled_config":
				s.integrations = nil
			case "suspended":
				c.Status = "suspended"
				guardUpdateClient(t, s, c)
			case "grant_changed":
				c.GrantVersion++
				guardUpdateClient(t, s, c)
			case "scope_removed":
				c.Scopes = []string{"targets:read"}
				guardUpdateClient(t, s, c)
			case "account_removed":
				c.Accounts = []string{}
				guardUpdateClient(t, s, c)
			case "operation_removed":
				c.Operations = []string{}
				guardUpdateClient(t, s, c)
			case "expired_key":
				if _, err := s.pool.Exec(context.Background(), "UPDATE integration_keys SET expires_at=$1", s.now().Add(-time.Second)); err != nil {
					t.Fatal(err)
				}
			case "source_private":
				event := IntegrationSourceEvent{
					SourceID:           c.SourceID,
					ArticleID:          d.ArticleID,
					StateSeq:           2,
					SourceVersion:      1,
					Type:               "private",
					Status:             "private",
					AuthorizationValid: false,
				}
				raw, _ := json.Marshal(event)
				if _, err := s.pool.Exec(context.Background(), "INSERT INTO integration_source_states(source_id,article_id,state_seq,record) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,article_id) DO UPDATE SET state_seq=excluded.state_seq,record=excluded.record", c.SourceID, d.ArticleID, event.StateSeq, raw); err != nil {
					t.Fatal(err)
				}
			}
			claim, err := s.Claim(context.Background(), "guard-worker")
			if err != nil || claim != nil {
				t.Fatalf("unsafe task claimed: %+v %v", claim, err)
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			if r.Status != "waiting_user" || r.Ready || r.ErrorCode != "source_guard_failed" {
				t.Fatalf("pause not persisted: %+v", r)
			}
		})
	}
}

func TestIntegrationGuardProgressChecksLeaseAndStage(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)

	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: "wrong", Stage: "opening_editor", ExternalStarted: true}); err == nil {
		t.Fatalf("invalid lease accepted progress: %v", err)
	}
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "saving"}); err == nil {
		t.Fatalf("invalid stage accepted progress: %v", err)
	}
}

func TestIntegrationGuardSuspendedClientPreservesLeaseAndBlocksAccount(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)
	c := integrationSeedExistingClient(t, s)
	c.Status = "suspended"
	guardUpdateClient(t, s, c)
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err == nil {
		t.Fatal("suspended client allowed first write")
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "waiting_user" || r.Ready || r.LeaseToken != claim.LeaseToken || !r.LeaseExpiresAt.After(s.now()) || r.ExternalStarted || r.ErrorCode != "source_guard_failed" {
		t.Fatalf("unsafe pause %+v", r)
	}
	createTest(t, s, "guard-unrelated")
	if next, err := s.Claim(context.Background(), "another-worker"); err != nil || next != nil {
		t.Fatalf("account reused before browser stopped: %v %+v", err, next)
	}
	if _, err := s.Action(context.Background(), r.ID, "resume", ActionInput{}); err == nil {
		t.Fatal("generic action bypassed guard")
	}
}

func TestIntegrationGuardExternalFailureQueuesOnlyReadReconcile(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	c := integrationSeedExistingClient(t, s)
	c.Status = "suspended"
	guardUpdateClient(t, s, c)
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "filling"}); err == nil {
		t.Fatal("suspended client allowed a later write")
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.RunMode != "reconcile" || r.Status != "reconciling" || !r.ExternalStarted || r.LeaseToken != claim.LeaseToken || r.Outcome != "unknown" {
		t.Fatalf("missing read-only recovery: %+v", r)
	}
	now := s.now()
	s.now = func() time.Time { return now.Add(2 * time.Minute) }
	next := guardClaim(t, s)
	if next.Job.RunMode != "reconcile" {
		t.Fatal("recovery was not read-only")
	}
	if err := s.Progress(context.Background(), next.Job.ID, ProgressInput{LeaseToken: next.LeaseToken, Stage: "verifying"}); err != nil {
		t.Fatalf("suspended client blocked read reconciliation: %v", err)
	}
}

func TestIntegrationGuardGenericActionsCannotRestoreOldGrant(t *testing.T) {
	_, s, c, d := guardFixture(t)
	c.GrantVersion++
	guardUpdateClient(t, s, c)
	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Status = "waiting_user"; r.Ready = false; r.ErrorCode = "source_guard_failed" })
	if _, err := s.Action(context.Background(), d.JobIDs[0], "resume", ActionInput{}); err == nil {
		t.Fatal("generic resume restored old grant")
	}
	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Status = "failed"; r.Ready = false; r.ErrorCode = "timeout" })
	if _, err := s.Action(context.Background(), d.JobIDs[0], "retry", ActionInput{}); err == nil {
		t.Fatal("generic retry restored old grant")
	}
}

func TestIntegrationGuardMaintainPurgesOnlyEligiblePreparationBodies(t *testing.T) {
	_, s, _, d := guardFixture(t)
	ctx := context.Background()
	now := s.now()
	p, err := integrationReadPreparation(ctx, s.pool, d.PreparationID, false)
	if err != nil {
		t.Fatal(err)
	}
	originalBody := p.Snapshot.Body
	// 已提交且仍待处理的快照即使过期或撤销也保留。
	p.Status = "revoked"
	p.ExpiresAt = now.Add(-time.Hour)
	raw, _ := json.Marshal(p)
	if _, err = s.pool.Exec(ctx, "UPDATE integration_preparations SET record=$2,expires_at=$3 WHERE id=$1", p.ID, raw, p.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	expired := p
	expired.ID = "expired-preparation"
	expired.RequestID = "expired-request"
	expired.Status = "confirmed"
	expired.ArticleID = "expired-article"
	raw, _ = json.Marshal(expired)
	if _, err = s.pool.Exec(ctx, "INSERT INTO integration_preparations(id,client_id,source_id,article_id,request_id,fingerprint,record,expires_at,created_at) VALUES($1,$2,$3,$4,$5,'fixture',$6,$7,$8)", expired.ID, expired.ClientID, expired.SourceID, expired.ArticleID, expired.RequestID, raw, expired.ExpiresAt, now); err != nil {
		t.Fatal(err)
	}
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	got, _ := integrationReadPreparation(ctx, s.pool, expired.ID, false)
	if got.Snapshot.Body != "" || len(got.Drafts) != 0 || got.ContentFingerprint != expired.ContentFingerprint {
		t.Fatalf("expired snapshot retained or identity lost: %+v", got)
	}
	got, _ = integrationReadPreparation(ctx, s.pool, p.ID, false)
	if got.Snapshot.Body != originalBody || len(got.Drafts) == 0 {
		t.Fatal("active submitted snapshot purged")
	}
	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) {
		r.Status = "succeeded"
		r.Outcome = "draft_saved"
		r.Ready = false
		r.RetryAllowed = false
		r.UpdatedAt = now.Add(-31 * 24 * time.Hour)
		r.FinishedAt = &r.UpdatedAt
	})
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	got, _ = integrationReadPreparation(ctx, s.pool, p.ID, false)
	if got.Snapshot.Body != "" || len(got.Drafts) != 0 || got.ContentFingerprint != p.ContentFingerprint || got.ConfirmationFingerprint != p.ConfirmationFingerprint {
		t.Fatalf("terminal snapshot not cleaned safely: %+v", got)
	}
	kept, err := integrationReadDistribution(ctx, s.pool, d.ID)
	if err != nil || kept.RequestID != d.RequestID || kept.ContentFingerprint != d.ContentFingerprint {
		t.Fatal("deduplication record removed")
	}
}

func TestIntegrationGuardMaintainRetainsUnknownAndRetryableSubmittedData(t *testing.T) {
	for _, mode := range []string{"unknown", "retryable"} {
		t.Run(mode, func(t *testing.T) {
			_, s, _, d := guardFixture(t)
			now := s.now()
			guardMutateRecord(t, s, d.JobIDs[0], func(r *record) {
				r.Status = "failed"
				r.UpdatedAt = now.Add(-31 * 24 * time.Hour)
				if mode == "unknown" {
					r.Outcome = "unknown"
					r.ExternalStarted = true
				} else {
					r.RetryAllowed = true
				}
			})
			if err := s.Maintain(context.Background()); err != nil {
				t.Fatal(err)
			}
			p, _ := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
			if p.Snapshot.Body == "" || len(p.Drafts) == 0 {
				t.Fatal("required recovery snapshot purged")
			}
		})
	}
}

func TestIntegrationGuardMaintainDoesNotForgetValidReplayState(t *testing.T) {
	_, s, c, _ := guardFixture(t)
	ctx := context.Background()
	now := s.now()
	var key string
	if err := s.pool.QueryRow(ctx, "SELECT id FROM integration_keys WHERE client_id=$1 LIMIT 1", c.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	for name, expiry := range map[string]time.Time{
		"valid":   now.Add(time.Minute),
		"grace":   now.Add(-500 * time.Millisecond),
		"expired": now.Add(-2 * time.Second),
	} {
		if _, err := s.pool.Exec(ctx, "INSERT INTO integration_nonces(client_id,key_id,nonce_hash,expires_at) VALUES($1,$2,$3,$4)", c.ID, key, name, expiry); err != nil {
			t.Fatal(err)
		}
	}
	for name, window := range map[string]int64{"recent": now.Unix() / 60, "old": now.Add(-20*time.Minute).Unix() / 60} {
		if _, err := s.pool.Exec(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES($1,$2,1)", name, window); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.pool.Exec(ctx, "UPDATE integration_invitations SET expires_at=$1,settings=$2", now.Add(-time.Hour), []byte(`{"source_id":"cms","accounts":["csdn-main"]}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM integration_nonces WHERE nonce_hash IN ('valid','grace')").Scan(&count); err != nil || count != 2 {
		t.Fatalf("forgot valid replay state: %d %v", count, err)
	}
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM integration_nonces WHERE nonce_hash='expired'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired replay state retained: %d %v", count, err)
	}
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM integration_rate_windows WHERE subject='old'").Scan(&count); err != nil || count != 0 {
		t.Fatal("old rate window retained")
	}
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM integration_invitations WHERE settings='{}'::jsonb").Scan(&count); err != nil || count != 0 {
		t.Fatal("referenced invitation approval bounds were discarded")
	}
}

func TestIntegrationGuardCannotMarkExternalStartedBeforeCheck(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)

	c := integrationSeedExistingClient(t, s)
	c.Status = "suspended"
	guardUpdateClient(t, s, c)
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "checking_login", ExternalStarted: true}); err == nil {
		t.Fatalf("external start bypassed check: %v", err)
	}
}

func TestIntegrationGuardAbsenceReconciliationCannotResumeWritesAutomatically(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)
	ctx := context.Background()
	if err := s.Progress(ctx, d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	c := integrationSeedExistingClient(t, s)
	c.Status = "suspended"
	guardUpdateClient(t, s, c)
	if err := s.Progress(ctx, d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "filling"}); err == nil {
		t.Fatal("missing guard failure")
	}
	clock := s.now().Add(2 * time.Minute)
	s.now = func() time.Time { return clock }
	for i := 0; i < 2; i++ {
		check := guardClaim(t, s)
		if err := s.Progress(ctx, check.Job.ID, ProgressInput{LeaseToken: check.LeaseToken, Stage: "verifying"}); err != nil {
			t.Fatal(err)
		}
		if err := s.Complete(ctx, check.Job.ID, CompleteInput{LeaseToken: check.LeaseToken, Status: "failed", ErrorCode: "draft_absent"}); err != nil {
			t.Fatal(err)
		}
		clock = clock.Add(21 * time.Second)
	}
	if next, err := s.Claim(ctx, "guard-worker"); err != nil || next != nil {
		t.Fatalf("absence bypassed renewed user confirmation: %+v %v", next, err)
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "waiting_user" || r.Ready {
		t.Fatalf("old write intent resumed: %+v", r)
	}
}

func TestIntegrationGuardRejectsInvalidRunMode(t *testing.T) {
	_, s, _, d := guardFixture(t)
	claim := guardClaim(t, s)

	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.RunMode = "invalid" })
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err == nil {
		t.Fatalf("invalid run mode accepted progress: %v", err)
	}
}

func TestIntegrationGuardMaintainPreservesPendingApprovalBounds(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	service, err := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge", "https://bridge.example")
	if err != nil {
		t.Fatal(err)
	}
	clock := st.now()
	st.now = func() time.Time { return clock }
	invitation, err := service.Invite(ctx, IntegrationInvitationInput{
		SourceID:           "cms",
		Environment:        "test",
		Scopes:             []string{"targets:read"},
		Accounts:           []string{"csdn-main"},
		Operations:         []string{"save_draft"},
		ExpiresAt:          clock.Add(time.Minute),
		ClientExpiresAt:    clock.Add(24 * time.Hour),
		RateLimitPerMinute: 60,
	}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	registration, err := service.Register(ctx, invitation.Token, IntegrationRegistrationInput{
		Name:        "待审批来源",
		SourceID:    "cms",
		Environment: "test",
		Scopes:      []string{"targets:read"},
		Accounts:    []string{"csdn-main"},
		Operations:  []string{"save_draft"},
	})
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(2 * time.Minute)
	if err = st.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Approve(ctx, registration.ID, IntegrationGrantInput{
		Scopes:             []string{"targets:read"},
		Accounts:           []string{"csdn-main"},
		Operations:         []string{"save_draft"},
		ExpiresAt:          clock.Add(12 * time.Hour),
		RateLimitPerMinute: 60,
	}, "admin"); err != nil {
		t.Fatalf("maintenance discarded accepted registration approval bounds: %v", err)
	}
}

func guardSecondPreparation(t *testing.T, h *handler, s *Store, c IntegrationClient, d IntegrationDistribution, authorization, request string, seq int64) IntegrationPreparation {
	t.Helper()
	base, err := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
	if err != nil {
		t.Fatal(err)
	}
	p, _, err := h.prepareIntegration(context.Background(), c, IntegrationPrepareInput{
		RequestID:              request,
		SourceID:               c.SourceID,
		ArticleID:              d.ArticleID,
		SourceVersion:          base.SourceVersion,
		StateSeq:               seq,
		AuthorizationID:        authorization,
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     d.ContentFingerprint,
		Snapshot:               base.Snapshot,
		Targets:                d.Targets,
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestIntegrationAuthorizationRevocationOnlyAffectsItsGrant(t *testing.T) {
	for _, revokeSubmitted := range []bool{false, true} {
		name := "pending_grant"
		if revokeSubmitted {
			name = "submitted_grant"
		}
		t.Run(name, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			pB := guardSecondPreparation(t, h, s, c, d, "grant-B", "prepare-grant-B", 1)
			authorization := "grant-B"
			if revokeSubmitted {
				authorization = "guard-authorization"
			}
			event := IntegrationSourceEvent{
				EventID:            "revoke-specific-grant",
				SourceID:           c.SourceID,
				ArticleID:          d.ArticleID,
				StateSeq:           2,
				SourceVersion:      1,
				Type:               "authorization_revoked",
				Status:             "published",
				AuthorizationID:    authorization,
				AuthorizationValid: false,
				ContentFingerprint: d.ContentFingerprint,
			}
			applied, err := h.applyIntegrationEvent(context.Background(), c, event)
			if err != nil || !applied {
				t.Fatalf("revoke %v applied=%v", err, applied)
			}
			if again, err := h.applyIntegrationEvent(context.Background(), c, event); err != nil || again {
				t.Fatalf("revocation replay %v applied=%v", err, again)
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			pA, _ := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
			pB, _ = integrationReadPreparation(context.Background(), s.pool, pB.ID, false)
			if revokeSubmitted {
				if !r.SourceGuardBlocked || r.Ready || r.Status != "cancelled" {
					t.Fatalf("revoked submitted grant was not stopped: %+v", r)
				}
				if pB.Status == "revoked" || pB.Snapshot.Body == "" {
					t.Fatal("unrelated pending grant was revoked")
				}
				if _, err := h.confirmIntegrationPreparation(context.Background(), pB.ID, pB.Revision); err != nil {
					t.Fatalf("other grant could not be confirmed: %v", err)
				}
			} else {
				if r.SourceGuardBlocked || r.Status != "queued" || !r.Ready || pA.Status != "submitted" || pA.Snapshot.Body == "" {
					t.Fatalf("other submitted grant was revoked: %+v", r)
				}
				if pB.Status != "revoked" || pB.Snapshot.Body != "" || len(pB.Drafts) != 0 {
					t.Fatal("revoked pending grant body retained")
				}
				claim := guardClaim(t, s)
				if err := s.Progress(context.Background(), r.ID, ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
					t.Fatalf("other grant could not execute: %v", err)
				}
			}
		})
	}
}

func TestIntegrationAuthorizationRevocationRequiresBoundGrantIdentity(t *testing.T) {
	h, s, c, d := guardFixture(t)
	for _, authorization := range []string{"", "bad authorization"} {
		event := IntegrationSourceEvent{
			EventID:            "missing-grant",
			SourceID:           c.SourceID,
			ArticleID:          d.ArticleID,
			StateSeq:           2,
			SourceVersion:      1,
			Type:               "authorization_revoked",
			Status:             "published",
			AuthorizationID:    authorization,
			AuthorizationValid: false,
		}
		if _, err := h.applyIntegrationEvent(context.Background(), c, event); !errors.Is(err, ErrInvalid) {
			t.Fatalf("unbound revocation accepted: %v", err)
		}
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.SourceGuardBlocked || r.Status != "queued" {
		t.Fatal("invalid revocation altered task")
	}
}

func TestIntegrationAuthorizationDelayedRevocationSurvivesNewerArticleWatermark(t *testing.T) {
	h, s, c, d := guardFixture(t)
	pB := guardSecondPreparation(t, h, s, c, d, "grant-B", "prepare-late-grant-B", 1)
	claim := guardClaim(t, s)
	if _, err := h.applyIntegrationEvent(context.Background(), c, IntegrationSourceEvent{
		EventID:            "newer-article",
		SourceID:           c.SourceID,
		ArticleID:          d.ArticleID,
		StateSeq:           10,
		SourceVersion:      1,
		Type:               "published",
		Status:             "published",
		AuthorizationValid: true,
		ContentFingerprint: d.ContentFingerprint,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
		t.Fatal(err)
	}
	applied, err := h.applyIntegrationEvent(context.Background(), c, IntegrationSourceEvent{
		EventID:            "late-revoke-B",
		SourceID:           c.SourceID,
		ArticleID:          d.ArticleID,
		StateSeq:           7,
		SourceVersion:      1,
		Type:               "authorization_revoked",
		Status:             "published",
		AuthorizationID:    "grant-B",
		AuthorizationValid: false,
		ContentFingerprint: d.ContentFingerprint,
	})
	if err != nil || !applied {
		t.Fatalf("delayed grant revocation was discarded: %v applied=%v", err, applied)
	}
	pB, _ = integrationReadPreparation(context.Background(), s.pool, pB.ID, false)
	if pB.Status != "revoked" || pB.Snapshot.Body != "" {
		t.Fatal("delayed revoke did not invalidate matching preparation")
	}
	if err = s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "filling"}); err != nil {
		t.Fatalf("different live grant blocked by old revoke: %v", err)
	}
	err = s.locked(context.Background(), func(tx pgx.Tx, _ time.Time) error {
		latest, e := integrationLatestEvent(context.Background(), tx, c.SourceID, d.ArticleID)
		if e != nil {
			return e
		}
		if latest.StateSeq != 10 || !latest.AuthorizationValid {
			return errors.New("grant revoke changed article watermark")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = s.locked(context.Background(), func(tx pgx.Tx, _ time.Time) error {
		return integrationAuthorizationAllowed(context.Background(), tx, c.SourceID, d.ArticleID, "grant-B")
	})
	if !errors.Is(err, ErrIntegrationExpired) {
		t.Fatalf("delayed grant tombstone was not persisted: %v", err)
	}
}

func TestIntegrationAuthorizationRevocationCannotBeClearedByPublishing(t *testing.T) {
	h, s, c, d := guardFixture(t)
	guardSecondPreparation(t, h, s, c, d, "grant-B", "prepare-before-revoke-B", 1)
	ctx := context.Background()
	revoke := IntegrationSourceEvent{
		EventID:            "revoke-B-once",
		SourceID:           c.SourceID,
		ArticleID:          d.ArticleID,
		StateSeq:           2,
		SourceVersion:      1,
		Type:               "authorization_revoked",
		Status:             "published",
		AuthorizationID:    "grant-B",
		AuthorizationValid: false,
		ContentFingerprint: d.ContentFingerprint,
	}
	if _, err := h.applyIntegrationEvent(ctx, c, revoke); err != nil {
		t.Fatal(err)
	}
	conflict := revoke
	conflict.AuthorizationID = "grant-C"
	if _, err := h.applyIntegrationEvent(ctx, c, conflict); !errors.Is(err, ErrConflict) {
		t.Fatalf("event identity reused for another authorization: %v", err)
	}
	if _, err := h.applyIntegrationEvent(ctx, c, IntegrationSourceEvent{
		EventID:            "published-after-revoke",
		SourceID:           c.SourceID,
		ArticleID:          d.ArticleID,
		StateSeq:           3,
		SourceVersion:      1,
		Type:               "published",
		Status:             "published",
		AuthorizationValid: true,
		ContentFingerprint: d.ContentFingerprint,
	}); err != nil {
		t.Fatal(err)
	}
	base, err := integrationReadPreparation(ctx, s.pool, d.PreparationID, false)
	if err != nil {
		t.Fatal(err)
	}
	input := IntegrationPrepareInput{
		RequestID:              "prepare-reused-revoked-grant",
		SourceID:               c.SourceID,
		ArticleID:              d.ArticleID,
		SourceVersion:          1,
		StateSeq:               3,
		AuthorizationID:        "grant-B",
		AuthorizationExpiresAt: s.now().Add(time.Hour),
		ContentFingerprint:     d.ContentFingerprint,
		Snapshot:               base.Snapshot,
		Targets:                d.Targets,
	}
	if _, _, err = h.prepareIntegration(ctx, c, input); !errors.Is(err, ErrIntegrationExpired) {
		t.Fatalf("published event revived explicit revoked authorization: %v", err)
	}
	input.RequestID = "prepare-fresh-grant"
	input.AuthorizationID = "grant-C"
	if _, _, err = h.prepareIntegration(ctx, c, input); err != nil {
		t.Fatalf("fresh authorization could not start a new preview: %v", err)
	}
	clock := s.now().Add(31 * 24 * time.Hour)
	s.now = func() time.Time { return clock }
	if err = s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	err = s.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		return integrationAuthorizationAllowed(ctx, tx, c.SourceID, d.ArticleID, "grant-B")
	})
	if !errors.Is(err, ErrIntegrationExpired) {
		t.Fatalf("maintenance discarded permanent revocation: %v", err)
	}
}

func TestIntegrationAuthorizationRevocationGuardRejectsRestoredQueuedTask(t *testing.T) {
	h, s, c, d := guardFixture(t)
	ctx := context.Background()
	if _, err := h.applyIntegrationEvent(ctx, c, IntegrationSourceEvent{
		EventID:            "revoke-restored-grant",
		SourceID:           c.SourceID,
		ArticleID:          d.ArticleID,
		StateSeq:           2,
		SourceVersion:      1,
		Type:               "authorization_revoked",
		Status:             "published",
		AuthorizationID:    "guard-authorization",
		AuthorizationValid: false,
		ContentFingerprint: d.ContentFingerprint,
	}); err != nil {
		t.Fatal(err)
	}
	guardMutateRecord(t, s, d.JobIDs[0], func(r *record) {
		r.Status = "queued"
		r.Ready = true
		r.SourceGuardBlocked = false
		r.ErrorCode = ""
		r.FinishedAt = nil
	})

	if claim, err := s.Claim(ctx, "guard-worker"); err != nil || claim != nil {
		t.Fatalf("restored revoked authorization reached worker: %+v %v", claim, err)
	}
	r := guardReadRecord(t, s, d.JobIDs[0])
	if r.Status != "waiting_user" || !r.SourceGuardBlocked || r.Ready {
		t.Fatalf("grant tombstone did not prevent write: %+v", r)
	}
}

func TestIntegrationAuthorizationRevocationRejectsCrossSourceEvent(t *testing.T) {
	h, _, c, d := guardFixture(t)
	if _, err := h.applyIntegrationEvent(context.Background(), c, IntegrationSourceEvent{
		EventID:            "foreign-source-revoke",
		SourceID:           "other-source",
		ArticleID:          d.ArticleID,
		StateSeq:           2,
		SourceVersion:      1,
		Type:               "authorization_revoked",
		Status:             "published",
		AuthorizationID:    "guard-authorization",
		AuthorizationValid: false,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-source authorization revoke accepted: %v", err)
	}
}

func TestIntegrationRevocationPurgesUnexecutedAcceptedBodies(t *testing.T) {
	for _, kind := range []string{"private", "deleted", "unpublished", "authorization_revoked"} {
		t.Run(kind, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			event := IntegrationSourceEvent{
				EventID:            "purge-accepted-body",
				SourceID:           c.SourceID,
				ArticleID:          d.ArticleID,
				StateSeq:           2,
				SourceVersion:      1,
				Type:               kind,
				Status:             kind,
				AuthorizationValid: false,
			}
			if kind == "unpublished" {
				event.Status = "draft"
			}
			if kind == "authorization_revoked" {
				event.Status = "published"
				event.AuthorizationID = "guard-authorization"
			}
			if _, err := h.applyIntegrationEvent(context.Background(), c, event); err != nil {
				t.Fatal(err)
			}
			p, err := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
			if err != nil {
				t.Fatal(err)
			}
			if p.Status != "submitted" || p.Snapshot.Body != "" || len(p.Drafts) != 0 || p.ContentFingerprint != d.ContentFingerprint || p.ConfirmationFingerprint != d.ConfirmationFingerprint {
				t.Fatalf("submitted private content retained or frozen identity changed: %+v", p)
			}
			job, err := s.Get(context.Background(), d.JobIDs[0])
			if err != nil || job.Markdown != "" || job.Status != "cancelled" || job.ExternalStarted {
				t.Fatalf("unexecuted revoked body still readable: %+v %v", job, err)
			}
		})
	}
}

func TestIntegrationRevocationPreservesOnlyLeasedOrUncertainJobBodies(t *testing.T) {
	for _, mode := range []string{"active_lease", "waiting_lease", "external_started", "unknown_result"} {
		t.Run(mode, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			var claim *Claim
			if mode != "unknown_result" {
				claim = guardClaim(t, s)
			}
			if mode == "waiting_lease" {
				guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Status = "waiting_user"; r.Ready = false; r.SourceGuardBlocked = true })
			}
			if mode == "external_started" {
				if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "unknown_result" {
				guardMutateRecord(t, s, d.JobIDs[0], func(r *record) {
					r.ExternalStarted = true
					r.Outcome = "unknown"
					r.Status = "reconciling"
					r.RunMode = "reconcile"
					r.Ready = true
					r.AutoReconcileStarted = true
				})
			}
			if _, err := h.applyIntegrationEvent(context.Background(), c, IntegrationSourceEvent{
				EventID:            "revoke-retained-job",
				SourceID:           c.SourceID,
				ArticleID:          d.ArticleID,
				StateSeq:           2,
				SourceVersion:      1,
				Type:               "private",
				Status:             "private",
				AuthorizationValid: false,
			}); err != nil {
				t.Fatal(err)
			}
			p, _ := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
			if p.Snapshot.Body != "" || len(p.Drafts) != 0 {
				t.Fatal("redundant preparation copy retained after revocation")
			}
			r := guardReadRecord(t, s, d.JobIDs[0])
			if r.Markdown == "" || !r.SourceGuardBlocked {
				t.Fatal("required protected browser/reconciliation content was discarded")
			}
			if claim != nil && r.LeaseToken != claim.LeaseToken {
				t.Fatal("active browser lease released before stop")
			}
			if mode == "active_lease" || mode == "waiting_lease" {
				clock := s.now().Add(2 * time.Minute)
				s.now = func() time.Time { return clock }
				if err := s.Maintain(context.Background()); err != nil {
					t.Fatal(err)
				}
				r = guardReadRecord(t, s, d.JobIDs[0])
				if r.Markdown != "" || r.Status != "cancelled" || r.Ready {
					t.Fatalf("expired browser lease retained revoked unexecuted content: %+v", r)
				}
			}
			if mode == "unknown_result" {
				clock := s.now().Add(time.Minute)
				s.now = func() time.Time { return clock }
				next := guardClaim(t, s)
				if next.Job.RunMode != "reconcile" {
					t.Fatal("revoked task recovery was not read-only")
				}
			}
		})
	}
}

func TestIntegrationNonRevocationPausesKeepAcceptedBodies(t *testing.T) {
	for _, mode := range []string{"permission_changed", "content_changed"} {
		t.Run(mode, func(t *testing.T) {
			h, s, c, d := guardFixture(t)
			if mode == "content_changed" {
				if _, err := h.applyIntegrationEvent(context.Background(), c, IntegrationSourceEvent{
					EventID:            "content-change-keeps-review-copy",
					SourceID:           c.SourceID,
					ArticleID:          d.ArticleID,
					StateSeq:           2,
					SourceVersion:      2,
					Type:               "updated",
					Status:             "published",
					AuthorizationValid: true,
					ContentFingerprint: strings.Repeat("b", 64),
				}); err != nil {
					t.Fatal(err)
				}
			} else {
				claim := guardClaim(t, s)
				c.Scopes = []string{"targets:read"}
				guardUpdateClient(t, s, c)
				if err := s.Progress(context.Background(), d.JobIDs[0], ProgressInput{LeaseToken: claim.LeaseToken, Stage: "opening_editor", ExternalStarted: true}); err == nil {
					t.Fatal("expected pause")
				}
			}
			p, _ := integrationReadPreparation(context.Background(), s.pool, d.PreparationID, false)
			r := guardReadRecord(t, s, d.JobIDs[0])
			if p.Snapshot.Body == "" || len(p.Drafts) == 0 || r.Markdown == "" {
				t.Fatalf("recoverable pause discarded frozen content: %s", mode)
			}
		})
	}
}

func TestIntegrationGuardMissingFrozenContentCannotExecute(t *testing.T) {
	for _, mode := range []string{"job_body", "prepared_drafts"} {
		t.Run(mode, func(t *testing.T) {
			_, s, _, d := guardFixture(t)
			if mode == "job_body" {
				guardMutateRecord(t, s, d.JobIDs[0], func(r *record) { r.Markdown = "" })
			} else {
				if err := s.locked(context.Background(), func(tx pgx.Tx, _ time.Time) error {
					p, err := integrationReadPreparation(context.Background(), tx, d.PreparationID, true)
					if err != nil {
						return err
					}
					p.Snapshot = IntegrationSnapshot{}
					p.Drafts = []IntegrationDraft{}
					return integrationSavePreparation(context.Background(), tx, p)
				}); err != nil {
					t.Fatal(err)
				}
			}
			if claim, err := s.Claim(context.Background(), "guard-worker"); err != nil || claim != nil {
				t.Fatalf("missing frozen content was executable: %+v %v", claim, err)
			}
		})
	}
}
