package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"time"
)

func integrationReadPreparation(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string, locked bool) (IntegrationPreparation, error) {
	var p IntegrationPreparation
	var data []byte
	sql := "SELECT record FROM integration_preparations WHERE id=$1"
	if locked {
		sql += " FOR UPDATE"
	}
	err := q.QueryRow(ctx, sql, id).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	err = json.Unmarshal(data, &p)
	return p, err
}
func integrationSavePreparation(ctx context.Context, tx pgx.Tx, p IntegrationPreparation) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE integration_preparations SET record=$2 WHERE id=$1", p.ID, raw)
	return err
}
func integrationReadDistribution(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (IntegrationDistribution, error) {
	var d IntegrationDistribution
	var raw []byte
	err := q.QueryRow(ctx, "SELECT record FROM integration_distributions WHERE id=$1", id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal(raw, &d)
	}
	return d, err
}
func (h *handler) integrationAllowed(ctx context.Context, id, scope string, targets []IntegrationTarget) (IntegrationClient, error) {
	if h.integrations == nil {
		return IntegrationClient{}, ErrIntegrationAuthentication
	}
	for _, target := range targets {
		if err := h.integrations.CheckPermission(ctx, id, scope, target.AccountID, target.Operation); err != nil {
			return IntegrationClient{}, err
		}
	}
	return h.integrations.Client(ctx, id)
}
func integrationLatestEvent(ctx context.Context, tx pgx.Tx, source, article string) (IntegrationSourceEvent, error) {
	var event IntegrationSourceEvent
	var raw []byte
	err := tx.QueryRow(ctx, "SELECT record FROM integration_source_states WHERE source_id=$1 AND article_id=$2", source, article).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return event, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &event)
	}
	return event, err
}
func integrationAcceptState(latest IntegrationSourceEvent, seq, version int64, fp string) bool {
	if latest.StateSeq > seq {
		return false
	}
	if latest.StateSeq == seq {
		if latest.SourceVersion != version {
			return false
		}
		if latest.Status != "published" || !latest.AuthorizationValid {
			return false
		}
		if latest.Type == "private" || latest.Type == "deleted" || latest.Type == "unpublished" || latest.Type == "authorization_revoked" {
			return false
		}
		if latest.ContentFingerprint != "" && latest.ContentFingerprint != fp {
			return false
		}
	}
	return true
}
func (h *handler) prepareIntegration(ctx context.Context, client IntegrationClient, in IntegrationPrepareInput) (IntegrationPreparation, bool, error) {
	var out IntegrationPreparation
	created := false
	if !validKey(in.RequestID) || !validKey(in.ArticleID) || !validKey(in.AuthorizationID) || in.SourceID != client.SourceID || in.SourceVersion < 1 || in.StateSeq < 1 {
		return out, false, ErrInvalid
	}
	in.Snapshot = integrationNormalizeSnapshot(in.Snapshot)
	if err := validateIntegrationSnapshot(in.Snapshot); err != nil {
		return out, false, err
	}
	if err := validateIntegrationTargets(in.Targets); err != nil {
		return out, false, err
	}
	fp, err := IntegrationContentFingerprint(in.Snapshot)
	if err != nil || fp != in.ContentFingerprint {
		return out, false, ErrConflict
	}
	client, err = h.integrationAllowed(ctx, client.ID, "preparations:write", in.Targets)
	if err != nil {
		return out, false, err
	}
	digest := integrationDigest(in)
	err = h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		fresh, authErr := integrationClientAllowedTx(ctx, tx, client.ID, "preparations:write", in.Targets, now)
		if authErr != nil {
			return authErr
		}
		if fresh.SourceID != in.SourceID {
			return ErrIntegrationPermission
		}
		client = fresh
		if err := integrationAuthorizationAllowed(ctx, tx, client.SourceID, in.ArticleID, in.AuthorizationID); err != nil {
			return err
		}
		var raw []byte
		var existingFP string
		e := tx.QueryRow(ctx, "SELECT record,fingerprint FROM integration_preparations WHERE client_id=$1 AND request_id=$2 FOR UPDATE", client.ID, in.RequestID).Scan(&raw, &existingFP)
		if e == nil {
			if existingFP != digest {
				return ErrConflict
			}
			if e = json.Unmarshal(raw, &out); e != nil {
				return e
			}
			latest, e := integrationLatestEvent(ctx, tx, out.SourceID, out.ArticleID)
			if e != nil {
				return e
			}
			if !out.ExpiresAt.After(now) || out.Status == "revoked" || !integrationAcceptState(latest, in.StateSeq, in.SourceVersion, fp) {
				return ErrIntegrationExpired
			}
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if !in.AuthorizationExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		latest, e := integrationLatestEvent(ctx, tx, client.SourceID, in.ArticleID)
		if e != nil {
			return e
		}
		if !integrationAcceptState(latest, in.StateSeq, in.SourceVersion, fp) {
			return ErrIntegrationSourceChanged
		}
		expiry := now.Add(24 * time.Hour)
		if in.AuthorizationExpiresAt.Before(expiry) {
			expiry = in.AuthorizationExpiresAt
		}
		out = IntegrationPreparation{ID: randomToken(), ClientID: client.ID, SourceID: client.SourceID, RequestID: in.RequestID, ArticleID: in.ArticleID, SourceVersion: in.SourceVersion, StateSeq: in.StateSeq, AuthorizationID: in.AuthorizationID, AuthorizationExpiresAt: in.AuthorizationExpiresAt, ContentFingerprint: fp, Snapshot: in.Snapshot, Targets: in.Targets, Revision: 1, DraftRevisionIDs: []string{}, Confirmed: false, Status: "prepared", GrantVersion: client.GrantVersion, ExpiresAt: expiry, CreatedAt: now}
		for _, target := range in.Targets {
			draft := IntegrationDraft{ID: randomToken(), Platform: target.Platform, AccountID: target.AccountID, Operation: target.Operation, Title: in.Snapshot.Title, Markdown: in.Snapshot.Body, Revision: 1}
			out.Drafts = append(out.Drafts, draft)
			out.DraftRevisionIDs = append(out.DraftRevisionIDs, draft.ID)
		}
		raw, e = json.Marshal(out)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO integration_preparations(id,client_id,source_id,article_id,request_id,fingerprint,record,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", out.ID, client.ID, client.SourceID, in.ArticleID, in.RequestID, digest, raw, expiry, now); e != nil {
			return e
		}
		created = true
		return integrationAudit(ctx, tx, client.ID, "preparation_created", "integration", now)
	})
	return out, created, err
}
func (h *handler) updateIntegrationPreparation(ctx context.Context, id string, revision int64, drafts []IntegrationDraft) (IntegrationPreparation, error) {
	var out IntegrationPreparation
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		p, e := integrationReadPreparation(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if p.Status == "submitted" || p.Status == "revoked" || !p.ExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		if p.Revision != revision || len(drafts) != len(p.Drafts) {
			return ErrConflict
		}
		c, e := integrationClientAllowedTx(ctx, tx, p.ClientID, "preparations:write", p.Targets, now)
		if e != nil {
			return e
		}
		if err := integrationAuthorizationAllowed(ctx, tx, p.SourceID, p.ArticleID, p.AuthorizationID); err != nil {
			return err
		}
		if c.SourceID != p.SourceID {
			return ErrIntegrationPermission
		}
		latest, e := integrationLatestEvent(ctx, tx, p.SourceID, p.ArticleID)
		if e != nil {
			return e
		}
		if !integrationAcceptState(latest, p.StateSeq, p.SourceVersion, p.ContentFingerprint) {
			return ErrIntegrationSourceChanged
		}
		next := make([]IntegrationDraft, len(drafts))
		ids := []string{}
		for i, d := range drafts {
			before := p.Drafts[i]
			if d.ID != before.ID || d.Platform != before.Platform || d.AccountID != before.AccountID || d.Operation != before.Operation {
				return ErrConflict
			}
			if e = ValidateCreate(CreateInput{RequestID: "validate", Platform: d.Platform, Kind: d.Operation, Title: d.Title, Markdown: d.Markdown}); e != nil {
				return ErrIntegrationUnsupported
			}
			d.ID = randomToken()
			d.Revision = p.Revision + 1
			next[i] = d
			ids = append(ids, d.ID)
		}
		p.Revision++
		p.Drafts = next
		p.DraftRevisionIDs = ids
		p.Confirmed = false
		p.ConfirmationFingerprint = ""
		p.Status = "prepared"
		p.GrantVersion = c.GrantVersion
		if e = integrationSavePreparation(ctx, tx, p); e != nil {
			return e
		}
		out = p
		return integrationAudit(ctx, tx, c.ID, "preparation_edited", "admin", now)
	})
	return out, err
}
func (h *handler) confirmIntegrationPreparation(ctx context.Context, id string, revision int64) (IntegrationPreparation, error) {
	var out IntegrationPreparation
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		p, e := integrationReadPreparation(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if p.Status == "submitted" || p.Status == "revoked" || !p.ExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		if p.Revision != revision {
			return ErrConflict
		}
		c, e := integrationClientAllowedTx(ctx, tx, p.ClientID, "preparations:write", p.Targets, now)
		if e != nil {
			return e
		}
		if err := integrationAuthorizationAllowed(ctx, tx, p.SourceID, p.ArticleID, p.AuthorizationID); err != nil {
			return err
		}
		if c.SourceID != p.SourceID {
			return ErrIntegrationPermission
		}
		latest, e := integrationLatestEvent(ctx, tx, p.SourceID, p.ArticleID)
		if e != nil {
			return e
		}
		if !integrationAcceptState(latest, p.StateSeq, p.SourceVersion, p.ContentFingerprint) {
			return ErrIntegrationSourceChanged
		}
		p.GrantVersion = c.GrantVersion
		p.Confirmed = true
		p.Status = "confirmed"
		p.ConfirmationFingerprint = integrationConfirmation(p)
		if e = integrationSavePreparation(ctx, tx, p); e != nil {
			return e
		}
		out = p
		return integrationAudit(ctx, tx, c.ID, "preparation_confirmed", "admin", now)
	})
	return out, err
}
func (h *handler) commitIntegrationDistribution(ctx context.Context, client IntegrationClient, in IntegrationSubmitInput) (IntegrationDistribution, bool, error) {
	var out IntegrationDistribution
	created := false
	if !validKey(in.RequestID) || in.SourceID != client.SourceID || !validKey(in.ArticleID) || in.StateSeq < 1 || in.SourceVersion < 1 {
		return out, false, ErrInvalid
	}
	if err := validateIntegrationTargets(in.Targets); err != nil {
		return out, false, err
	}
	current, err := h.integrationAllowed(ctx, client.ID, "distributions:write", in.Targets)
	if err != nil {
		return out, false, err
	}
	digest := integrationDigest(in)
	err = h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		fresh, authErr := integrationClientAllowedTx(ctx, tx, client.ID, "distributions:write", in.Targets, now)
		if authErr != nil {
			return authErr
		}
		if fresh.SourceID != in.SourceID {
			return ErrIntegrationPermission
		}
		current = fresh
		var raw []byte
		var existingFP string
		e := tx.QueryRow(ctx, "SELECT record,fingerprint FROM integration_distributions WHERE client_id=$1 AND request_id=$2", client.ID, in.RequestID).Scan(&raw, &existingFP)
		if e == nil {
			if existingFP != digest {
				return ErrConflict
			}
			return json.Unmarshal(raw, &out)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		p, e := integrationReadPreparation(ctx, tx, in.PreparationID, true)
		if e != nil {
			return e
		}
		if err := integrationAuthorizationAllowed(ctx, tx, p.SourceID, p.ArticleID, p.AuthorizationID); err != nil {
			return err
		}
		if p.ClientID != client.ID || p.SourceID != in.SourceID || p.ArticleID != in.ArticleID {
			return ErrNotFound
		}
		if p.Status != "confirmed" || !p.Confirmed || p.GrantVersion != current.GrantVersion || p.ConfirmationFingerprint != in.ConfirmationFingerprint || p.ConfirmationFingerprint != integrationConfirmation(p) || integrationDigest(p.DraftRevisionIDs) != integrationDigest(in.DraftRevisionIDs) || integrationDigest(p.Targets) != integrationDigest(in.Targets) || p.ContentFingerprint != in.ContentFingerprint {
			return ErrConflict
		}
		if !p.ExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		if in.StateSeq != p.StateSeq || in.SourceVersion != p.SourceVersion {
			return ErrIntegrationSourceChanged
		}
		if !p.AuthorizationExpiresAt.After(now) {
			return ErrIntegrationExpired
		}
		latest, e := integrationLatestEvent(ctx, tx, client.SourceID, in.ArticleID)
		if e != nil {
			return e
		}
		if !integrationAcceptState(latest, p.StateSeq, p.SourceVersion, p.ContentFingerprint) {
			return ErrIntegrationSourceChanged
		}
		if e = integrationAdvanceSnapshotState(ctx, tx, p); e != nil {
			return e
		}
		if err := integrationCheckExistingCopies(ctx, tx, client.SourceID, in.ArticleID, now); err != nil {
			return err
		}
		out = IntegrationDistribution{ID: randomToken(), ClientID: client.ID, SourceID: client.SourceID, ArticleID: in.ArticleID, RequestID: in.RequestID, PreparationID: p.ID, SourceVersion: p.SourceVersion, StateSeq: p.StateSeq, ContentFingerprint: in.ContentFingerprint, ConfirmationFingerprint: in.ConfirmationFingerprint, GrantVersion: current.GrantVersion, Targets: p.Targets, JobIDs: []string{}, CreatedAt: now}
		for i, draft := range p.Drafts {
			job := newRecord(CreateInput{RequestID: fmt.Sprintf("integration:%s:%d", out.ID, i), Platform: draft.Platform, Kind: draft.Operation, Title: draft.Title, Markdown: draft.Markdown}, now)
			job.IntegrationDistributionID = out.ID
			data, e := json.Marshal(job)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)", job.ID, job.RequestID, in.ConfirmationFingerprint, data, now); e != nil {
				return e
			}
			if e = appendLog(ctx, tx, job, "info", "外部来源任务已加入队列", now); e != nil {
				return e
			}
			out.JobIDs = append(out.JobIDs, job.ID)
		}
		raw, e = json.Marshal(out)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO integration_distributions(id,client_id,source_id,article_id,request_id,preparation_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", out.ID, client.ID, client.SourceID, in.ArticleID, in.RequestID, p.ID, digest, raw, now); e != nil {
			return e
		}
		p.Status = "submitted"
		if e = integrationSavePreparation(ctx, tx, p); e != nil {
			return e
		}
		created = true
		return integrationAudit(ctx, tx, client.ID, "distribution_created", "integration", now)
	})
	return out, created, err
}
func (h *handler) applyIntegrationEvent(ctx context.Context, client IntegrationClient, event IntegrationSourceEvent) (bool, error) {
	if event.SourceID != client.SourceID || !integrationEventValid(event) || event.Type == "authorization_revoked" && !validKey(event.AuthorizationID) {
		return false, ErrInvalid
	}
	if err := h.integrations.CheckPermission(ctx, client.ID, "source-events:write", "", ""); err != nil {
		return false, err
	}
	applied := false
	digest := integrationDigest(event)
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		fresh, err := integrationClientAllowedTx(ctx, tx, client.ID, "source-events:write", nil, now)
		if err != nil {
			return err
		}
		if fresh.SourceID != event.SourceID {
			return ErrIntegrationPermission
		}
		var previous string
		err = tx.QueryRow(ctx, "SELECT fingerprint FROM integration_source_events WHERE client_id=$1 AND event_id=$2", client.ID, event.EventID).Scan(&previous)
		if err == nil {
			if previous != digest {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// 单项授权撤销独立持久化，不覆盖整篇文章的实时状态。
		if event.Type == "authorization_revoked" {
			if _, err = tx.Exec(ctx, "INSERT INTO integration_source_events(client_id,event_id,fingerprint,received_at) VALUES($1,$2,$3,$4)", client.ID, event.EventID, digest, now); err != nil {
				return err
			}
			applied, err = integrationRevokeAuthorization(ctx, tx, event)
			if err != nil || !applied {
				return err
			}
			if err = integrationInvalidatePreparations(ctx, tx, event.SourceID, event.ArticleID, event.ContentFingerprint, true, event.AuthorizationID); err != nil {
				return err
			}
			if err = integrationPauseArticleJobs(ctx, tx, event.SourceID, event.ArticleID, event.ContentFingerprint, true, now, event.AuthorizationID); err != nil {
				return err
			}
			return integrationAudit(ctx, tx, client.ID, "authorization_revoked", "integration", now)
		}
		latest, err := integrationLatestEvent(ctx, tx, event.SourceID, event.ArticleID)
		if err != nil {
			return err
		}
		if latest.StateSeq == event.StateSeq && !integrationSameSourceState(latest, event) {
			return ErrConflict
		}
		if _, err = tx.Exec(ctx, "INSERT INTO integration_source_events(client_id,event_id,fingerprint,received_at) VALUES($1,$2,$3,$4)", client.ID, event.EventID, digest, now); err != nil {
			return err
		}
		if latest.StateSeq >= event.StateSeq {
			return nil
		}
		raw, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO integration_source_states(source_id,article_id,state_seq,record) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,article_id) DO UPDATE SET state_seq=excluded.state_seq,record=excluded.record", event.SourceID, event.ArticleID, event.StateSeq, raw); err != nil {
			return err
		}
		applied = true
		revoked := !event.AuthorizationValid || event.Status == "private" || event.Status == "deleted" || event.Type == "unpublished"
		if err = integrationInvalidatePreparations(ctx, tx, event.SourceID, event.ArticleID, event.ContentFingerprint, revoked, ""); err != nil {
			return err
		}
		if err = integrationPauseArticleJobs(ctx, tx, event.SourceID, event.ArticleID, event.ContentFingerprint, revoked, now); err != nil {
			return err
		}
		return integrationAudit(ctx, tx, client.ID, "source_event_applied", "integration", now)
	})
	return applied, err
}

func integrationInvalidatePreparations(ctx context.Context, tx pgx.Tx, source, article, fingerprint string, revoked bool, authorizationID string) error {
	rows, err := tx.Query(ctx, "SELECT record FROM integration_preparations WHERE source_id=$1 AND article_id=$2 AND ($3='' OR record->>'authorization_id'=$3)", source, article, authorizationID)
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
	for _, p := range preparations {
		changed := fingerprint != "" && fingerprint != p.ContentFingerprint
		if !revoked && !changed || p.Status == "submitted" && !revoked {
			continue
		}
		if p.Status != "submitted" {
			p.Status = "revoked"
			p.Confirmed = false
			p.ConfirmationFingerprint = ""
		}
		p.Snapshot = IntegrationSnapshot{}
		p.Drafts = []IntegrationDraft{}
		if err = integrationSavePreparation(ctx, tx, p); err != nil {
			return err
		}
	}
	return nil
}

func integrationAuthorizationAllowed(ctx context.Context, tx pgx.Tx, source, article, authorizationID string) error {
	if !validKey(authorizationID) {
		return ErrInvalid
	}
	var revoked bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM integration_authorization_revocations WHERE source_id=$1 AND article_id=$2 AND authorization_id=$3)", source, article, authorizationID).Scan(&revoked); err != nil {
		return err
	}
	if revoked {
		return ErrIntegrationExpired
	}
	return nil
}

func integrationRevokeAuthorization(ctx context.Context, tx pgx.Tx, event IntegrationSourceEvent) (bool, error) {
	raw, err := json.Marshal(event)
	if err != nil {
		return false, err
	}
	var seq int64
	err = tx.QueryRow(ctx, "INSERT INTO integration_authorization_revocations(source_id,article_id,authorization_id,state_seq,record) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,article_id,authorization_id) DO UPDATE SET state_seq=excluded.state_seq,record=excluded.record WHERE integration_authorization_revocations.state_seq<excluded.state_seq RETURNING state_seq", event.SourceID, event.ArticleID, event.AuthorizationID, event.StateSeq, raw).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
func integrationPauseArticleJobs(ctx context.Context, tx pgx.Tx, source, article, fingerprint string, cancel bool, now time.Time, authorizationID ...string) error {
	filter := ""
	if len(authorizationID) > 0 {
		filter = authorizationID[0]
	}
	rows, err := tx.Query(ctx, "SELECT d.record FROM integration_distributions d JOIN integration_preparations p ON p.id=d.preparation_id WHERE d.source_id=$1 AND d.article_id=$2 AND ($3='' OR p.record->>'authorization_id'=$3)", source, article, filter)
	if err != nil {
		return err
	}
	ds := []IntegrationDistribution{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		var d IntegrationDistribution
		if err = json.Unmarshal(raw, &d); err != nil {
			rows.Close()
			return err
		}
		ds = append(ds, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, d := range ds {
		if !cancel && (fingerprint == "" || fingerprint == d.ContentFingerprint) {
			continue
		}
		for _, id := range d.JobIDs {
			r, e := load(ctx, tx, id)
			if e != nil {
				return e
			}
			if cancel && integrationCanPurgeUnexecutedJob(r, now) {
				if e = integrationPurgeUnexecutedJob(ctx, tx, r, now); e != nil {
					return e
				}
				continue
			}
			if r.Status == "succeeded" || r.Status == "cancelled" || r.ManualResolved {
				continue
			}
			r.SourceGuardBlocked = true
			r.ErrorCode = "source_changed"
			r.ErrorMessage = "来源内容或授权已变化，需要处理"
			r.UpdatedAt = now
			r.RetryAllowed = false
			if r.Status == "running" || r.LeaseToken != "" && r.LeaseExpiresAt.After(now) {
				r.CancelRequested = true
				if r.RunMode != "reconcile" {
					r.Ready = false
				}
			} else if !r.ExternalStarted && r.Outcome != "unknown" && r.RemoteID == "" && r.ReconcileCandidateID == "" {
				if cancel {
					r.Status = "cancelled"
					r.FinishedAt = &now
				} else {
					r.Status = "waiting_user"
				}
				r.Ready = false
			} else {
				r.ExternalStarted = true
				r.Status = "reconciling"
				r.RunMode = "reconcile"
				r.Ready = true
				r.Outcome = "unknown"
				r.AvailableAt = now.Add(20 * time.Second)
			}
			if e = save(ctx, tx, r); e != nil {
				return e
			}
			if e = appendLog(ctx, tx, r, "warning", "来源变更已阻止后续写入", now); e != nil {
				return e
			}
		}
	}
	return nil
}

func integrationCanPurgeUnexecutedJob(r *record, now time.Time) bool {
	return !r.ExternalStarted && r.Outcome != "unknown" && r.RemoteID == "" && r.ReconcileCandidateID == "" && !(r.LeaseToken != "" && r.LeaseExpiresAt.After(now))
}

func integrationPurgeUnexecutedJob(ctx context.Context, tx pgx.Tx, r *record, now time.Time) error {
	r.Markdown = ""
	r.SourceGuardBlocked = true
	r.Status = "cancelled"
	r.Ready = false
	r.RetryAllowed = false
	r.ErrorCode = "source_changed"
	r.ErrorMessage = "来源授权已撤销，未执行的任务正文已清理"
	r.UpdatedAt = now
	r.FinishedAt = &now
	if _, err := tx.Exec(ctx, "DELETE FROM process_snapshots WHERE job_id=$1", r.ID); err != nil {
		return err
	}
	if err := save(ctx, tx, r); err != nil {
		return err
	}
	return appendLog(ctx, tx, r, "warning", "来源授权已撤销，未执行的任务正文已清理", now)
}

func integrationClientAllowedTx(ctx context.Context, tx pgx.Tx, id, scope string, targets []IntegrationTarget, now time.Time) (IntegrationClient, error) {
	c, err := integrationLoadClient(ctx, tx, id)
	if err != nil {
		return c, ErrIntegrationAuthentication
	}
	if c.Status != "active" || !c.ExpiresAt.After(now) {
		return c, ErrIntegrationAuthentication
	}
	var valid bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM integration_keys WHERE client_id=$1 AND status IN ('active','handover') AND expires_at>$2)", id, now).Scan(&valid); err != nil {
		return c, err
	}
	if !valid {
		return c, ErrIntegrationAuthentication
	}
	if !integrationHas(c.Scopes, scope) {
		return c, ErrIntegrationPermission
	}
	for _, target := range targets {
		if !integrationHas(c.Accounts, target.AccountID) || !integrationHas(c.Operations, target.Operation) {
			return c, ErrIntegrationPermission
		}
	}
	return c, nil
}

func integrationSameSourceState(a, b IntegrationSourceEvent) bool {
	return a.SourceID == b.SourceID && a.ArticleID == b.ArticleID && a.StateSeq == b.StateSeq && a.SourceVersion == b.SourceVersion && a.Status == b.Status && a.AuthorizationValid == b.AuthorizationValid && a.ContentFingerprint == b.ContentFingerprint
}
func integrationAdvanceSnapshotState(ctx context.Context, tx pgx.Tx, p IntegrationPreparation) error {
	latest, err := integrationLatestEvent(ctx, tx, p.SourceID, p.ArticleID)
	if err != nil {
		return err
	}
	if !integrationAcceptState(latest, p.StateSeq, p.SourceVersion, p.ContentFingerprint) {
		return ErrIntegrationSourceChanged
	}
	next := IntegrationSourceEvent{SourceID: p.SourceID, ArticleID: p.ArticleID, StateSeq: p.StateSeq, SourceVersion: p.SourceVersion, Type: "published", Status: "published", AuthorizationValid: true, ContentFingerprint: p.ContentFingerprint}
	if latest.StateSeq == next.StateSeq {
		return nil
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO integration_source_states(source_id,article_id,state_seq,record) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,article_id) DO UPDATE SET state_seq=excluded.state_seq,record=excluded.record", p.SourceID, p.ArticleID, p.StateSeq, raw)
	return err
}

func integrationCheckExistingCopies(ctx context.Context, tx pgx.Tx, source, article string, now time.Time) error {
	rows, err := tx.Query(ctx, "SELECT record FROM integration_distributions WHERE source_id=$1 AND article_id=$2", source, article)
	if err != nil {
		return err
	}
	previous := []IntegrationDistribution{}
	for rows.Next() {
		var raw []byte
		var d IntegrationDistribution
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal(raw, &d); err != nil {
			break
		}
		previous = append(previous, d)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, d := range previous {
		if len(d.JobIDs) == 0 {
			return ErrConflict
		}
		for _, id := range d.JobIDs {
			job, e := load(ctx, tx, id)
			if e != nil {
				return e
			}
			active := job.LeaseToken != "" && job.LeaseExpiresAt.After(now)
			if active || job.ExternalStarted || job.Outcome == "unknown" || job.RemoteID != "" {
				return ErrConflict
			}
			if job.Status == "waiting_user" && job.SourceGuardBlocked {
				job.Status = "cancelled"
				job.Ready = false
				job.FinishedAt = &now
				job.UpdatedAt = now
				job.Markdown = ""
				job.RetryAllowed = false
				if _, e = tx.Exec(ctx, "DELETE FROM process_snapshots WHERE job_id=$1", id); e != nil {
					return e
				}
				if e = save(ctx, tx, job); e != nil {
					return e
				}
				if e = appendLog(ctx, tx, job, "info", "新确认的分发稿已替换尚未写入的旧任务", now); e != nil {
					return e
				}
			} else if job.Status != "cancelled" {
				return ErrConflict
			}
		}
	}
	return nil
}
