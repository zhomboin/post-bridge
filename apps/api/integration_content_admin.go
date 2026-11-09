package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (h *handler) revokeIntegrationPreparation(ctx context.Context, id string) (IntegrationPreparation, error) {
	var out IntegrationPreparation
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		p, e := integrationReadPreparation(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if p.Status == "submitted" {
			return ErrConflict
		}
		p.Status = "revoked"
		p.Confirmed = false
		p.ConfirmationFingerprint = ""
		p.Snapshot = IntegrationSnapshot{}
		p.Drafts = []IntegrationDraft{}
		if e = integrationSavePreparation(ctx, tx, p); e != nil {
			return e
		}
		out = p
		return integrationAudit(ctx, tx, p.ClientID, "preparation_revoked", "admin", now)
	})
	return out, err
}
func (h *handler) integrationDistributionSummary(ctx context.Context, d IntegrationDistribution) (map[string]any, error) {
	raw, _ := json.Marshal(d)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	children := []map[string]any{}
	status := "completed"
	complete := 0
	resumeAllowed, resumeBlocked := false, false
	if err := h.store.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE record->>'integration_distribution_id'=$1 AND COALESCE(record->>'LeaseToken','')<>'' AND (record->>'LeaseExpiresAt')::timestamptz>$2)", d.ID, h.store.now()).Scan(&resumeBlocked); err != nil {
		return nil, err
	}
	for _, id := range d.JobIDs {
		job, err := h.store.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		if job.Status == "waiting_user" && (job.ErrorCode == "source_guard_failed" || job.ErrorCode == "source_changed") {
			resumeAllowed = true
		}
		if job.Status == "failed" || job.Status == "cancelled" {
			resumeBlocked = true
		}
		external := "not_submitted"
		if job.Outcome == "draft_saved" {
			external = "draft_saved"
		} else if job.Outcome == "unknown" {
			external = "unknown"
		}
		var checked *time.Time
		if external == "draft_saved" && job.Status == "succeeded" {
			checked = job.FinishedAt
		}
		child := map[string]any{
			"id":                job.ID,
			"platform":          job.Platform,
			"account_id":        job.AccountID,
			"operation":         job.Kind,
			"status":            job.Status,
			"external_status":   external,
			"outcome":           job.Outcome,
			"last_confirmed_at": checked,
			"remote_id":         job.RemoteID,
			"remote_url":        job.RemoteURL,
			"error_code":        job.ErrorCode,
			"error_message":     job.ErrorMessage,
			"detail_url":        h.origin + "/jobs/" + id,
		}
		children = append(children, child)
		switch job.Status {
		case "succeeded", "cancelled":
			complete++
		case "waiting_user", "failed", "reconciling":
			status = "needs_attention"
		default:
			if status != "needs_attention" {
				status = "in_progress"
			}
		}
	}
	out["children"] = children
	out["status"] = status
	out["completed_children"] = complete
	out["resume_allowed"] = resumeAllowed && !resumeBlocked
	out["detail_url"] = h.origin + "/integrations?tab=distributions&distribution_id=" + d.ID
	return out, nil
}
func (h *handler) listIntegrationDistributions(w http.ResponseWriter, r *http.Request) {
	page, size, ok := pagination(w, r)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "in_progress" && status != "needs_attention" && status != "completed" {
		integrationContentError(w, ErrInvalid)
		return
	}
	stateSQL := `CASE WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.record->>'integration_distribution_id'=d.id AND j.record->>'status' IN ('waiting_user','failed','reconciling')) THEN 'needs_attention' WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.record->>'integration_distribution_id'=d.id AND j.record->>'status' IN ('queued','running')) THEN 'in_progress' ELSE 'completed' END`
	where := " WHERE $1='' OR (" + stateSQL + ")=$1"
	var total int
	if err := h.store.pool.QueryRow(r.Context(), "SELECT count(*) FROM integration_distributions d"+where, status).Scan(&total); err != nil {
		integrationContentError(w, err)
		return
	}
	rows, err := h.store.pool.Query(r.Context(), "SELECT d.record FROM integration_distributions d"+where+" ORDER BY d.created_at DESC,d.id DESC LIMIT $2 OFFSET $3", status, size, (page-1)*size)
	if err != nil {
		integrationContentError(w, err)
		return
	}
	ds := []IntegrationDistribution{}
	for rows.Next() {
		var raw []byte
		var d IntegrationDistribution
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal(raw, &d); err != nil {
			break
		}
		ds = append(ds, d)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		integrationContentError(w, err)
		return
	}
	items := []any{}
	for _, d := range ds {
		summary, e := h.integrationDistributionSummary(r.Context(), d)
		if e != nil {
			integrationContentError(w, e)
			return
		}
		items = append(items, summary)
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": size})
}

func (h *handler) resumeIntegrationDistribution(ctx context.Context, id, fingerprint string) (IntegrationDistribution, error) {
	if h.integrations == nil {
		return IntegrationDistribution{}, ErrIntegrationAuthentication
	}
	d, err := integrationReadDistribution(ctx, h.store.pool, id)
	if err != nil {
		return d, err
	}
	if fingerprint == "" || fingerprint != d.ConfirmationFingerprint {
		return d, ErrConflict
	}
	current, err := h.integrationAllowed(ctx, d.ClientID, "distributions:write", d.Targets)
	if err != nil {
		return d, err
	}
	prep, err := integrationReadPreparation(ctx, h.store.pool, d.PreparationID, false)
	if err != nil {
		return d, err
	}
	if len(prep.Drafts) == 0 {
		return d, ErrIntegrationExpired
	}
	if !prep.AuthorizationExpiresAt.After(h.store.now()) {
		return d, ErrIntegrationExpired
	}
	err = h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		next, e := integrationReadDistribution(ctx, tx, id)
		if e != nil {
			return e
		}
		prep, e = integrationReadPreparation(ctx, tx, next.PreparationID, true)
		if e != nil {
			return e
		}
		if len(prep.Drafts) == 0 || !prep.AuthorizationExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		latest, e := integrationLatestEvent(ctx, tx, next.SourceID, next.ArticleID)
		if e != nil {
			return e
		}
		if !integrationAcceptState(latest, next.StateSeq, next.SourceVersion, next.ContentFingerprint) {
			return ErrIntegrationSourceChanged
		}
		fresh, e := integrationClientAllowedTx(ctx, tx, next.ClientID, "distributions:write", next.Targets, now)
		if e != nil {
			return e
		}
		if err := integrationAuthorizationAllowed(ctx, tx, next.SourceID, next.ArticleID, prep.AuthorizationID); err != nil {
			return err
		}
		if fresh.SourceID != next.SourceID {
			return ErrIntegrationPermission
		}
		if fresh.GrantVersion != current.GrantVersion {
			return ErrConflict
		}
		for _, jobID := range next.JobIDs {
			job, e := load(ctx, tx, jobID)
			if e != nil {
				return e
			}
			if job.LeaseToken != "" && job.LeaseExpiresAt.After(now) {
				return ErrConflict
			}
			if job.Markdown == "" {
				return ErrIntegrationExpired
			}
			if job.Status == "waiting_user" {
				if e = job.action("resume", ActionInput{}, now, nil); e != nil {
					return e
				}
				job.SourceGuardBlocked = false
				job.ErrorCode = ""
				job.ErrorMessage = ""
				if e = save(ctx, tx, job); e != nil {
					return e
				}
				if e = appendLog(ctx, tx, job, "info", "管理员已重新确认来源授权并恢复原任务", now); e != nil {
					return e
				}
			} else if job.Status != "succeeded" && job.Status != "reconciling" {
				return ErrConflict
			}
		}
		next.GrantVersion = fresh.GrantVersion
		raw, e := json.Marshal(next)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE integration_distributions SET record=$2 WHERE id=$1", id, raw); e != nil {
			return e
		}
		d = next
		return integrationAudit(ctx, tx, d.ClientID, "distribution_reconfirmed", "admin", now)
	})
	return d, err
}
