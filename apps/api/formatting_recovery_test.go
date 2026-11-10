package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

func TestFormattingAutomaticOutboxAndRecovery(t *testing.T) {
	h, c, call := formattingFixture(t)
	c = enableSourceFormatting(t, h, c)
	snapshot := IntegrationSnapshot{Title: "自动格式化来源文章", Body: "# 技术说明\n\n完整正文。", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)
	input := IntegrationPrepareInput{RequestID: "auto-prepare", SourceID: c.SourceID, ArticleID: "auto-article", SourceVersion: 1, StateSeq: 1, AuthorizationID: "auto-auth", AuthorizationExpiresAt: h.store.now().Add(time.Hour), ContentFingerprint: fp, Snapshot: snapshot, Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}}, Formatting: &FormattingAuthorization{AllowAIProcessing: true, Platforms: []string{"csdn"}, AutoGenerate: true}}
	p := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integrations/v1/preparations", input, false), 201)
	ctx := context.Background()
	h.enqueueAutomaticFormatting(ctx)
	var status string
	if err := h.store.pool.QueryRow(ctx, "SELECT status FROM formatting_automatic WHERE preparation_id=$1", p.ID).Scan(&status); err != nil || status != "done" {
		t.Fatal("automatic outbox failed", status, err)
	}
	h.enqueueAutomaticFormatting(ctx)
	var count int
	if err := h.store.pool.QueryRow(ctx, "SELECT count(*) FROM formatting_jobs").Scan(&count); err != nil || count != 1 {
		t.Fatal("automatic task duplicated", count, err)
	}
	claim, err := h.claimFormatting(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.pool.Exec(ctx, "UPDATE formatting_jobs SET lease_expires_at=$2 WHERE id=$1", claim.Job.ID, h.store.now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	h.maintainFormatting(ctx)
	var raw []byte
	if err = h.store.pool.QueryRow(ctx, "SELECT record FROM formatting_jobs WHERE id=$1", claim.Job.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var job FormattingJob
	if json.Unmarshal(raw, &job) != nil || job.Status != "failed" || job.ErrorCode != "processing_interrupted" {
		t.Fatal("unknown request automatically retried", job.Status)
	}
	if _, err = h.claimFormatting(ctx); err == nil {
		t.Fatal("interrupted model request retried")
	}
}

func TestFormattingOwnershipAndExpiry(t *testing.T) {
	h, _, call := formattingFixture(t)
	session := formattingLocalSession(t, call)
	ctx := scoped(context.Background(), tenantScope{UserID: "other-user", CallerID: "formatting:test"})
	err := h.store.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		_, err := h.readFormattingSession(ctx, tx, session.ID, false)
		return err
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign session readable", err)
	}
	session.ExpiresAt = h.store.now().Add(-time.Second).Format(time.RFC3339Nano)
	raw, _ := json.Marshal(session)
	if _, err = h.store.pool.Exec(context.Background(), "UPDATE formatting_sessions SET record=$2 WHERE id=$1", session.ID, raw); err != nil {
		t.Fatal(err)
	}
	if w := call("GET", "/api/formatting-sessions/"+session.ID, nil, true); w.Code != 410 {
		t.Fatal("expired snapshot readable", w.Code)
	}
}
