package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (h *handler) enqueueAutomaticFormatting(ctx context.Context) {
	var prepID, owner string
	tx, err := h.store.pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `SELECT preparation_id,owner_user_id FROM formatting_automatic WHERE status='queued' AND available_at<=$1 ORDER BY available_at,preparation_id LIMIT 1 FOR UPDATE SKIP LOCKED`, h.store.now()).Scan(&prepID, &owner)
	if err != nil {
		return
	}
	_, err = tx.Exec(ctx, "UPDATE formatting_automatic SET status='running',available_at=$2 WHERE preparation_id=$1", prepID, h.store.now().Add(2*time.Minute))
	if err != nil || tx.Commit(ctx) != nil {
		return
	}
	tenant := scoped(ctx, tenantScope{UserID: owner, CallerID: "formatting:auto"})
	err = h.automaticFormattingPreparation(tenant, prepID)
	status := "done"
	next := h.store.now()
	if err != nil {
		status = "blocked"
		var e formattingError
		if errors.As(err, &e) && e == "formatting_quota" {
			status = "queued"
			next = next.Add(time.Minute)
		}
	}
	_, _ = h.store.pool.Exec(ctx, "UPDATE formatting_automatic SET status=$2,available_at=$3 WHERE preparation_id=$1", prepID, status, next)
}
func (h *handler) automaticFormattingPreparation(ctx context.Context, id string) error {
	p, err := integrationReadPreparation(ctx, h.store.pool, id, false)
	if err != nil {
		return err
	}
	if p.Formatting == nil || !p.Formatting.AutoGenerate {
		return ErrIntegrationPermission
	}
	request := "auto-" + p.ID
	var session FormattingSession
	var raw []byte
	err = h.store.pool.QueryRow(ctx, "SELECT record FROM formatting_sessions WHERE owner_user_id=$1 AND request_id=$2", scopeOf(ctx).UserID, request).Scan(&raw)
	if err == nil {
		err = json.Unmarshal(raw, &session)
	} else if errors.Is(err, pgx.ErrNoRows) {
		session, err = h.createFormattingSession(ctx, formattingSessionInput{RequestID: request, PreparationID: p.ID, BaseRevision: p.Revision, Platforms: p.Formatting.Platforms, AllowAIProcessing: true})
	}
	if err != nil {
		return err
	}
	for _, platform := range session.Platforms {
		template := ""
		if platform == "xiaohongshu" {
			template = "technical"
		}
		_, _, err = h.createFormattingJob(ctx, session.ID, formattingJobInput{RequestID: request + "-" + platform, Platform: platform, Template: template})
		if err != nil {
			return err
		}
	}
	return nil
}
