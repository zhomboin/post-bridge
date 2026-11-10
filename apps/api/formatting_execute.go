package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

func (h *handler) executeFormatting(ctx context.Context, c formattingClaim) (FormattingOutput, FormattingUsage, error) {
	out := FormattingOutput{Tags: []string{}, Topics: []string{}, Cards: []FormattingCard{}, Omissions: []string{}, Issues: []FormattingIssue{}, Assets: []FormattingAsset{}}
	var usage FormattingUsage
	session, err := h.formattingCheckpoint(ctx, c, "analyzing")
	if err != nil {
		return out, usage, err
	}
	var analyzed struct {
		Blocks []FormattingBlock `json:"blocks"`
	}
	if err = h.formattingConfig.formatter(ctx, "/analyze", map[string]any{"markdown": session.Snapshot.Body}, &analyzed); err != nil {
		return out, usage, err
	}
	if len(analyzed.Blocks) == 0 || len(analyzed.Blocks) > 2000 {
		return out, usage, ErrFormattingContent
	}
	if c.Job.Operation == "render" {
		if c.Job.Result == nil || c.Job.Platform != "xiaohongshu" {
			return out, usage, ErrFormattingContent
		}
		out = *formattingOutputCopy(c.Job.Result)
		usage = FormattingUsage{Input: c.Job.InputTokens, Output: c.Job.OutputTokens}
		if err = validateXiaohongshu(out, analyzed.Blocks); err != nil {
			return out, usage, err
		}
		out.Omissions = xiaohongshuOmissions(out, analyzed.Blocks)
		out, err = h.renderXiaohongshu(ctx, c, session, out)
		return out, usage, err
	}
	if _, err = h.formattingCheckpoint(ctx, c, "generating"); err != nil {
		return out, usage, err
	}
	providerCtx, cancel := context.WithTimeout(ctx, h.formattingConfig.Timeout)
	result, usage, err := h.formattingConfig.generate(providerCtx, c.Job.Platform, session.Snapshot, analyzed.Blocks)
	cancel()
	if err != nil {
		return out, usage, err
	}
	if _, err = h.formattingCheckpoint(ctx, c, "validating"); err != nil {
		return out, usage, err
	}
	if c.Job.Platform == "xiaohongshu" {
		out, err = h.xiaohongshuOutput(ctx, c, session, analyzed.Blocks, result)
		return out, usage, err
	}
	if !validFormattingText(result.Title, 100) || utf8.RuneCountInString(strings.TrimSpace(result.Title)) < 5 || len(result.Edits) > len(analyzed.Blocks) || len(result.Issues) > 10 {
		return out, usage, ErrFormattingContent
	}
	for _, issue := range result.Issues {
		if !validFormattingText(issue.Message, 500) || len(issue.Code) > 64 || len(issue.Field) > 100 {
			return out, usage, ErrFormattingContent
		}
	}
	blocks := make([]FormattingEdit, len(analyzed.Blocks))
	index := map[string]int{}
	for i, b := range analyzed.Blocks {
		blocks[i] = FormattingEdit{ID: b.ID, Markdown: b.Markdown}
		index[b.ID] = i
	}
	seen := map[string]bool{}
	for _, edit := range result.Edits {
		i, exists := index[edit.ID]
		if !exists || seen[edit.ID] || analyzed.Blocks[i].Protected || !validFormattingText(edit.Markdown, 200000) {
			return out, usage, ErrFormattingContent
		}
		seen[edit.ID] = true
		blocks[i] = edit
	}
	var checked struct {
		Markdown string `json:"markdown"`
	}
	if err = h.formattingConfig.formatter(ctx, "/validate-csdn", map[string]any{"markdown": session.Snapshot.Body, "original": analyzed.Blocks, "blocks": blocks}, &checked); err != nil {
		return out, usage, err
	}
	sourceImages, e := approvedImageMarkdown(session.Snapshot.Title, session.Snapshot.Body, nil)
	if e != nil {
		return out, usage, e
	}
	if _, e = approvedImageMarkdown(result.Title, checked.Markdown, sourceImages); e != nil {
		return out, usage, e
	}
	options := defaultCSDNPublishOptions()
	options.Tags = result.Tags
	options.Summary = result.Summary
	if _, e = normalizeCSDNPublishOptions(options, ""); e != nil {
		return out, usage, ErrFormattingContent
	}
	out.Title = strings.TrimSpace(result.Title)
	out.Markdown = checked.Markdown
	out.Summary = result.Summary
	out.Tags = result.Tags
	out.Issues = result.Issues
	if out.Tags == nil {
		out.Tags = []string{}
	}
	if out.Issues == nil {
		out.Issues = []FormattingIssue{}
	}
	if _, err = h.formattingCheckpoint(ctx, c, "validating"); err != nil {
		return out, usage, err
	}
	return out, usage, nil
}
func formattingOutputFingerprint(job FormattingJob) string {
	// 确认绑定最终内容；提示词升级不会改变已确认修订。
	return integrationDigest([]any{"postbridge-formatting-v1", job.ID, job.Revision, job.Platform, job.Result})
}
func formattingOutputCopy(out *FormattingOutput) *FormattingOutput {
	if out == nil {
		return nil
	}
	raw, _ := json.Marshal(out)
	var clone FormattingOutput
	_ = json.Unmarshal(raw, &clone)
	return &clone
}
