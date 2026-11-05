package bridge

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrIntegrationNotCancellable = errors.New("integration_distribution_not_cancellable")

func (h *handler) cancelIntegrationDistribution(ctx context.Context, client IntegrationClient, id string) (IntegrationDistribution, error) {
	var out IntegrationDistribution
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		d, err := integrationReadDistribution(ctx, tx, id)
		if err != nil {
			return err
		}
		if d.ClientID != client.ID || d.SourceID != client.SourceID {
			return ErrNotFound
		}
		fresh, err := integrationClientAllowedTx(ctx, tx, client.ID, "distributions:write", d.Targets, now)
		if err != nil {
			return err
		}
		if fresh.SourceID != d.SourceID {
			return ErrNotFound
		}
		if len(d.JobIDs) == 0 {
			return ErrIntegrationNotCancellable
		}
		jobs := make([]*record, 0, len(d.JobIDs))
		for _, jobID := range d.JobIDs {
			r, err := load(ctx, tx, jobID)
			if err != nil {
				return err
			}
			if r.IntegrationDistributionID != d.ID {
				return ErrConflict
			}
			if r.ExternalStarted || r.Outcome == "unknown" || r.Outcome == "draft_saved" || r.RemoteID != "" || r.ReconcileCandidateID != "" || r.RunMode == "reconcile" || r.ManualResolved {
				return ErrIntegrationNotCancellable
			}
			if r.Status != "cancelled" && r.Status != "queued" && r.Status != "running" && r.Status != "waiting_user" && r.Status != "failed" {
				return ErrIntegrationNotCancellable
			}
			jobs = append(jobs, r)
		}
		changed := false
		for _, r := range jobs {
			if r.Status == "cancelled" || r.Status == "running" && r.CancelRequested {
				continue
			}
			if r.Status == "running" {
				if err = r.action("cancel", ActionInput{}, now, nil); err != nil {
					return err
				}
			} else {
				r.Status = "cancelled"
				r.Ready = false
				r.FinishedAt = &now
			}
			r.CancelRequested = true
			r.RetryAllowed = false
			r.UpdatedAt = now
			if err = save(ctx, tx, r); err != nil {
				return err
			}
			if err = appendLog(ctx, tx, r, "info", "调用方请求停止分发任务", now); err != nil {
				return err
			}
			changed = true
		}
		out = d
		if !changed {
			return nil
		}
		return integrationAudit(ctx, tx, client.ID, "distribution_cancelled", "integration", now)
	})
	return out, err
}
