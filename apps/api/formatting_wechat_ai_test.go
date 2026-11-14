package bridge

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestFormattingWechatSuggestionValidation(t *testing.T) {
	for _, test := range []struct {
		name, raw string
		valid     bool
	}{
		{"建议", `{"title":"合成标题","summary":"原文摘要","structure":[{"source_block_id":"source","text":"保留执行前提"}],"issues":[]}`, true},
		{"正文", `{"title":"","summary":"","structure":[],"issues":[],"body":"修改后的正文"}`, false},
		{"样式", `{"title":"","summary":"","structure":[],"issues":[],"style":"color:red"}`, false},
		{"链接", `{"title":"https://example.test/a","summary":"","structure":[],"issues":[]}`, false},
		{"图片", `{"title":"","summary":"assets/image.png","structure":[],"issues":[]}`, false},
		{"标记", `{"title":"# 新标题","summary":"","structure":[],"issues":[]}`, false},
		{"HTML", `{"title":"<b>标题</b>","summary":"","structure":[],"issues":[]}`, false},
		{"缺少字段", `{"title":"","summary":"","issues":[]}`, false},
		{"空问题", `{"title":"","summary":"","structure":[],"issues":[{"source_block_id":"source","text":" "}]}`, false},
		{"来源无效", `{"title":"","summary":"","structure":[],"issues":[{"source_block_id":"missing","text":"检查条件"}]}`, false},
		{"引用重复", `{"title":"","summary":"","structure":[],"issues":[{"source_block_id":"source","text":"甲"},{"source_block_id":"source","text":"乙"}]}`, false},
		{"超出长度", `{"title":"","summary":"` + strings.Repeat("字", 257) + `","structure":[],"issues":[]}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var result WechatSuggestions
			valid := strictJSON([]byte(test.raw), &result) == nil &&
				validateWechatSuggestions(result, map[string]bool{"source": true}) == nil
			if valid != test.valid {
				t.Fatal("建议校验结果异常", valid)
			}
		})
	}
}

func TestFormattingWechatAssistanceAndRevisionBinding(t *testing.T) {
	h, _, call := formattingFixture(t)
	h.formattingConfig.LocalEnabled = true
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var request struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		var source struct {
			Blocks []struct {
				ID, Kind, Text string
			} `json:"blocks"`
		}
		if r.Header.Get("Authorization") != "Bearer "+h.formattingConfig.APIKey ||
			json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Messages) != 2 ||
			json.Unmarshal([]byte(request.Messages[1].Content), &source) != nil || len(source.Blocks) != 2 ||
			source.Blocks[0].Text != "符合条件时才继续。" || source.Blocks[1].Text != "" {
			t.Error("建议请求未限制为授权的原稿内容")
			w.WriteHeader(400)
			return
		}
		suggestions := WechatSuggestions{
			Title: "合成建议标题", Summary: "只在符合条件时继续。",
			Structure: []WechatSuggestion{{SourceBlockID: source.Blocks[0].ID, Text: "把执行条件放在段首"}},
			Issues:    []WechatSuggestion{},
		}
		raw, _ := json.Marshal(suggestions)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": string(raw)}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 41, "completion_tokens": 29},
		})
	}))
	t.Cleanup(provider.Close)
	h.formattingConfig.BaseURL = provider.URL
	in := formattingSessionInput{
		RequestID: "wechat-ai-session", Mode: formattingAI, Platforms: []string{"wechat"},
		Snapshot: FormattingSnapshot{Title: "合成原文标题", Body: "符合条件时才继续。\n\n~~~go\n  return nil\n~~~", BodyFormat: "markdown"},
	}
	if response := call("POST", "/api/formatting-sessions", in, true); response.Code != 403 {
		t.Fatal("未授权的公众号原稿被接受", response.Code)
	}
	in.AllowAIProcessing = true
	bad := in
	bad.PreparationID = "external-source"
	if response := call("POST", "/api/formatting-sessions", bad, true); response.Code != 400 {
		t.Fatal("外部来源不应启用公众号建议", response.Code)
	}
	bad = in
	bad.Mode = "unknown"
	if response := call("POST", "/api/formatting-sessions", bad, true); response.Code != 400 {
		t.Fatal("未知模式被接受", response.Code)
	}
	h.formattingConfig.Enabled = false
	if response := call("POST", "/api/formatting-sessions", in, true); response.Code != 403 {
		t.Fatal("未配置模型时仍可创建建议任务", response.Code)
	}
	h.formattingConfig.Enabled = true
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	path := "/api/formatting-sessions/" + session.ID + "/jobs"
	request := formattingJobInput{RequestID: "wechat-ai-generate", Platform: "wechat", Mode: formattingAI}
	badJob := request
	badJob.Mode = formattingFidelity
	if response := call("POST", path, badJob, true); response.Code != 400 {
		t.Fatal("任务可改变会话处理模式", response.Code)
	}
	limit := h.formattingConfig.DailyTokens
	h.formattingConfig.DailyTokens = 1
	if response := call("POST", path, request, true); response.Code != 429 {
		t.Fatal("公众号建议绕过额度", response.Code)
	}
	h.formattingConfig.DailyTokens = limit
	job := decodeFormatting[FormattingJob](t, call("POST", path, request, true), 202)
	runFormattingClaim(t, h)
	jobPath := "/api/formatting-jobs/" + job.ID
	job = decodeFormatting[FormattingJob](t, call("GET", jobPath, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil || job.Result.Wechat == nil || job.Result.Wechat.Suggestions == nil {
		t.Fatal("公众号建议未生成", job.Status, job.ErrorCode)
	}
	if job.Result.Title != in.Snapshot.Title || *job.Result.Wechat.CandidateMarkdown != in.Snapshot.Body ||
		job.Result.Wechat.Suggestions.Title != "合成建议标题" || job.InputTokens != 41 || job.OutputTokens != 29 {
		t.Fatal("建议覆盖保真内容或用量异常")
	}
	binding := job.Result.Binding
	if binding == nil || binding.Platform != "wechat" || binding.Mode != formattingAI ||
		binding.PromptVersion != wechatPromptVersion || binding.RulesVersion != wechatRulesVersion ||
		binding.Model != h.formattingConfig.Model || len(binding.AssetFingerprint) != 64 {
		t.Fatal("修订缺少处理信息")
	}
	confirmed := decodeFormatting[FormattingJob](t, call("POST", jobPath+"/confirm", map[string]int64{"revision": 1}, true), 200)
	retry := decodeFormatting[FormattingJob](t, call("POST", path, request, true), 200)
	if !confirmed.Confirmed || retry.ID != job.ID || retry.ConfirmationFingerprint != confirmed.ConfirmationFingerprint {
		t.Fatal("重放没有保持原确认")
	}
	edit := wechatEditInput{Revision: 1, RequestID: "edit-assisted", Markdown: "已人工编辑正文。"}
	decodeFormatting[FormattingJob](t, call("PUT", jobPath+"/wechat", edit, true), 202)
	runFormattingClaim(t, h)
	edited := decodeFormatting[FormattingJob](t, call("GET", jobPath, nil, true), 200)
	if edited.Status != "succeeded" || edited.Revision != 2 || edited.Confirmed || edited.Result.Wechat.Suggestions == nil ||
		edited.InputTokens != 41 || edited.OutputTokens != 29 || calls.Load() != 1 {
		t.Fatal("重新排版未保留原稿建议、已计用量或重复调用了模型")
	}
	replayAfterEdit := decodeFormatting[FormattingJob](t, call("POST", path, request, true), 200)
	if replayAfterEdit.ID != job.ID || replayAfterEdit.Revision != edited.Revision {
		t.Fatal("编辑后生成请求不再幂等")
	}
}

func TestFormattingLegacyJSONSurvivesInitialization(t *testing.T) {
	h, _, call := formattingFixture(t)
	h.formattingConfig.LocalEnabled = true
	in := formattingSessionInput{
		RequestID: "legacy-local-session", Platforms: []string{"wechat"},
		Snapshot: FormattingSnapshot{Title: "合成标题", Body: "合成内容。", BodyFormat: "markdown"},
	}
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	path := "/api/formatting-sessions/" + session.ID + "/jobs"
	request := formattingJobInput{RequestID: "legacy-local-generate", Platform: "wechat"}
	job := decodeFormatting[FormattingJob](t, call("POST", path, request, true), 202)
	runFormattingClaim(t, h)

	ctx := t.Context()
	if _, err := h.store.pool.Exec(ctx, "UPDATE formatting_sessions SET record=record-'mode' WHERE id=$1", session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.pool.Exec(ctx, "UPDATE formatting_jobs SET record=(record-'mode')#-'{result,binding}' WHERE id=$1", job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.pool.Exec(ctx, "UPDATE formatting_revisions SET record=record-'binding' WHERE job_id=$1", job.ID); err != nil {
		t.Fatal(err)
	}
	legacyFingerprint := integrationDigest([]any{session.ID, request, session.ContentFingerprint, job.PromptVersion, job.RulesVersion, job.Model})
	if _, err := h.store.pool.Exec(ctx, "UPDATE formatting_jobs SET fingerprint=$2 WHERE id=$1", job.ID, legacyFingerprint); err != nil {
		t.Fatal(err)
	}
	jobPath := "/api/formatting-jobs/" + job.ID
	first := decodeFormatting[FormattingJob](t, call("POST", jobPath+"/confirm", map[string]int64{"revision": 1}, true), 200)
	var before, after []byte
	query := "SELECT record FROM formatting_revisions WHERE job_id=$1 AND revision=1"
	if err := h.store.pool.QueryRow(ctx, query, job.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(ctx, h.store.pool.Pool, "tester", "合成账号"); err != nil {
		t.Fatal(err)
	}
	in.Mode = formattingFidelity
	replayedSession := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	request.Mode = formattingFidelity
	replayed := decodeFormatting[FormattingJob](t, call("POST", path, request, true), 200)
	if replayedSession.ID != session.ID || replayed.ID != first.ID ||
		replayed.ConfirmationFingerprint != first.ConfirmationFingerprint || replayed.Result == nil || replayed.Result.Binding != nil {
		t.Fatal("兼容读取或重试改写了旧记录")
	}
	if err := h.store.pool.QueryRow(ctx, query, job.ID).Scan(&after); err != nil || !bytes.Equal(before, after) {
		t.Fatal("数据库初始化改写了已确认修订", err)
	}
	result := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() {
			result <- call("POST", jobPath+"/confirm", map[string]int64{"revision": 1}, true)
		}()
	}
	for range 2 {
		confirmed := decodeFormatting[FormattingJob](t, <-result, 200)
		if !confirmed.Confirmed || confirmed.ConfirmationFingerprint != first.ConfirmationFingerprint {
			t.Fatal("并发重放确认改变了冻结的摘要")
		}
	}
}

func TestFormattingWechatMalformedProviderResponseIsRedacted(t *testing.T) {
	h, _, call := formattingFixture(t)
	const privateMarker = "synthetic-private-provider-content"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{
				"message":       map[string]string{"content": `{"title":"` + privateMarker + `","html":"<p>未授权内容</p>"}`},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 13, "completion_tokens": 7},
		})
	}))
	t.Cleanup(provider.Close)
	h.formattingConfig.BaseURL = provider.URL
	in := formattingSessionInput{
		RequestID: "bad-suggestion-session", Platforms: []string{"wechat"}, Mode: formattingAI, AllowAIProcessing: true,
		Snapshot: FormattingSnapshot{Title: "合成标题", Body: "合成内容。", BodyFormat: "markdown"},
	}
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "bad-suggestion-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	received := call("GET", "/api/formatting-jobs/"+job.ID, nil, true)
	failed := decodeFormatting[FormattingJob](t, received, 200)
	if failed.ErrorCode != "provider_invalid_json" || failed.Status != "failed" || failed.Result != nil ||
		failed.InputTokens != 13 || failed.OutputTokens != 7 || strings.Contains(received.Body.String(), privateMarker) ||
		strings.Contains(received.Body.String(), h.formattingConfig.APIKey) {
		t.Fatal("格式化错误暴露模型响应或丢失用量")
	}
}
