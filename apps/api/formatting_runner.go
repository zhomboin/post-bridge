package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type formattingRuns struct {
	sync.Mutex
	cancels map[string]context.CancelFunc
}
type formattingClaim struct {
	Job   FormattingJob
	Owner string
	Lease string
}

func (h *handler) cancelFormattingRun(id string) {
	h.formattingRuns.Lock()
	defer h.formattingRuns.Unlock()
	if cancel := h.formattingRuns.cancels[id]; cancel != nil {
		cancel()
	}
}
func (h *handler) claimFormatting(ctx context.Context) (formattingClaim, error) {
	var out formattingClaim
	tx, err := h.store.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(72341822)"); err != nil {
		return out, err
	}
	var running int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM formatting_jobs WHERE record->>'status'='running' AND lease_expires_at>$1", h.store.now()).Scan(&running); err != nil {
		return out, err
	}
	if running >= h.formattingConfig.MaxInFlight {
		return out, pgx.ErrNoRows
	}
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT j.record,j.owner_user_id FROM formatting_jobs j WHERE j.record->>'status'='queued'
 AND NOT EXISTS(SELECT 1 FROM formatting_jobs busy WHERE busy.owner_user_id=j.owner_user_id AND busy.record->>'status'='running' AND busy.lease_expires_at>$1)
 ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, h.store.now()).Scan(&raw, &out.Owner)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out.Job); err != nil {
		return out, err
	}
	out.Job.Status = "running"
	out.Job.Stage = "analyzing"
	out.Job.UpdatedAt = h.store.now().Format(time.RFC3339Nano)
	out.Lease = randomToken()
	if err = saveFormattingJob(ctx, tx, out.Job); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "UPDATE formatting_jobs SET lease_token=$2,lease_expires_at=$3 WHERE id=$1", out.Job.ID, out.Lease, h.store.now().Add(h.formattingConfig.Timeout+120*time.Second)); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (h *handler) formattingCheckpoint(ctx context.Context, c formattingClaim, stage string) (FormattingSession, error) {
	var session FormattingSession
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var lease string
		var until time.Time
		if err := tx.QueryRow(ctx, "SELECT lease_token,lease_expires_at FROM formatting_jobs WHERE id=$1 FOR UPDATE", c.Job.ID).Scan(&lease, &until); err != nil {
			return err
		}
		if lease != c.Lease || !until.After(now) {
			return ErrConflict
		}
		job, err := readFormattingJob(ctx, tx, c.Job.ID, false)
		if err != nil {
			return err
		}
		if job.Status != "running" {
			return ErrConflict
		}
		session, err = h.readFormattingSession(ctx, tx, job.SessionID, false)
		if err != nil {
			return err
		}
		if stage != "" {
			job.Stage = stage
			job.UpdatedAt = now.Format(time.RFC3339Nano)
			return saveFormattingJob(ctx, tx, job)
		}
		return nil
	})
	return session, err
}
func (h *handler) runFormatting(parent context.Context, c formattingClaim) {
	ctx, cancel := context.WithTimeout(scoped(parent, tenantScope{UserID: c.Owner, CallerID: "formatting:" + c.Job.ID}), h.formattingConfig.Timeout+90*time.Second)
	h.formattingRuns.Lock()
	if h.formattingRuns.cancels == nil {
		h.formattingRuns.cancels = map[string]context.CancelFunc{}
	}
	h.formattingRuns.cancels[c.Job.ID] = cancel
	h.formattingRuns.Unlock()
	defer func() {
		cancel()
		h.formattingRuns.Lock()
		delete(h.formattingRuns.cancels, c.Job.ID)
		h.formattingRuns.Unlock()
	}()
	watchDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-watchDone:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := h.formattingCheckpoint(ctx, c, ""); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer close(watchDone)
	output, usage, err := h.executeFormatting(ctx, c)
	finish, cancelFinish := context.WithTimeout(scoped(context.Background(), tenantScope{UserID: c.Owner, CallerID: "formatting:" + c.Job.ID}), 5*time.Second)
	defer cancelFinish()
	_ = h.store.locked(finish, func(tx pgx.Tx, now time.Time) error {
		var lease string
		if e := tx.QueryRow(finish, "SELECT lease_token FROM formatting_jobs WHERE id=$1 FOR UPDATE", c.Job.ID).Scan(&lease); e != nil {
			return e
		}
		if lease != c.Lease {
			return ErrConflict
		}
		job, e := readFormattingJob(finish, tx, c.Job.ID, false)
		if e != nil {
			return e
		}
		if job.Status != "running" {
			return nil
		}
		if _, guardErr := h.readFormattingSession(finish, tx, job.SessionID, false); guardErr != nil {
			err = guardErr
		}
		job.InputTokens = usage.Input
		job.OutputTokens = usage.Output
		job.Status = "failed"
		job.Stage = "finished"
		job.ErrorCode = formattingErrorCode(err)
		if err == nil {
			job.Status = "succeeded"
			job.Result = &output
			for _, issue := range output.Issues {
				if issue.Blocking {
					job.Status = "needs_review"
				}
			}
		}
		job.UpdatedAt = now.Format(time.RFC3339Nano)
		if e = saveFormattingJob(finish, tx, job); e != nil {
			return e
		}
		if e = saveFormattingRevision(finish, tx, job); e != nil {
			return e
		}
		if usage.Input+usage.Output > 0 {
			_, e = tx.Exec(finish, "UPDATE formatting_jobs SET reservation=$2 WHERE id=$1", job.ID, usage.Input+usage.Output)
		}
		return e
	})
}
func formattingErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var e formattingError
	if errors.As(err, &e) {
		return e.Error()
	}
	if errors.Is(err, ErrFormattingContent) {
		return "content_invalid"
	}
	if errors.Is(err, ErrIntegrationPermission) || errors.Is(err, ErrIntegrationExpired) || errors.Is(err, ErrIntegrationSourceChanged) {
		return "source_unavailable"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "processing_interrupted"
	}
	return "processing_failed"
}
func (h *handler) maintainFormatting(ctx context.Context) {
	_, _ = h.store.pool.Exec(ctx, "UPDATE formatting_automatic SET status='queued' WHERE status='running' AND available_at<=$1", h.store.now())
	h.enqueueAutomaticFormatting(ctx)
	_, _ = h.store.pool.Exec(ctx, `UPDATE formatting_jobs SET record=record || jsonb_build_object('status','failed','stage','finished','error_code','processing_interrupted'),lease_token='' WHERE record->>'status'='running' AND lease_expires_at<=$1`, h.store.now())
	_, _ = h.store.pool.Exec(ctx, "DELETE FROM formatting_assets WHERE expires_at<=$1", h.store.now())
	// 先清理素材再清理任务；到期内容不会永久留在队列和数据库中。
	_, _ = h.store.pool.Exec(ctx, `DELETE FROM formatting_assets WHERE job_id IN (SELECT j.id FROM formatting_jobs j JOIN formatting_sessions s ON s.id=j.session_id WHERE s.expires_at<$1)`, h.store.now().Add(-24*time.Hour))
	_, _ = h.store.pool.Exec(ctx, "DELETE FROM formatting_jobs WHERE session_id IN (SELECT id FROM formatting_sessions WHERE expires_at<$1)", h.store.now().Add(-24*time.Hour))
	_, _ = h.store.pool.Exec(ctx, "DELETE FROM formatting_sessions WHERE expires_at<$1", h.store.now().Add(-24*time.Hour))
}
func (h *handler) runFormattingScheduler(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var group sync.WaitGroup
	defer group.Wait()
	tick := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if tick%10 == 0 {
				h.maintainFormatting(ctx)
			}
			tick++
			claim, err := h.claimFormatting(ctx)
			if err == nil {
				group.Add(1)
				go func() {
					defer group.Done()
					h.runFormatting(ctx, claim)
				}()
			}
		}
	}
}
