package bridge

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

func saveFormattingRevision(ctx context.Context, tx pgx.Tx, job FormattingJob) error {
	if job.Result == nil {
		return nil
	}
	raw, err := json.Marshal(job.Result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO formatting_revisions(job_id,owner_user_id,revision,record,confirmed,confirmation_fingerprint) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(job_id,revision) DO UPDATE SET confirmed=EXCLUDED.confirmed,confirmation_fingerprint=EXCLUDED.confirmation_fingerprint`, job.ID, scopeOf(ctx).UserID, job.Revision, raw, job.Confirmed, job.ConfirmationFingerprint)
	return err
}
func (h *handler) editFormattingJob(ctx context.Context, id string, revision int64, requestID, template string, out FormattingOutput) (FormattingJob, error) {
	var job FormattingJob
	if !validKey(requestID) || !integrationHas([]string{"technical", "checklist"}, template) {
		return job, ErrInvalid
	}
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var err error
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,72341821))", scopeOf(ctx).UserID); err != nil {
			return err
		}
		job, err = readFormattingJob(ctx, tx, id, true)
		if err != nil {
			return err
		}
		s, err := h.readFormattingSession(ctx, tx, job.SessionID, false)
		if err != nil {
			return err
		}
		fp := integrationDigest([]any{revision, requestID, template, out})
		if job.Operation == "render" && job.EditRequestID == requestID {
			if job.EditFingerprint != fp {
				return ErrConflict
			}
			return nil
		}
		if job.Platform != "xiaohongshu" || job.Revision != revision || (!integrationHas([]string{"succeeded", "needs_review", "adopted"}, job.Status) && !(job.Status == "failed" && job.Operation == "render")) || job.Result == nil || job.Revision >= 20 {
			return ErrConflict
		}
		// 受保护的来源引用由渲染前再次解析校验；此处先拒绝客户端注入素材或执行正文。
		if len(out.Assets) > 0 || out.Markdown != "" || out.Summary != "" || len(out.Tags) > 0 {
			return ErrInvalid
		}
		if out.Title == "" || out.Body == "" || len(out.Cards) == 0 {
			return ErrInvalid
		}
		known := map[string]FormattingBlock{}
		for _, card := range job.Result.Cards {
			for _, id := range card.SourceBlockIds {
				if _, exists := known[id]; !exists {
					known[id] = FormattingBlock{ID: id, Kind: "paragraph"}
				}
			}
			for _, id := range card.CodeRefs {
				known[id] = FormattingBlock{ID: id, Kind: "code"}
			}
		}
		blocks := make([]FormattingBlock, 0, len(known))
		for _, block := range known {
			blocks = append(blocks, block)
		}
		if err = validateXiaohongshu(out, blocks); err != nil {
			return err
		}
		for _, issue := range out.Issues {
			if issue.Code != "card_overflow" && issue.Code != "too_many_cards" {
				return ErrInvalid
			}
		}
		var queued int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM formatting_jobs WHERE owner_user_id=$1 AND record->>'status' IN ('queued','running')", scopeOf(ctx).UserID).Scan(&queued); err != nil {
			return err
		}
		if queued >= 5 {
			return formattingError("formatting_quota")
		}
		out.Issues = []FormattingIssue{}
		out.Assets = []FormattingAsset{}
		job.Result = formattingOutputCopy(&out)
		job.Revision++
		job.Confirmed = false
		job.ConfirmationFingerprint = ""
		job.Status = "queued"
		job.Stage = "rendering"
		job.Template = template
		job.Operation = "render"
		job.EditRequestID = requestID
		job.EditFingerprint = fp
		job.ErrorCode = ""
		job.UpdatedAt = now.Format(time.RFC3339Nano)
		if job.BaseRevision != s.BaseRevision {
			return ErrConflict
		}
		return saveFormattingJob(ctx, tx, job)
	})
	return job, err
}
func (h *handler) confirmFormatting(ctx context.Context, id string, revision int64) (FormattingJob, error) {
	var job FormattingJob
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var err error
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,72341821))", scopeOf(ctx).UserID); err != nil {
			return err
		}
		job, err = readFormattingJob(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if _, err = h.readFormattingSession(ctx, tx, job.SessionID, false); err != nil {
			return err
		}
		if job.Platform != "xiaohongshu" || job.Revision != revision || job.Result == nil || len(job.Result.Assets) < 2 || !integrationHas([]string{"succeeded", "adopted"}, job.Status) {
			return ErrConflict
		}
		if job.Confirmed {
			return nil
		}
		for _, asset := range job.Result.Assets {
			var hash string
			var assetRevision int64
			if err = tx.QueryRow(ctx, "SELECT sha256,revision FROM formatting_assets WHERE id=$1 AND job_id=$2 AND expires_at>$3", asset.ID, job.ID, now).Scan(&hash, &assetRevision); err != nil {
				return ErrConflict
			}
			if hash != asset.Sha256 || assetRevision != job.Revision {
				return ErrConflict
			}
		}
		job.Confirmed = true
		job.ConfirmationFingerprint = formattingOutputFingerprint(job)
		job.Status = "adopted"
		job.UpdatedAt = now.Format(time.RFC3339Nano)
		if err = saveFormattingJob(ctx, tx, job); err != nil {
			return err
		}
		return saveFormattingRevision(ctx, tx, job)
	})
	return job, err
}
