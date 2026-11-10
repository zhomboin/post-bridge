package bridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"image/png"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

type formattingRenderedImage struct {
	Data   string `json:"data"`
	SHA256 string `json:"sha256"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func validateXiaohongshu(out FormattingOutput, blocks []FormattingBlock) error {
	if strings.TrimSpace(out.Title) == "" || len(utf16.Encode([]rune(out.Title))) > 20 || !validFormattingText(out.Title, 20) ||
		!validFormattingText(out.Body, 1000) || strings.TrimSpace(out.Body) == "" || len(out.Topics) > 8 || strings.ContainsAny(out.Body, "\x00") ||
		strings.Contains(out.Body, "~~~") || strings.Contains(out.Body, "`"+"`"+"`") || out.Markdown != "" ||
		!validFormattingText(out.CoverTitle, 30) || strings.TrimSpace(out.CoverTitle) == "" || !validFormattingText(out.CoverSubtitle, 80) || len(out.Cards) < 1 || len(out.Cards) > 8 || len(out.Omissions) > 2100 || len(out.Issues) > 10 {
		return ErrFormattingContent
	}
	topics := map[string]bool{}
	composed := out.Body
	for _, topic := range out.Topics {
		if strings.TrimSpace(topic) == "" || !validFormattingText(topic, 30) || strings.ContainsAny(topic, "#\r\n\t") || topics[topic] {
			return ErrFormattingContent
		}
		topics[topic] = true
		composed += " #" + topic
	}
	if len(utf16.Encode([]rune(composed))) > 1000 {
		return ErrFormattingContent
	}
	known := map[string]FormattingBlock{}
	for _, block := range blocks {
		known[block.ID] = block
	}
	for _, card := range out.Cards {
		if strings.TrimSpace(card.Title) == "" || !validFormattingText(card.Title, 40) || len(card.Paragraphs) > 20 || len(card.Paragraphs)+len(card.CodeRefs) == 0 || len(card.CodeRefs) > 3 || len(card.SourceBlockIds) == 0 || len(card.SourceBlockIds) > len(blocks) {
			return ErrFormattingContent
		}
		refs := map[string]bool{}
		for _, id := range card.SourceBlockIds {
			if _, exists := known[id]; !exists || refs[id] {
				return ErrFormattingContent
			}
			refs[id] = true
		}
		for _, id := range card.CodeRefs {
			block, exists := known[id]
			if !exists || block.Kind != "code" || !refs[id] {
				return ErrFormattingContent
			}
		}
		for _, paragraph := range card.Paragraphs {
			if !validFormattingText(paragraph, 1500) || strings.TrimSpace(paragraph) == "" {
				return ErrFormattingContent
			}
		}
	}
	for _, issue := range out.Issues {
		if !validFormattingText(issue.Message, 500) || len(issue.Code) > 64 || len(issue.Field) > 100 {
			return ErrFormattingContent
		}
	}
	for _, omission := range out.Omissions {
		if !validFormattingText(omission, 500) {
			return ErrFormattingContent
		}
	}
	return nil
}
func (h *handler) xiaohongshuOutput(ctx context.Context, c formattingClaim, s FormattingSession, blocks []FormattingBlock, result FormattingModelResult) (FormattingOutput, error) {
	out := FormattingOutput{Title: result.Title, Body: result.Body, Topics: result.Topics, CoverTitle: result.CoverTitle, CoverSubtitle: result.CoverSubtitle, Cards: result.Cards, Omissions: result.Omissions, Issues: result.Issues, Tags: []string{}, Assets: []FormattingAsset{}}
	if out.Topics == nil {
		out.Topics = []string{}
	}
	if out.Omissions == nil {
		out.Omissions = []string{}
	}
	if out.Issues == nil {
		out.Issues = []FormattingIssue{}
	}
	if err := validateXiaohongshu(out, blocks); err != nil {
		return out, err
	}
	out.Omissions = xiaohongshuOmissions(out, blocks)
	return h.renderXiaohongshu(ctx, c, s, out)
}
func xiaohongshuOmissions(out FormattingOutput, blocks []FormattingBlock) []string {
	selected := map[string]bool{}
	code := map[string]bool{}
	omissions := []string{}
	for _, value := range out.Omissions {
		if !strings.Contains(value, "：未纳入图片卡片，请核对原稿。") && !strings.Contains(value, "：未展示完整代码，请核对原稿。") && !strings.Contains(value, "：受保护内容未原样绘制，请核对原稿。") {
			omissions = append(omissions, value)
		}
	}
	for _, card := range out.Cards {
		for _, id := range card.SourceBlockIds {
			selected[id] = true
		}
		for _, id := range card.CodeRefs {
			code[id] = true
		}
	}
	for _, block := range blocks {
		if block.Kind == "code" && !code[block.ID] {
			omissions = append(omissions, block.ID+"：未展示完整代码，请核对原稿。")
		} else if !selected[block.ID] {
			omissions = append(omissions, block.ID+"：未纳入图片卡片，请核对原稿。")
		} else if block.Protected && block.Kind != "code" {
			omissions = append(omissions, block.ID+"：受保护内容未原样绘制，请核对原稿。")
		}
	}
	return omissions
}
func (h *handler) renderXiaohongshu(ctx context.Context, c formattingClaim, s FormattingSession, out FormattingOutput) (FormattingOutput, error) {
	if _, err := h.formattingCheckpoint(ctx, c, "rendering"); err != nil {
		return out, err
	}
	var rendered struct {
		Images []formattingRenderedImage `json:"images"`
	}
	err := h.formattingConfig.formatter(ctx, "/render", map[string]any{"template": c.Job.Template, "title": out.CoverTitle, "subtitle": out.CoverSubtitle, "cards": out.Cards, "markdown": s.Snapshot.Body}, &rendered)
	if err != nil {
		if code := formattingErrorCode(err); code == "card_overflow" || code == "too_many_cards" {
			out.Issues = append(out.Issues, FormattingIssue{Code: code, Field: "cards", Message: "卡片内容超出页面容量，请拆分或精简后重新排版。", Blocking: true})
			return out, nil
		}
		return out, err
	}
	if len(rendered.Images) < 2 || len(rendered.Images) > 9 {
		return out, ErrFormattingContent
	}
	out.Assets = []FormattingAsset{}
	err = h.store.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var lease, status string
		if err := tx.QueryRow(ctx, "SELECT lease_token,record->>'status' FROM formatting_jobs WHERE id=$1 FOR UPDATE", c.Job.ID).Scan(&lease, &status); err != nil {
			return err
		}
		if lease != c.Lease || status != "running" {
			return ErrConflict
		}
		if _, err := h.readFormattingSession(ctx, tx, s.ID, false); err != nil {
			return err
		}
		var stored int64
		if err := tx.QueryRow(ctx, "SELECT COALESCE(sum(octet_length(body)),0) FROM formatting_assets WHERE owner_user_id=$1", scopeOf(ctx).UserID).Scan(&stored); err != nil {
			return err
		}
		total := 0
		for _, image := range rendered.Images {
			body, err := base64.StdEncoding.DecodeString(image.Data)
			if err != nil || len(body) > 4<<20 {
				return ErrFormattingContent
			}
			cfg, err := png.DecodeConfig(bytes.NewReader(body))
			digest := sha256.Sum256(body)
			hash := hex.EncodeToString(digest[:])
			if err != nil || cfg.Width != 1080 || cfg.Height != 1440 || image.Width != cfg.Width || image.Height != cfg.Height || hash != image.SHA256 {
				return ErrFormattingContent
			}
			total += len(body)
			if total > 12<<20 || stored+int64(total) > 64<<20 {
				return formattingError("formatting_quota")
			}
			id := randomToken()
			_, err = tx.Exec(ctx, "INSERT INTO formatting_assets(id,owner_user_id,job_id,revision,sha256,width,height,body,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, scopeOf(ctx).UserID, c.Job.ID, c.Job.Revision, hash, cfg.Width, cfg.Height, body, s.ExpiresAt)
			if err != nil {
				return err
			}
			out.Assets = append(out.Assets, FormattingAsset{ID: id, Sha256: hash, Width: 1080, Height: 1440, URL: "/api/formatting-assets/" + id})
		}
		return nil
	})
	return out, err
}
