package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) integrationGuardAllowed(ctx context.Context, tx pgx.Tx, r *record, now time.Time) error {
	if s.integrations == nil || r.SourceGuardBlocked {
		return ErrIntegrationAuthentication
	}
	d, err := integrationReadDistribution(ctx, tx, r.IntegrationDistributionID)
	if err != nil {
		return err
	}
	p, err := integrationReadPreparation(ctx, tx, d.PreparationID, false)
	if err != nil {
		return err
	}
	if err = integrationAuthorizationAllowed(ctx, tx, d.SourceID, d.ArticleID, p.AuthorizationID); err != nil {
		return err
	}
	c, err := integrationClientAllowedTx(ctx, tx, d.ClientID, "distributions:write", d.Targets, now)
	if err != nil {
		return err
	}
	if !p.AuthorizationExpiresAt.After(now) {
		return ErrIntegrationExpired
	}
	if c.Status != "active" || !c.ExpiresAt.After(now) || c.GrantVersion != d.GrantVersion || c.SourceID != d.SourceID || p.SourceID != d.SourceID || p.ArticleID != d.ArticleID || p.ClientID != c.ID || p.Status != "submitted" || len(p.Drafts) == 0 || strings.TrimSpace(r.Markdown) == "" || p.ContentFingerprint != d.ContentFingerprint || p.AuthorizationID == "" || !integrationHas(d.JobIDs, r.ID) || !integrationHas(c.Scopes, "distributions:write") || !integrationHas(c.Accounts, r.AccountID) || !integrationHas(c.Operations, r.Kind) {
		return ErrIntegrationPermission
	}
	matched := false
	for _, target := range d.Targets {
		if target.Platform == r.Platform && target.AccountID == r.AccountID && target.Operation == r.Kind {
			matched = true
		}
	}
	if !matched || r.Kind != "save_draft" {
		return ErrIntegrationPermission
	}
	latest, err := integrationLatestEvent(ctx, tx, d.SourceID, d.ArticleID)
	if err != nil {
		return err
	}
	if latest.StateSeq >= d.StateSeq {
		if latest.Status != "published" || !latest.AuthorizationValid || latest.ContentFingerprint != "" && latest.ContentFingerprint != d.ContentFingerprint || latest.AuthorizationID != "" && latest.AuthorizationID != p.AuthorizationID {
			return ErrIntegrationSourceChanged
		}
	}
	return nil
}

func integrationGuardPause(ctx context.Context, tx pgx.Tx, r *record, now time.Time) error {
	r.SourceGuardBlocked = true
	r.ErrorCode = "source_guard_failed"
	r.ErrorMessage = "来源授权检查未通过，需要重新确认"
	r.RetryAllowed = false
	r.UpdatedAt = now
	r.FinishedAt = nil
	r.Ready = false
	if r.ExternalStarted {
		r.Status = "reconciling"
		r.RunMode = "reconcile"
		r.Outcome = "unknown"
		r.AutoReconcileStarted = true
		r.Ready = true
		r.AvailableAt = now.Add(20 * time.Second)
	} else {
		r.Status = "waiting_user"
	}
	// 保留浏览器仍可能占用的领取凭据，直到领取到期。
	if err := save(ctx, tx, r); err != nil {
		return err
	}
	return appendLog(ctx, tx, r, "warning", "来源授权检查已阻止后续写入", now)
}

func (s *Store) integrationClaimAllowed(ctx context.Context, tx pgx.Tx, r *record, now time.Time) (bool, error) {
	if r.IntegrationDistributionID == "" || r.RunMode == "reconcile" || readKind(r.Kind) {
		return true, nil
	}
	if err := s.integrationGuardAllowed(ctx, tx, r, now); err != nil {
		if err = integrationGuardPause(ctx, tx, r, now); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}

func (s *Store) integrationActionAllowed(ctx context.Context, tx pgx.Tx, r *record, action string, now time.Time) error {
	if r.IntegrationDistributionID == "" || action != "resume" && action != "retry" {
		return nil
	}
	if r.SourceGuardBlocked || r.ErrorCode == "source_guard_failed" || r.ErrorCode == "source_changed" {
		return ErrConflict
	}
	if err := s.integrationGuardAllowed(ctx, tx, r, now); err != nil {
		return ErrConflict
	}
	return nil
}

func (s *Store) integrationProgress(ctx context.Context, id string, in ProgressInput) (bool, error) {
	handled, blocked := false, false
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if r.IntegrationDistributionID == "" || r.RunMode == "reconcile" || readKind(r.Kind) {
			return nil
		}
		rank, known := stages[in.Stage]
		if !known || (rank < 2 || rank > 5) && !in.ExternalStarted && in.RemoteID == "" {
			return nil
		}
		handled = true
		if !leaseValid(r, in.LeaseToken, now) || r.CancelRequested || r.RunMode != "execute" {
			return ErrConflict
		}
		candidate := *r
		if err = candidate.progress(in, now); err != nil {
			return err
		}
		if err = s.integrationGuardAllowed(ctx, tx, r, now); err != nil {
			blocked = true
			return integrationGuardPause(ctx, tx, r, now)
		}
		if in.RemoteID != "" {
			var exists bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE id<>$1 AND record->>'remote_id'=$2)", id, in.RemoteID).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return ErrConflict
			}
		}
		if in.Observation != nil {
			if err = captureObservation(ctx, tx, r, in, now); err != nil {
				return err
			}
		}
		if err = r.progress(in, now); err != nil {
			return err
		}
		if err = save(ctx, tx, r); err != nil {
			return err
		}
		return appendLog(ctx, tx, r, "info", "执行阶段已更新", now)
	})
	if err == nil && blocked {
		err = ErrConflict
	}
	return handled, err
}

func (s *Store) maintainIntegrations(ctx context.Context, tx pgx.Tx, now time.Time) error {
	rows, err := tx.Query(ctx, "SELECT record FROM integration_preparations FOR UPDATE")
	if err != nil {
		return err
	}
	preparations := []IntegrationPreparation{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var p IntegrationPreparation
		if err = json.Unmarshal(raw, &p); err != nil {
			rows.Close()
			return err
		}
		preparations = append(preparations, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	cutoff := now.Add(-30 * 24 * time.Hour)
	for _, p := range preparations {
		var distributionID string
		err = tx.QueryRow(ctx, "SELECT id FROM integration_distributions WHERE preparation_id=$1", p.ID).Scan(&distributionID)
		purge := false
		if errors.Is(err, pgx.ErrNoRows) {
			purge = p.Status == "revoked" || p.Status == "expired" || !p.ExpiresAt.After(now)
			if !purge {
				client, e := integrationLoadClient(ctx, tx, p.ClientID)
				if e != nil {
					return e
				}
				purge = client.Status == "revoked" || !client.ExpiresAt.After(now)
			}
			if !purge {
				latest, e := integrationLatestEvent(ctx, tx, p.SourceID, p.ArticleID)
				if e != nil {
					return e
				}
				if latest.StateSeq >= p.StateSeq {
					purge = latest.Type == "private" || latest.Type == "deleted" || latest.Type == "unpublished" || latest.Type == "authorization_revoked" || latest.ContentFingerprint != "" && latest.ContentFingerprint != p.ContentFingerprint
				}
			}
			if purge {
				if p.Status != "revoked" {
					p.Status = "expired"
				}
				p.Confirmed = false
			}
		} else if err != nil {
			return err
		} else {
			d, e := integrationReadDistribution(ctx, tx, distributionID)
			if e != nil {
				return e
			}
			purge = len(d.JobIDs) > 0
			for _, id := range d.JobIDs {
				r, e := load(ctx, tx, id)
				if e != nil {
					return e
				}
				if len(p.Drafts) == 0 && r.SourceGuardBlocked && r.Markdown != "" && integrationCanPurgeUnexecutedJob(r, now) {
					if e = integrationPurgeUnexecutedJob(ctx, tx, r, now); e != nil {
						return e
					}
				}
				if !(r.Status == "succeeded" || r.Status == "failed" || r.Status == "cancelled") || r.Outcome == "unknown" || r.RetryAllowed || !r.UpdatedAt.Before(cutoff) || r.LeaseToken != "" && r.LeaseExpiresAt.After(now) {
					purge = false
					break
				}
			}
		}
		if purge {
			p.Snapshot = IntegrationSnapshot{}
			p.Drafts = []IntegrationDraft{}
			if err = integrationSavePreparation(ctx, tx, p); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec(ctx, "DELETE FROM integration_nonces WHERE expires_at<=$1", now.Add(-time.Second)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM integration_rate_windows WHERE window_start<$1", (now.Unix()-601)/60); err != nil {
		return err
	}
	return nil
}
