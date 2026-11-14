package bridge

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type wechatEditInput struct {
	Revision    int64          `json:"revision"`
	RequestID   string         `json:"request_id"`
	Markdown    string         `json:"markdown"`
	Attachments []wechatUpload `json:"attachments"`
}

func (h *handler) editWechat(ctx context.Context, id string, in wechatEditInput) (FormattingJob, error) {
	var job FormattingJob
	if !validKey(in.RequestID) || strings.TrimSpace(in.Markdown) == "" || !validFormattingText(in.Markdown, h.formattingConfig.MaxInputCharacters) {
		return job, ErrInvalid
	}
	attachments, err := validateWechatUploads(in.Attachments)
	if err != nil {
		return job, err
	}
	err = h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,72341821))", scopeOf(ctx).UserID); err != nil {
			return err
		}
		var err error
		job, err = readFormattingJob(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if _, err = h.readFormattingSession(ctx, tx, job.SessionID, false); err != nil {
			return err
		}
		fp := integrationDigest([]any{in.Revision, in.RequestID, in.Markdown, in.Attachments})
		if job.Operation == "wechat_edit" && job.EditRequestID == in.RequestID {
			if job.EditFingerprint != fp {
				return ErrConflict
			}
			return nil
		}
		if job.Platform != "wechat" || job.Revision != in.Revision || job.Result == nil || job.Result.Wechat == nil || !integrationHas([]string{"wechat-1", "wechat-2", wechatRulesVersion}, job.RulesVersion) || job.Revision >= 20 || !(integrationHas([]string{"succeeded", "needs_review", "adopted"}, job.Status) || job.Status == "failed" && job.Operation == "wechat_edit") {
			return ErrConflict
		}
		known := map[string]bool{}
		if job.Result.Wechat.Images != nil {
			for _, image := range *job.Result.Wechat.Images {
				known[image.ID] = true
			}
		}
		for _, attachment := range attachments {
			if !known[attachment.ImageID] {
				return ErrInvalid
			}
		}
		var stored int64
		if err = tx.QueryRow(ctx, "SELECT COALESCE((SELECT sum(octet_length(record::text)) FROM formatting_jobs WHERE owner_user_id=$1),0) + COALESCE((SELECT sum(octet_length(record::text)) FROM formatting_revisions WHERE owner_user_id=$1),0)", scopeOf(ctx).UserID).Scan(&stored); err != nil {
			return err
		}
		// 先限制排队时保存的候选内容，写入最终稿前再核对实际大小。
		estimate := int64(len(in.Markdown))*40 + 1<<20
		for _, attachment := range attachments {
			estimate += int64(len(attachment.Data)) * 4
		}
		if stored+estimate > 64<<20 {
			return formattingError("formatting_quota")
		}
		var queued int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM formatting_jobs WHERE owner_user_id=$1 AND record->>'status' IN ('queued','running')", scopeOf(ctx).UserID).Scan(&queued); err != nil {
			return err
		}
		if queued >= 5 {
			return formattingError("formatting_quota")
		}
		job.Result = formattingOutputCopy(job.Result)
		job.Result.Wechat.CandidateMarkdown = &in.Markdown
		job.Result.Wechat.Attachments = &attachments
		job.Revision++
		job.RulesVersion = wechatRulesVersion
		job.Operation = "wechat_edit"
		job.EditRequestID = in.RequestID
		job.EditFingerprint = fp
		job.Confirmed = false
		job.ConfirmationFingerprint = ""
		job.Status = "queued"
		job.Stage = "analyzing"
		job.ErrorCode = ""
		job.UpdatedAt = now.Format(time.RFC3339Nano)
		return saveFormattingJob(ctx, tx, job)
	})
	return job, err
}
