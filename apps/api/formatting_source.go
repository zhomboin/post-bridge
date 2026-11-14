package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type FormattingAuthorization struct {
	AllowAIProcessing bool     `json:"allow_ai_processing"`
	Platforms         []string `json:"platforms"`
	AutoGenerate      bool     `json:"auto_generate,omitempty"`
}
type formattingSessionInput struct {
	RequestID         string             `json:"request_id"`
	PreparationID     string             `json:"preparation_id"`
	BaseRevision      int64              `json:"base_revision"`
	AccountID         string             `json:"account_id"`
	Snapshot          FormattingSnapshot `json:"snapshot"`
	Platforms         []string           `json:"platforms"`
	AllowAIProcessing bool               `json:"allow_ai_processing"`
	Mode              string             `json:"mode,omitempty"`
}

const (
	formattingFidelity = "fidelity"
	formattingAI       = "ai_assisted"
)

func formattingMode(platform string, mode *string) string {
	if mode != nil {
		return *mode
	}
	if platform == "wechat" {
		return formattingFidelity
	}
	return formattingAI
}

func (c FormattingConfig) supportsMode(mode string) bool {
	switch mode {
	case formattingAI:
		return c.Enabled
	case formattingFidelity:
		return c.LocalEnabled || c.Enabled
	default:
		return false
	}
}

func formattingPlatformsValid(platforms []string) bool {
	return len(platforms) > 0 && len(platforms) <= 2 && integrationSubset(platforms, []string{"csdn", "xiaohongshu"})
}
func formattingLocalPlatformsValid(platforms []string) bool {
	return formattingPlatformsValid(platforms) || len(platforms) == 1 && platforms[0] == "wechat"
}
func formattingAuthorizationValid(c IntegrationClient, a *FormattingAuthorization) bool {
	return a != nil && a.AllowAIProcessing && c.AIProcessingAllowed && formattingPlatformsValid(a.Platforms) && integrationSubset(a.Platforms, c.FormattingPlatforms)
}
func (h *handler) formattingSourceGuard(ctx context.Context, tx pgx.Tx, s FormattingSession) error {
	var enabled bool
	if err := tx.QueryRow(ctx, "SELECT enabled FROM users WHERE id=$1", scopeOf(ctx).UserID).Scan(&enabled); err != nil || !enabled {
		return ErrIntegrationPermission
	}
	expiry, e := time.Parse(time.RFC3339Nano, s.ExpiresAt)
	if e != nil || !expiry.After(h.store.now()) {
		return ErrIntegrationExpired
	}
	if s.PreparationID != "" {
		p, err := integrationReadPreparation(ctx, tx, s.PreparationID, false)
		if err != nil {
			return err
		}
		if p.Status == "submitted" || p.Status == "revoked" || !p.ExpiresAt.After(h.store.now()) || !p.AuthorizationExpiresAt.After(h.store.now()) {
			return ErrIntegrationExpired
		}
		if p.ContentFingerprint != s.ContentFingerprint {
			return ErrIntegrationSourceChanged
		}
		c, err := integrationClientAllowedTx(ctx, tx, p.ClientID, "preparations:write", p.Targets, h.store.now())
		if err != nil {
			return err
		}
		if !formattingAuthorizationValid(c, p.Formatting) || !integrationSubset(s.Platforms, p.Formatting.Platforms) {
			return ErrIntegrationPermission
		}
		if err = integrationAuthorizationAllowed(ctx, tx, p.SourceID, p.ArticleID, p.AuthorizationID); err != nil {
			return err
		}
		latest, err := integrationLatestEvent(ctx, tx, p.SourceID, p.ArticleID)
		if err != nil {
			return err
		}
		if !integrationAcceptState(latest, p.StateSeq, p.SourceVersion, p.ContentFingerprint) {
			return ErrIntegrationSourceChanged
		}
	}
	if s.AccountID != "" {
		var usable bool
		err := tx.QueryRow(ctx, "SELECT enabled AND verified AND NOT credentials_revoked FROM account WHERE id=$1 AND platform='csdn' AND owner_user_id=$2", s.AccountID, scopeOf(ctx).UserID).Scan(&usable)
		if err != nil || !usable {
			return ErrIntegrationPermission
		}
	}
	return nil
}
func (h *handler) createFormattingSession(ctx context.Context, in formattingSessionInput) (FormattingSession, error) {
	var out FormattingSession
	wechat := len(in.Platforms) == 1 && in.Platforms[0] == "wechat"
	mode := in.Mode
	if mode == "" {
		mode = formattingAI
		if wechat {
			mode = formattingFidelity
		}
	}
	if !validKey(in.RequestID) || !formattingLocalPlatformsValid(in.Platforms) || scopeOf(ctx).UserID == "" ||
		(mode != formattingAI && mode != formattingFidelity) || (!wechat && mode != formattingAI) ||
		(wechat && in.PreparationID != "") {
		return out, ErrInvalid
	}
	if mode == formattingAI && !in.AllowAIProcessing {
		if !wechat {
			return out, ErrInvalid
		}
		return out, ErrIntegrationPermission
	}
	if !h.formattingConfig.supportsMode(mode) {
		return out, ErrIntegrationPermission
	}
	// 显式选择与旧默认相同时沿用原请求指纹。
	in.Mode = ""
	if wechat && mode == formattingAI {
		in.Mode = mode
	}
	err := h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var raw []byte
		var fp string
		digest := integrationDigest(in)
		e := tx.QueryRow(ctx, "SELECT record,fingerprint FROM formatting_sessions WHERE owner_user_id=$1 AND request_id=$2", scopeOf(ctx).UserID, in.RequestID).Scan(&raw, &fp)
		if e == nil {
			if fp != digest {
				return ErrConflict
			}
			if e = json.Unmarshal(raw, &out); e != nil {
				return e
			}
			return h.formattingSourceGuard(ctx, tx, out)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		expiry := now.Add(24 * time.Hour)
		snapshot := in.Snapshot
		if in.PreparationID != "" {
			p, e := integrationReadPreparation(ctx, tx, in.PreparationID, true)
			if e != nil {
				return e
			}
			if in.BaseRevision != p.Revision || snapshot.Title != "" || snapshot.Body != "" {
				return ErrConflict
			}
			c, e := integrationLoadClient(ctx, tx, p.ClientID)
			if e != nil {
				return e
			}
			if !formattingAuthorizationValid(c, p.Formatting) || !integrationSubset(in.Platforms, p.Formatting.Platforms) {
				return ErrIntegrationPermission
			}
			snapshot = FormattingSnapshot{Title: p.Snapshot.Title, Body: p.Snapshot.Body, BodyFormat: p.Snapshot.BodyFormat, Summary: p.Snapshot.Summary, Tags: p.Snapshot.Tags}
			fp = p.ContentFingerprint
			expiry = p.ExpiresAt
			if p.AuthorizationExpiresAt.Before(expiry) {
				expiry = p.AuthorizationExpiresAt
			}
			if integrationHas(in.Platforms, "csdn") {
				if len(p.Targets) != 1 || in.AccountID != "" && in.AccountID != p.Targets[0].AccountID {
					return ErrConflict
				}
				in.AccountID = p.Targets[0].AccountID
			}
		} else {
			snapshot.Title = strings.TrimSpace(snapshot.Title)
			snapshot.Body = strings.ReplaceAll(strings.ReplaceAll(snapshot.Body, "\r\n", "\n"), "\r", "\n")
			if snapshot.BodyFormat != "markdown" || len(snapshot.Tags) > 20 || utf8.RuneCountInString(snapshot.Summary) > 2000 {
				return ErrInvalid
			}
			if !validFormattingText(snapshot.Title, 100) || snapshot.Title == "" {
				return ErrInvalid
			}
			if wechat || len(in.Platforms) == 1 && in.Platforms[0] == "xiaohongshu" {
				if strings.TrimSpace(snapshot.Body) == "" || !validFormattingText(snapshot.Body, 100000) {
					return ErrInvalid
				}
			} else if e := ValidateCreate(CreateInput{RequestID: "formatting", Platform: "csdn", Kind: "save_draft", Title: "格式化原稿校验", Markdown: snapshot.Body}); e != nil {
				return e
			}
			for _, tag := range snapshot.Tags {
				if !validFormattingText(tag, 64) {
					return ErrInvalid
				}
			}
			fp = integrationDigest(snapshot)
		}
		if utf8.RuneCountInString(snapshot.Body) > h.formattingConfig.MaxInputCharacters {
			return formattingError("input_too_large")
		}
		if integrationHas(in.Platforms, "csdn") && in.AccountID == "" {
			return ErrInvalid
		}
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM formatting_sessions WHERE owner_user_id=$1 AND expires_at>$2", scopeOf(ctx).UserID, now).Scan(&count); e != nil {
			return e
		}
		if count >= 100 {
			return formattingError("formatting_quota")
		}
		out = FormattingSession{ID: randomToken(), PreparationID: in.PreparationID, AccountID: in.AccountID, ContentFingerprint: fp, BaseRevision: in.BaseRevision, Revision: 1, Snapshot: snapshot, Platforms: in.Platforms, ExpiresAt: expiry.Format(time.RFC3339Nano), Mode: &mode}
		if e = h.formattingSourceGuard(ctx, tx, out); e != nil {
			return e
		}
		raw, e = json.Marshal(out)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "INSERT INTO formatting_sessions(id,owner_user_id,request_id,fingerprint,record,expires_at) VALUES($1,$2,$3,$4,$5,$6)", out.ID, scopeOf(ctx).UserID, in.RequestID, digest, raw, expiry)
		return e
	})
	return out, err
}
func (h *handler) readFormattingSession(ctx context.Context, tx pgx.Tx, id string, lock bool) (FormattingSession, error) {
	var out FormattingSession
	var raw []byte
	query := "SELECT record FROM formatting_sessions WHERE id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	err := tx.QueryRow(ctx, query, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	return out, h.formattingSourceGuard(ctx, tx, out)
}
func validFormattingText(value string, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= max && !strings.ContainsAny(value, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c")
}
