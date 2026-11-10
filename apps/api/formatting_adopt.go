package bridge

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (h *handler) adoptFormatting(ctx context.Context, id string, revision int64) (FormattingJob, *IntegrationPreparation, error) {
	return h.adoptFormattingScope(ctx, id, revision, false)
}

func (h *handler) adoptFormattingScope(ctx context.Context, id string, revision int64, localOnly bool) (FormattingJob, *IntegrationPreparation, error) {
	var out FormattingJob
	var prep *IntegrationPreparation
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var err error
		out, err = readFormattingJob(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if out.Revision != revision || out.Platform != "csdn" || out.Result == nil {
			return ErrConflict
		}
		s, err := h.readFormattingSession(ctx, tx, out.SessionID, true)
		if err != nil {
			return err
		}
		if localOnly && s.PreparationID != "" {
			return ErrIntegrationPermission
		}
		if out.Status == "adopted" {
			if s.PreparationID != "" {
				p, e := integrationReadPreparation(ctx, tx, s.PreparationID, false)
				prep = &p
				return e
			}
			return nil
		}
		if out.Status != "succeeded" {
			return ErrConflict
		}
		if s.PreparationID != "" {
			p, e := integrationReadPreparation(ctx, tx, s.PreparationID, true)
			if e != nil {
				return e
			}
			if p.Revision != out.BaseRevision || len(p.Drafts) != 1 || p.Drafts[0].AccountID != s.AccountID {
				return ErrConflict
			}
			c, e := integrationLoadClient(ctx, tx, p.ClientID)
			if e != nil {
				return e
			}
			options := defaultCSDNPublishOptions()
			if p.Drafts[0].PublishOptions != nil {
				options = *p.Drafts[0].PublishOptions
			}
			options.Summary = out.Result.Summary
			options.Tags = out.Result.Tags
			options.CreationDeclaration = "ai_assisted"
			options, e = normalizeCSDNPublishOptions(options, p.Snapshot.CoverImageURL)
			if e != nil {
				return e
			}
			p.Revision++
			p.Drafts[0].ID = randomToken()
			p.Drafts[0].Revision = p.Revision
			p.Drafts[0].Title = out.Result.Title
			p.Drafts[0].Markdown = out.Result.Markdown
			p.Drafts[0].PublishOptions = &options
			p.DraftRevisionIDs = []string{p.Drafts[0].ID}
			p.Confirmed = false
			p.ConfirmationFingerprint = ""
			p.Status = "prepared"
			p.GrantVersion = c.GrantVersion
			if e = integrationSavePreparation(ctx, tx, p); e != nil {
				return e
			}
			if e = integrationAudit(ctx, tx, p.ClientID, "formatting_adopted", "admin", now); e != nil {
				return e
			}
			prep = &p
		}
		out.Status = "adopted"
		out.Confirmed = true
		out.ConfirmationFingerprint = formattingOutputFingerprint(out)
		out.UpdatedAt = now.Format(time.RFC3339Nano)
		if err := saveFormattingJob(ctx, tx, out); err != nil {
			return err
		}
		return saveFormattingRevision(ctx, tx, out)
	})
	return out, prep, err
}
func (h *handler) createFormattedCSDNDraft(ctx context.Context, id string, revision int64) (Job, bool, error) {
	job, _, err := h.adoptFormattingScope(ctx, id, revision, true)
	if err != nil {
		return Job{}, false, err
	}
	var session FormattingSession
	err = h.store.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		var e error
		session, e = h.readFormattingSession(ctx, tx, job.SessionID, false)
		return e
	})
	if err != nil {
		return Job{}, false, err
	}
	if session.PreparationID != "" {
		return Job{}, false, ErrIntegrationPermission
	}
	return h.store.Create(ctx, CreateInput{RequestID: "formatting-" + job.ID + "-" + strconv.FormatInt(job.Revision, 10), AccountID: session.AccountID, Kind: "save_draft", Platform: "csdn", Title: job.Result.Title, Markdown: job.Result.Markdown})
}
func (h *handler) listFormattingJobs(ctx context.Context, id string) ([]FormattingJob, error) {
	out := []FormattingJob{}
	err := h.store.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		if _, err := h.readFormattingSession(ctx, tx, id, false); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, "SELECT record FROM formatting_jobs WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 40", id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			var j FormattingJob
			if err = rows.Scan(&raw); err != nil {
				return err
			}
			if err = json.Unmarshal(raw, &j); err != nil {
				return err
			}
			j.Result = nil
			out = append(out, j)
		}
		return rows.Err()
	})
	return out, err
}
