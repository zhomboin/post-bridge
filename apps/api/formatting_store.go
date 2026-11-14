package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type formattingJobInput struct {
	RequestID string `json:"request_id"`
	Platform  string `json:"platform"`
	Template  string `json:"template"`
	Mode      string `json:"mode,omitempty"`
}

func readFormattingJob(ctx context.Context, tx pgx.Tx, id string, lock bool) (FormattingJob, error) {
	var job FormattingJob
	var raw []byte
	query := "SELECT record FROM formatting_jobs WHERE id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	err := tx.QueryRow(ctx, query, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return job, ErrNotFound
	}
	if err != nil {
		return job, err
	}
	err = json.Unmarshal(raw, &job)
	return job, err
}
func saveFormattingJob(ctx context.Context, tx pgx.Tx, j FormattingJob) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE formatting_jobs SET record=$2 WHERE id=$1", j.ID, raw)
	return err
}
func (h *handler) createFormattingJob(ctx context.Context, id string, in formattingJobInput) (FormattingJob, bool, error) {
	var out FormattingJob
	created := false
	if !validKey(in.RequestID) || !integrationHas([]string{"csdn", "xiaohongshu", "wechat"}, in.Platform) || in.Platform != "xiaohongshu" && in.Template != "" || in.Platform == "xiaohongshu" && !integrationHas([]string{"technical", "checklist"}, in.Template) ||
		in.Mode != "" && in.Mode != formattingAI && in.Mode != formattingFidelity {
		return out, false, ErrInvalid
	}
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,72341821))", scopeOf(ctx).UserID); err != nil {
			return err
		}
		session, err := h.readFormattingSession(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if !integrationHas(session.Platforms, in.Platform) {
			return ErrIntegrationPermission
		}
		mode := formattingMode(in.Platform, session.Mode)
		if in.Mode != "" && in.Mode != mode {
			return ErrInvalid
		}
		if !h.formattingConfig.supportsMode(mode) {
			return ErrIntegrationPermission
		}
		in.Mode = ""
		promptVersion, rulesVersion, model := formattingPromptVersion, formattingRulesVersion, h.formattingConfig.Model
		if in.Platform == "wechat" {
			promptVersion, rulesVersion, model = "", wechatRulesVersion, ""
			if mode == formattingAI {
				in.Mode, promptVersion, model = mode, wechatPromptVersion, h.formattingConfig.Model
			}
		}
		// 请求标识绑定原稿和处理方式，版本与模型随结果修订保存。
		fp := "v2:" + integrationDigest([]any{id, in, session.ContentFingerprint})
		var existing, oldFP string
		err = tx.QueryRow(ctx, "SELECT id,fingerprint FROM formatting_jobs WHERE owner_user_id=$1 AND request_id=$2", scopeOf(ctx).UserID, in.RequestID).Scan(&existing, &oldFP)
		if err == nil {
			out, err = readFormattingJob(ctx, tx, existing, false)
			if err != nil {
				return err
			}
			if oldFP == fp {
				return nil
			}
			// 兼容以任务版本生成的请求指纹。
			previousFP := integrationDigest([]any{id, in, session.ContentFingerprint, out.PromptVersion, out.RulesVersion, out.Model})
			if previousFP != oldFP {
				return ErrConflict
			}
			_, err = tx.Exec(ctx, "UPDATE formatting_jobs SET fingerprint=$2 WHERE id=$1", out.ID, fp)
			return err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var pending int
		var reserved int64
		if err = tx.QueryRow(ctx, "SELECT count(*) FILTER (WHERE record->>'status' IN ('queued','running')),COALESCE(sum(reservation) FILTER (WHERE created_at>=date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) FROM formatting_jobs WHERE owner_user_id=$1", scopeOf(ctx).UserID, now).Scan(&pending, &reserved); err != nil {
			return err
		}
		snapshotJSON, _ := json.Marshal(session.Snapshot)
		budget := int64(len(snapshotJSON)*3 + h.formattingConfig.MaxOutputTokens + 8192)
		if mode == formattingFidelity {
			budget = 0
		}
		if pending >= 5 || mode == formattingAI && reserved+budget > h.formattingConfig.DailyTokens {
			return formattingError("formatting_quota")
		}
		out = FormattingJob{ID: randomToken(), Title: session.Snapshot.Title, SessionID: id, Platform: in.Platform, Operation: "generate", Status: "queued", Stage: "queued", Revision: 1, BaseRevision: session.BaseRevision, RequestID: in.RequestID, CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano), PromptVersion: promptVersion, RulesVersion: rulesVersion, Template: in.Template, Model: model, Mode: &mode}
		raw, _ := json.Marshal(out)
		_, err = tx.Exec(ctx, "INSERT INTO formatting_jobs(id,owner_user_id,session_id,request_id,fingerprint,record,reservation) VALUES($1,$2,$3,$4,$5,$6,$7)", out.ID, scopeOf(ctx).UserID, id, in.RequestID, fp, raw, budget)
		created = err == nil
		return err
	})
	return out, created, err
}
func (h *handler) getFormattingJob(ctx context.Context, id string) (FormattingJob, error) {
	var out FormattingJob
	err := h.store.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		var err error
		out, err = readFormattingJob(ctx, tx, id, false)
		if err != nil {
			return err
		}
		_, err = h.readFormattingSession(ctx, tx, out.SessionID, false)
		return err
	})
	return out, err
}
func (h *handler) cancelFormattingJob(ctx context.Context, id string) (FormattingJob, error) {
	var out FormattingJob
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var e error
		out, e = readFormattingJob(ctx, tx, id, true)
		if e != nil {
			return e
		}
		if out.Status == "cancelled" {
			return nil
		}
		if out.Status != "queued" && out.Status != "running" {
			return ErrConflict
		}
		if out.Operation == "generate" && (out.Stage == "queued" || out.Stage == "analyzing") {
			if _, e = tx.Exec(ctx, "UPDATE formatting_jobs SET reservation=0 WHERE id=$1", id); e != nil {
				return e
			}
		}
		out.Status = "cancelled"
		out.UpdatedAt = now.Format(time.RFC3339Nano)
		return saveFormattingJob(ctx, tx, out)
	})
	if err == nil {
		h.cancelFormattingRun(id)
	}
	return out, err
}
