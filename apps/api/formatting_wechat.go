package bridge

import (
	"context"
	"strings"
)

const wechatRulesVersion = "wechat-3"

func (h *handler) executeWechat(ctx context.Context, c formattingClaim, out FormattingOutput) (FormattingOutput, FormattingUsage, error) {
	var usage FormattingUsage
	session, err := h.formattingCheckpoint(ctx, c, "analyzing")
	if err != nil {
		return out, usage, err
	}
	markdown := session.Snapshot.Body
	if c.Job.Operation == "wechat_edit" {
		if c.Job.Result == nil || c.Job.Result.Wechat == nil || c.Job.Result.Wechat.CandidateMarkdown == nil {
			return out, usage, ErrFormattingContent
		}
		markdown = *c.Job.Result.Wechat.CandidateMarkdown
	}
	var result struct {
		Blocks []WechatBlock `json:"blocks"`
		Images []WechatImage `json:"images"`
		Issues []struct {
			BlockID  string `json:"block_id"`
			Code     string `json:"code"`
			Blocking bool   `json:"blocking"`
		} `json:"issues"`
	}
	if err = h.formattingConfig.formatter(ctx, "/convert-wechat", map[string]any{"markdown": markdown}, &result); err != nil {
		return out, usage, err
	}
	if len(result.Blocks) == 0 || len(result.Blocks) > 2000 || len(result.Issues) > 4000 || len(result.Images) > 200 {
		return out, usage, ErrFormattingContent
	}
	known := map[string]bool{}
	for _, block := range result.Blocks {
		if block.SourceBlockID == "" || len(block.SourceBlockID) > 64 || known[block.SourceBlockID] || len(block.Html) > 4<<20 {
			return out, usage, ErrFormattingContent
		}
		known[block.SourceBlockID] = true
	}
	imageIDs := map[string]bool{}
	for _, image := range result.Images {
		if !known[image.SourceBlockID] || image.ID == "" || len(image.ID) > 80 || imageIDs[image.ID] || !validFormattingText(image.Source, 100000) || !validFormattingText(image.Alt, 100000) {
			return out, usage, ErrFormattingContent
		}
		imageIDs[image.ID] = true
	}
	var validation struct {
		Issues []struct {
			BlockID  string `json:"block_id"`
			Code     string `json:"code"`
			Blocking bool   `json:"blocking"`
		} `json:"issues"`
	}
	if err = h.formattingConfig.formatter(ctx, "/validate-wechat", map[string]any{"markdown": markdown, "blocks": result.Blocks}, &validation); err != nil {
		return out, usage, err
	}
	if validation.Issues == nil || len(validation.Issues) > len(result.Blocks) {
		return out, usage, ErrFormattingContent
	}
	validatedIssues := map[string]bool{}
	for _, issue := range validation.Issues {
		validIssue := issue.Code == "content_review" && issue.Blocking || issue.Code == "verification_incomplete" && !issue.Blocking
		if !known[issue.BlockID] || validatedIssues[issue.BlockID] || !validIssue {
			return out, usage, ErrFormattingContent
		}
		validatedIssues[issue.BlockID] = true
	}
	result.Issues = append(result.Issues, validation.Issues...)
	attachments := []WechatAttachment{}
	if c.Job.Operation == "wechat_edit" && c.Job.Result.Wechat.Attachments != nil {
		attachments = *c.Job.Result.Wechat.Attachments
	}
	if len(attachments) > 0 {
		oldImages := []WechatImage{}
		if c.Job.Result.Wechat.Images != nil {
			oldImages = *c.Job.Result.Wechat.Images
		}
		attachments, err = remapWechatUploads(oldImages, result.Images, attachments)
		if err != nil {
			return out, usage, err
		}
	}
	replaced, err := applyWechatUploads(result.Blocks, result.Images, attachments)
	if err != nil {
		return out, usage, err
	}
	issues := []FormattingIssue{}
	for _, issue := range result.Issues {
		if !known[issue.BlockID] || issue.Code == "" || len(issue.Code) > 64 {
			return out, usage, ErrFormattingContent
		}
		if issue.Code == "image_unavailable" {
			count, resolved := 0, 0
			for _, image := range result.Images {
				if image.SourceBlockID == issue.BlockID {
					count++
					if replaced[image.ID] {
						resolved++
					}
				}
			}
			if count > 0 && count == resolved {
				continue
			}
		}
		issues = append(issues, FormattingIssue{Code: issue.Code, Field: issue.BlockID, Message: wechatIssueMessage(issue.Code), Blocking: issue.Blocking})
	}
	out.Title = session.Snapshot.Title
	out.Summary = session.Snapshot.Summary
	out.Tags = session.Snapshot.Tags
	out.Wechat = &WechatResult{Blocks: result.Blocks, Issues: issues, Images: &result.Images, CandidateMarkdown: &markdown, Attachments: &attachments}
	if c.Job.Operation == "wechat_edit" {
		out.Wechat.Suggestions = c.Job.Result.Wechat.Suggestions
	}
	out.Issues = issues
	if _, err = h.formattingCheckpoint(ctx, c, "validating"); err != nil {
		return out, usage, err
	}
	return out, usage, nil
}

func wechatIssueMessage(code string) string {
	switch {
	case code == "image_unavailable":
		return "图片尚未接入，请核对原稿中的图片。"
	case code == "unsupported_link":
		return "链接目标无法安全展示，请核对原稿。"
	case code == "formula_review":
		return "公式已保留原文，请核对显示效果。"
	case strings.HasPrefix(code, "html_"):
		return "部分 HTML 内容或属性需要核对。"
	case code == "code_metadata_review":
		return "代码附加信息需要核对。"
	case code == "content_review":
		return "转换内容可能有遗漏或变化，请对照原稿核对。"
	case code == "verification_incomplete":
		return "HTML 内容无法完整自动核对，请对照原稿查看。"
	default:
		return "部分内容需要对照原稿核对。"
	}
}
