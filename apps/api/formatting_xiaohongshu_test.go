package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func xiaohongshuSession(t *testing.T, call formattingTestCall) FormattingSession {
	t.Helper()
	return decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "xiaohongshu-session", Platforms: []string{"xiaohongshu"}, AllowAIProcessing: true, Snapshot: FormattingSnapshot{Title: "合成技术笔记文章", Body: "# 技术说明\n\n这是完整正文。", BodyFormat: "markdown", Tags: []string{}}}, true), 201)
}
func TestFormattingXiaohongshuRenderEditConfirm(t *testing.T) {
	h, _, call := formattingFixture(t)
	s := xiaohongshuSession(t, call)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "xiaohongshu-generate", Platform: "xiaohongshu", Template: "technical"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil || len(job.Result.Assets) < 2 {
		t.Fatalf("render failed: status=%s code=%s", job.Status, job.ErrorCode)
	}
	oldAsset := job.Result.Assets[0]
	if w := call("GET", oldAsset.URL, nil, true); w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatal("private image unavailable", w.Code)
	}
	confirmed := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 1}, true), 200)
	if !confirmed.Confirmed || confirmed.ConfirmationFingerprint == "" {
		t.Fatal("not frozen")
	}
	edited := *formattingOutputCopy(job.Result)
	edited.Assets = []FormattingAsset{}
	edited.Issues = []FormattingIssue{}
	edited.Cards[0].Paragraphs = []string{"这是经过人工核对的完整正文。"}
	invalid := *formattingOutputCopy(&edited)
	invalid.Title = strings.Repeat("字", 21)
	if w := call("PUT", "/api/formatting-jobs/"+job.ID, map[string]any{"revision": job.Revision, "request_id": "invalid-edit", "template": "technical", "output": invalid}, true); w.Code != 422 {
		t.Fatal("invalid edit replaced confirmed revision", w.Code)
	}
	request := map[string]any{"revision": job.Revision, "request_id": "manual-render", "template": "checklist", "output": edited}
	next := decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID, request, true), 202)
	if next.Revision != 2 || next.Confirmed || next.Operation != "render" {
		t.Fatal("edit did not invalidate current confirmation")
	}
	again := decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID, request, true), 202)
	if again.Revision != next.Revision {
		t.Fatal("repeat edit duplicated revision")
	}
	runFormattingClaim(t, h)
	next = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if next.Status != "succeeded" || next.InputTokens != 100 || next.OutputTokens != 50 {
		t.Fatal("manual edit called model or failed", next.Status, next.ErrorCode)
	}
	if next.Result.Assets[0].Sha256 == oldAsset.Sha256 {
		t.Fatal("template edit reused old images")
	}
	var frozen bool
	var fp string
	if err := h.store.pool.QueryRow(context.Background(), "SELECT confirmed,confirmation_fingerprint FROM formatting_revisions WHERE job_id=$1 AND revision=1", job.ID).Scan(&frozen, &fp); err != nil || !frozen || fp != confirmed.ConfirmationFingerprint {
		t.Fatal("confirmed revision overwritten", err)
	}
	if w := call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 1}, true); w.Code != 409 {
		t.Fatal("stale confirmation accepted")
	}
	if w := call("POST", "/api/formatting-jobs/"+job.ID+"/csdn-draft", map[string]int64{"revision": 2}, true); w.Code != 409 {
		t.Fatal("XHS could create platform write", w.Code)
	}
	unavailable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"renderer_unavailable"}`))
	}))
	t.Cleanup(unavailable.Close)
	h.formattingConfig.FormatterURL = unavailable.URL
	edited = *formattingOutputCopy(next.Result)
	edited.Assets = []FormattingAsset{}
	decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID, map[string]any{"revision": next.Revision, "request_id": "render-unavailable", "template": "technical", "output": edited}, true), 202)
	runFormattingClaim(t, h)
	failed := decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if failed.Status != "failed" || failed.ErrorCode != "renderer_unavailable" || failed.InputTokens != 100 || failed.OutputTokens != 50 {
		t.Fatal("render failure lost original model usage", failed.Status, failed.InputTokens, failed.OutputTokens)
	}
}
func TestFormattingXiaohongshuOmittedCodeIsExplicit(t *testing.T) {
	blocks := []FormattingBlock{{ID: "code", Kind: "code", Protected: true}, {ID: "table", Kind: "table", Protected: true}}
	out := FormattingOutput{Cards: []FormattingCard{{SourceBlockIds: []string{"code", "table"}}}}
	omissions := xiaohongshuOmissions(out, blocks)
	if len(omissions) != 2 || !strings.Contains(omissions[0], "未展示完整代码") {
		t.Fatal("protected content silently omitted", omissions)
	}
	out.Omissions = omissions
	out.Cards[0].CodeRefs = []string{"code"}
	next := xiaohongshuOmissions(out, blocks)
	if len(next) != 1 || !strings.Contains(next[0], "table") {
		t.Fatal("old omissions were not recomputed", next)
	}
}
func TestFormattingXiaohongshuReferencesAndLimits(t *testing.T) {
	blocks := []FormattingBlock{{ID: "source", Kind: "paragraph", Markdown: "正文"}}
	out := FormattingOutput{Title: "合成标题", Body: "正文", CoverTitle: "封面", Cards: []FormattingCard{{Title: "要点", Paragraphs: []string{"正文"}, SourceBlockIds: []string{"source"}}}}
	if validateXiaohongshu(out, blocks) != nil {
		t.Fatal("valid note rejected")
	}
	out.Topics = []string{strings.Repeat("题", 30)}
	out.Body = strings.Repeat("文", 980)
	if validateXiaohongshu(out, blocks) == nil {
		t.Fatal("assembled topics bypassed body limit")
	}
	out.Body = "正文"
	out.Topics = nil
	out.Cards[0].CodeRefs = []string{"source"}
	if validateXiaohongshu(out, blocks) == nil {
		t.Fatal("paragraph used as executable code reference")
	}
	out.Cards[0].CodeRefs = nil
	out.Cards[0].SourceBlockIds = []string{"invented"}
	if validateXiaohongshu(out, blocks) == nil {
		t.Fatal("unknown source reference")
	}
	raw, _ := json.Marshal(out)
	if len(raw) == 0 {
		t.Fatal("unreachable")
	}
}
