package bridge

import (
	"context"
	"regexp"
	"strings"
	"unicode"
)

const wechatPromptVersion = "wechat-ai-1"
const wechatSuggestionPrompt = formattingCommonPrompt + `你是微信公众号编辑。拟定标题、摘要，提出有原文依据的结构建议或指出需人工核对的问题。仅提出建议，不生成正文或修改内容。
只输出 {"title":"","summary":"","structure":[{"source_block_id":"原文块ID","text":"建议"}],"issues":[{"source_block_id":"原文块ID","text":"需要人工核对的问题"}]}。
标题最多100字，摘要最多256字，每条建议或问题最多240字，每类最多10条。同一类中每个块最多引用一次。使用纯文本，不输出样式、链接、素材地址、代码或Markdown。无需建议时使用空字符串或空数组。`

var wechatSuggestionURL = regexp.MustCompile(`(?i)(?:[a-z][a-z0-9+.-]*://|\b(?:www\.|data:|mailto:|javascript:)|//\S|\b[^\s/]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\b|$))`)
var wechatSuggestionMarkup = regexp.MustCompile(`^(?:#{1,6}\s|[-+*]\s|\d+[.)]\s)|\*\*|__|~~|!\[`)

func validWechatSuggestionText(value string, max int) bool {
	return validFormattingText(value, max) && !strings.ContainsAny(value, "<>`[]") &&
		strings.IndexFunc(value, unicode.IsControl) == -1 && !wechatSuggestionURL.MatchString(value) &&
		!wechatSuggestionMarkup.MatchString(strings.TrimSpace(value))
}

func validateWechatSuggestions(result WechatSuggestions, known map[string]bool) error {
	if !validWechatSuggestionText(result.Title, 100) || !validWechatSuggestionText(result.Summary, 256) {
		return ErrFormattingContent
	}
	for _, items := range [][]WechatSuggestion{result.Structure, result.Issues} {
		if items == nil || len(items) > 10 {
			return ErrFormattingContent
		}
		seen := map[string]bool{}
		for _, item := range items {
			if !known[item.SourceBlockID] || seen[item.SourceBlockID] || strings.TrimSpace(item.Text) == "" ||
				!validWechatSuggestionText(item.Text, 240) {
				return ErrFormattingContent
			}
			seen[item.SourceBlockID] = true
		}
	}
	return nil
}

func (h *handler) suggestWechat(ctx context.Context, c formattingClaim, output FormattingOutput) (FormattingOutput, FormattingUsage, error) {
	var usage FormattingUsage
	session, err := h.formattingCheckpoint(ctx, c, "analyzing")
	if err != nil {
		return output, usage, err
	}
	if session.PreparationID != "" || formattingMode(c.Job.Platform, session.Mode) != formattingAI {
		return output, usage, ErrIntegrationPermission
	}
	var analyzed struct {
		Blocks []FormattingBlock `json:"blocks"`
	}
	if err = h.formattingConfig.formatter(ctx, "/analyze", map[string]string{
		"markdown": session.Snapshot.Body, "platform": "wechat",
	}, &analyzed); err != nil {
		return output, usage, err
	}
	if len(analyzed.Blocks) != len(output.Wechat.Blocks) {
		return output, usage, ErrFormattingContent
	}
	type sourceBlock struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Text string `json:"text"`
	}
	blocks := make([]sourceBlock, len(analyzed.Blocks))
	known := make(map[string]bool, len(analyzed.Blocks))
	for i, block := range analyzed.Blocks {
		if block.ID != output.Wechat.Blocks[i].SourceBlockID {
			return output, usage, ErrFormattingContent
		}
		known[block.ID] = true
		text := block.Text
		if block.Protected {
			text = ""
		}
		blocks[i] = sourceBlock{ID: block.ID, Kind: block.Kind, Text: text}
	}
	if _, err = h.formattingCheckpoint(ctx, c, "generating"); err != nil {
		return output, usage, err
	}
	providerCtx, cancel := context.WithTimeout(ctx, h.formattingConfig.Timeout)
	defer cancel()
	var response struct {
		Title     *string            `json:"title"`
		Summary   *string            `json:"summary"`
		Structure []WechatSuggestion `json:"structure"`
		Issues    []WechatSuggestion `json:"issues"`
	}
	usage, err = h.formattingConfig.requestFormattingModel(providerCtx, wechatSuggestionPrompt, map[string]any{
		"title": session.Snapshot.Title, "summary": session.Snapshot.Summary, "blocks": blocks,
	}, &response)
	if err != nil {
		return output, usage, err
	}
	if response.Title == nil || response.Summary == nil {
		return output, usage, ErrFormattingContent
	}
	suggestions := WechatSuggestions{Title: *response.Title, Summary: *response.Summary, Structure: response.Structure, Issues: response.Issues}
	if err = validateWechatSuggestions(suggestions, known); err != nil {
		return output, usage, err
	}
	if _, err = h.formattingCheckpoint(ctx, c, "validating"); err != nil {
		return output, usage, err
	}
	output.Wechat.Suggestions = &suggestions
	return output, usage, nil
}
