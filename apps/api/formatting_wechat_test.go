package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func syntheticWechatPNG(t *testing.T) string {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestFormattingWechatImageValidation(t *testing.T) {
	good := syntheticWechatPNG(t)
	for _, uploads := range [][]wechatUpload{
		{{ImageID: "a", Data: "not-base64"}},
		{{ImageID: "a", Data: base64.StdEncoding.EncodeToString([]byte("<svg/>"))}},
		{{ImageID: "a", Data: good}, {ImageID: "a", Data: good}},
		{{ImageID: "a", Data: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), (4<<20)+1))}},
	} {
		if _, err := validateWechatUploads(uploads); err == nil {
			t.Fatal("无效图片被接受")
		}
	}
	valid, err := validateWechatUploads([]wechatUpload{{ImageID: "a", Data: good}})
	if err != nil || len(valid) != 1 || valid[0].MediaType != "image/png" || len(valid[0].Sha256) != 64 {
		t.Fatal("合成图片未通过校验", err)
	}
}

func TestFormattingWechatImageRemap(t *testing.T) {
	old := []WechatImage{{ID: "old", Source: "https://example.test/a"}}
	next := []WechatImage{{ID: "new", Source: "https://example.test/a"}}
	uploads, err := remapWechatUploads(old, next, []WechatAttachment{{ImageID: "old"}})
	if err != nil || uploads[0].ImageID != "new" {
		t.Fatal("唯一图片未重新映射", err)
	}
	changedDefinition := []WechatImage{{ID: "old", Source: "https://example.test/b"}}
	if _, err = remapWechatUploads(old, changedDefinition, []WechatAttachment{{ImageID: "old"}}); formattingErrorCode(err) != "wechat_image_changed" {
		t.Fatal("引用式图片沿用了已更改地址的素材", err)
	}
	uploads, err = remapWechatUploads(old, append(changedDefinition, next...), []WechatAttachment{{ImageID: "old"}})
	if err != nil || uploads[0].ImageID != "new" {
		t.Fatal("唯一旧图片还在时应按图片来源映射", err)
	}
	old = append(old, WechatImage{ID: "another", Source: "https://example.test/a"})
	if _, err = remapWechatUploads(old, next, []WechatAttachment{{ImageID: "old"}}); err == nil {
		t.Fatal("重复图片来源不应猜测映射")
	}
}

func TestFormattingWechatConfirmationBindsRulesAndContent(t *testing.T) {
	job := FormattingJob{ID: "job", Revision: 1, Platform: "wechat", RulesVersion: "wechat-1", Result: &FormattingOutput{Wechat: &WechatResult{Blocks: []WechatBlock{{SourceBlockID: "b0", Html: "<p>原文</p>"}}}}}
	fingerprint := formattingOutputFingerprint(job)
	job.RulesVersion = "other"
	if fingerprint == formattingOutputFingerprint(job) {
		t.Fatal("规则版本未绑定确认")
	}
	job.RulesVersion = "wechat-1"
	job.Result.Wechat.Blocks[0].Html = "<p>修改</p>"
	if fingerprint == formattingOutputFingerprint(job) {
		t.Fatal("结果未绑定确认")
	}
	job.Result.Wechat.Blocks[0].Html = "<p>原文</p>"
	attachments := []WechatAttachment{{ImageID: "image", Sha256: "synthetic"}}
	job.Result.Wechat.Attachments = &attachments
	if fingerprint == formattingOutputFingerprint(job) {
		t.Fatal("素材未绑定确认")
	}
}

func TestFormattingWechatLocalLifecycle(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-token" {
			t.Error("unexpected formatter request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == "/validate-wechat" {
			_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}})
			return
		}
		if r.URL.Path != "/convert-wechat" {
			t.Error("unexpected formatter path")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"blocks": []map[string]string{{"source_block_id": "b0-example", "html": "<p>合成正文。</p>"}}, "issues": []any{}})
	}))
	t.Cleanup(formatter.Close)
	h.formattingConfig = defaultFormattingConfig()
	h.formattingConfig.LocalEnabled = true
	h.formattingConfig.FormatterURL = formatter.URL
	h.formattingConfig.FormatterToken = "local-token"
	in := formattingSessionInput{RequestID: "wechat-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "公众号合成稿", Body: "合成正文。", BodyFormat: "markdown"}}
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	other := scoped(context.Background(), tenantScope{UserID: "other-user", CallerID: "formatting:test"})
	err := h.store.locked(other, func(tx pgx.Tx, _ time.Time) error {
		_, err := h.readFormattingSession(other, tx, session.ID, false)
		return err
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatal("其他用户不应读取本地稿", err)
	}
	jobInput := formattingJobInput{RequestID: "wechat-job", Platform: "wechat"}
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", jobInput, true), 202)
	if job.Model != "" || job.PromptVersion != "" || job.RulesVersion != wechatRulesVersion {
		t.Fatal("本地任务不应使用模型", job)
	}
	replayed := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", jobInput, true), 200)
	if replayed.ID != job.ID {
		t.Fatal("重复请求创建了任务")
	}
	var reserved int64
	if err := h.store.pool.QueryRow(t.Context(), "SELECT reservation FROM formatting_jobs WHERE id=$1", job.ID).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatal("本地任务预留了模型额度", err, reserved)
	}
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil || job.Result.Wechat == nil || !strings.Contains(job.Result.Wechat.Blocks[0].Html, "合成正文") || job.InputTokens != 0 || job.OutputTokens != 0 {
		t.Fatal("本地转换未完成", job.Status, job.ErrorCode)
	}
	confirmed := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": job.Revision}, true), 200)
	if !confirmed.Confirmed || confirmed.ConfirmationFingerprint == "" {
		t.Fatal("确认未绑定修订")
	}
	if _, err := h.editWechat(other, job.ID, wechatEditInput{Revision: job.Revision, RequestID: "foreign-edit", Markdown: "其他内容"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("其他用户不应编辑本地稿", err)
	}
	if response := call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": job.Revision + 1}, true); response.Code != 409 {
		t.Fatal("错误修订被确认", response.Code)
	}
	in.RequestID = "wechat-source"
	in.PreparationID = "source"
	if response := call("POST", "/api/formatting-sessions", in, true); response.Code == 201 {
		t.Fatal("外部来源不能绕过授权")
	}
	in.RequestID = "ai-not-enabled"
	in.PreparationID = ""
	in.Platforms = []string{"xiaohongshu"}
	in.AllowAIProcessing = true
	if response := call("POST", "/api/formatting-sessions", in, true); response.Code == 201 {
		t.Fatal("仅启用本地转换时不能调用 AI")
	}
	if response := call("PUT", "/api/formatting-jobs/"+job.ID, map[string]any{}, true); response.Code != 503 {
		t.Fatal("仅启用本地转换时不应开启 AI 编辑入口", response.Code)
	}
}

func TestFormattingWechatExpiredLeaseCannotWriteResult(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	var jobID string
	formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := h.store.pool.Exec(r.Context(), "UPDATE formatting_jobs SET lease_expires_at=$2 WHERE id=$1", jobID, h.store.now().Add(-time.Second)); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"blocks": []map[string]string{{"source_block_id": "b0-example", "html": "<p>合成正文。</p>"}}, "issues": []any{}, "images": []any{}})
	}))
	t.Cleanup(formatter.Close)
	h.formattingConfig = defaultFormattingConfig()
	h.formattingConfig.LocalEnabled = true
	h.formattingConfig.FormatterURL = formatter.URL
	h.formattingConfig.FormatterToken = "local-token"
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "lease-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "合成正文。", BodyFormat: "markdown"}}, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "lease-job", Platform: "wechat"}, true), 202)
	jobID = job.ID
	claim, err := h.claimFormatting(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	h.runFormatting(context.Background(), claim)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "running" || job.Result != nil {
		t.Fatal("失租执行器不应写入结果或任务状态", job.Status)
	}
	h.maintainFormatting(context.Background())
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "failed" || job.ErrorCode != "processing_interrupted" || job.Result != nil {
		t.Fatal("失租任务未安全恢复", job.Status, job.ErrorCode)
	}
}

func TestFormattingWechatIndependentReview(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/convert-wechat":
			_ = json.NewEncoder(w).Encode(map[string]any{"blocks": []map[string]string{{"source_block_id": "b0-example", "html": "<p>部分正文。</p>"}}, "issues": []any{}, "images": []any{}})
		case "/validate-wechat":
			_ = json.NewEncoder(w).Encode(map[string]any{"issues": []map[string]any{{"block_id": "b0-example", "code": "content_review", "blocking": true}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(formatter.Close)
	h.formattingConfig = defaultFormattingConfig()
	h.formattingConfig.LocalEnabled = true
	h.formattingConfig.FormatterURL = formatter.URL
	h.formattingConfig.FormatterToken = "local-token"
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "review-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "完整正文。", BodyFormat: "markdown"}}, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "review-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "needs_review" || job.Result == nil || len(job.Result.Issues) != 1 || job.Result.Issues[0].Code != "content_review" {
		t.Fatal("独立校验问题未保留", job.Status, job.ErrorCode)
	}
	if response := call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": job.Revision}, true); response.Code != 409 {
		t.Fatal("内容待核对时不能确认", response.Code)
	}
}

func TestFormattingWechatCancelInFlight(t *testing.T) {
	for _, blockedPath := range []string{"/convert-wechat", "/validate-wechat"} {
		t.Run(blockedPath, func(t *testing.T) {
			h, _, call := integrationHTTPFixture(t)
			started := make(chan struct{})
			formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == blockedPath {
					_, _ = io.Copy(io.Discard, r.Body)
					close(started)
					<-r.Context().Done()
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"blocks": []map[string]string{{"source_block_id": "b0-example", "html": "<p>合成正文。</p>"}}, "issues": []any{}, "images": []any{}})
			}))
			t.Cleanup(formatter.Close)
			h.formattingConfig = defaultFormattingConfig()
			h.formattingConfig.LocalEnabled = true
			h.formattingConfig.FormatterURL = formatter.URL
			h.formattingConfig.FormatterToken = "local-token"
			session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "cancel-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "合成正文。", BodyFormat: "markdown"}}, true), 201)
			job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "cancel-job", Platform: "wechat"}, true), 202)
			claim, err := h.claimFormatting(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() { defer close(done); h.runFormatting(ctx, claim) }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("转换服务未收到请求")
			}
			decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/cancel", nil, true), 200)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("取消后执行器未退出")
			}
			job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
			if job.Status != "cancelled" || job.Result != nil {
				t.Fatal("取消后仍写入结果", job.Status)
			}
		})
	}
}

func TestFormattingWechatExpiryDuringValidation(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	var session FormattingSession
	formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/validate-wechat" {
			expired := session
			expired.ExpiresAt = h.store.now().Add(-time.Second).Format(time.RFC3339Nano)
			raw, err := json.Marshal(expired)
			if err == nil {
				_, err = h.store.pool.Exec(r.Context(), "UPDATE formatting_sessions SET record=$2 WHERE id=$1", session.ID, raw)
			}
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"blocks": []map[string]string{{"source_block_id": "b0-example", "html": "<p>合成正文。</p>"}}, "issues": []any{}, "images": []any{}})
	}))
	t.Cleanup(formatter.Close)
	h.formattingConfig = defaultFormattingConfig()
	h.formattingConfig.LocalEnabled = true
	h.formattingConfig.FormatterURL = formatter.URL
	h.formattingConfig.FormatterToken = "local-token"
	session = decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "expiry-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "合成正文。", BodyFormat: "markdown"}}, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "expiry-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	var raw []byte
	if err := h.store.pool.QueryRow(t.Context(), "SELECT record FROM formatting_jobs WHERE id=$1", job.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &job); err != nil {
		t.Fatal(err)
	}
	if job.Status != "failed" || job.ErrorCode != "source_unavailable" || job.Result != nil {
		t.Fatal("过期会话不应产生可用结果", job.Status, job.ErrorCode)
	}
	if response := call("GET", "/api/formatting-jobs/"+job.ID, nil, true); response.Code != 410 {
		t.Fatal("过期任务不应对外可读", response.Code)
	}
}

func TestFormattingWechatWithFormatter(t *testing.T) {
	h, _, call := formattingFixture(t)
	h.formattingConfig.Enabled = false
	h.formattingConfig.LocalEnabled = true
	h.formattingConfig.APIKey = ""
	in := formattingSessionInput{RequestID: "wechat-real-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "# 标题\n\n[参考](https://example.test/doc)\n\n```go\nfunc main() {\n  x := 1\n}\n```", BodyFormat: "markdown"}}
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "wechat-real-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil || job.Result.Wechat == nil || len(job.Result.Wechat.Blocks) != 3 {
		t.Fatal("真实转换服务未完成", job.Status, job.ErrorCode)
	}
	if !strings.Contains(job.Result.Wechat.Blocks[1].Html, "https://example.test/doc") || !strings.Contains(job.Result.Wechat.Blocks[2].Html, "  x := 1") {
		t.Fatal("链接或代码丢失", job.Result.Wechat.Blocks)
	}
	if job.InputTokens != 0 || job.OutputTokens != 0 {
		t.Fatal("本地任务产生模型用量")
	}
	// 模拟旧版已完成任务：确认保持旧规则，编辑新修订采用现行规则。
	job.RulesVersion = "wechat-1"
	oldRecord, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.pool.Exec(t.Context(), "UPDATE formatting_jobs SET record=$2 WHERE id=$1", job.ID, oldRecord); err != nil {
		t.Fatal(err)
	}
	confirmed := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 1}, true), 200)
	edit := wechatEditInput{Revision: 1, RequestID: "wechat-edit", Markdown: "# 修改后的标题\n\n修改后的正文。"}
	queued := decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", edit, true), 202)
	if queued.Revision != 2 || queued.Confirmed || queued.RulesVersion != wechatRulesVersion {
		t.Fatal("编辑没有创建新修订")
	}
	replayed := decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", edit, true), 202)
	if replayed.Revision != 2 {
		t.Fatal("重试创建了重复修订")
	}
	changed := edit
	changed.Markdown = "不同内容"
	if response := call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", changed, true); response.Code != 409 {
		t.Fatal("相同请求标识允许不同内容", response.Code)
	}
	if response := call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 1}, true); response.Code != 409 {
		t.Fatal("旧修订被重新确认")
	}
	runFormattingClaim(t, h)
	edited := decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if edited.Status != "succeeded" || !strings.Contains(edited.Result.Wechat.Blocks[0].Html, "修改后的标题") {
		t.Fatal("编辑结果未重新转换", edited.Status, edited.ErrorCode)
	}
	var frozen bool
	var fingerprint string
	if err := h.store.pool.QueryRow(t.Context(), "SELECT confirmed,confirmation_fingerprint FROM formatting_revisions WHERE job_id=$1 AND revision=1", job.ID).Scan(&frozen, &fingerprint); err != nil || !frozen || fingerprint != confirmed.ConfirmationFingerprint {
		t.Fatal("原确认被覆盖", err)
	}
	currentSession := decodeFormatting[FormattingSession](t, call("GET", "/api/formatting-sessions/"+session.ID, nil, true), 200)
	if currentSession.Snapshot.Body != in.Snapshot.Body {
		t.Fatal("原稿被编辑覆盖")
	}
	in.RequestID = "wechat-image-session"
	in.Snapshot.Body = "<div>合成说明</div>\n\n![合成图片](https://example.test/image.png)"
	session = decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	job = decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "wechat-image-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "needs_review" || job.Result == nil || job.Result.Wechat == nil || len(job.Result.Wechat.Issues) == 0 {
		t.Fatal("缺失图片未提示人工核对", job.Status, job.ErrorCode)
	}
	if response := call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": job.Revision}, true); response.Code != 409 {
		t.Fatal("有阻断问题的结果不能确认", response.Code)
	}
	if job.Result.Wechat.Images == nil || len(*job.Result.Wechat.Images) != 1 {
		t.Fatal("没有图片来源映射")
	}
	imageID := (*job.Result.Wechat.Images)[0].ID
	bad := wechatEditInput{Revision: job.Revision, RequestID: "wechat-invalid-image", Markdown: in.Snapshot.Body, Attachments: []wechatUpload{{ImageID: imageID, Data: base64.StdEncoding.EncodeToString([]byte("not an image"))}}}
	if response := call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", bad, true); response.Code != 422 || !strings.Contains(response.Body.String(), "wechat_invalid_image") {
		t.Fatal("无效素材未被明确拒绝", response.Code)
	}
	attachment := wechatEditInput{Revision: job.Revision, RequestID: "wechat-image-attach", Markdown: in.Snapshot.Body, Attachments: []wechatUpload{{ImageID: imageID, Data: syntheticWechatPNG(t)}}}
	queued = decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", attachment, true), 202)
	if queued.Revision != 2 {
		t.Fatal("素材更换未创建修订")
	}
	runFormattingClaim(t, h)
	withImage := decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if withImage.Status != "succeeded" || withImage.Result.Wechat.Attachments == nil || !strings.Contains(withImage.Result.Wechat.Blocks[1].Html, "data:image/png;base64,") {
		t.Fatal("本地素材未安全映射", withImage.Status, withImage.ErrorCode)
	}
	if !decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 2}, true), 200).Confirmed {
		t.Fatal("素材修订未确认")
	}
	other := scoped(context.Background(), tenantScope{UserID: "other-user", CallerID: "formatting:test"})
	if _, err := h.getFormattingJob(other, job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("其他用户不应读取图片素材", err)
	}
	removed := wechatEditInput{Revision: 2, RequestID: "wechat-image-remove", Markdown: in.Snapshot.Body}
	decodeFormatting[FormattingJob](t, call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", removed, true), 202)
	runFormattingClaim(t, h)
	without := decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if without.Status != "needs_review" || strings.Contains(without.Result.Wechat.Blocks[1].Html, "data:image/") || without.Confirmed {
		t.Fatal("移除素材后应重新核对", without.Status)
	}
	session.ExpiresAt = h.store.now().Add(-time.Second).Format(time.RFC3339Nano)
	raw, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.store.pool.Exec(t.Context(), "UPDATE formatting_sessions SET record=$2 WHERE id=$1", session.ID, raw); err != nil {
		t.Fatal(err)
	}
	if response := call("GET", "/api/formatting-jobs/"+job.ID, nil, true); response.Code != 410 {
		t.Fatal("会话到期后仍可读取素材", response.Code)
	}
}

func TestFormattingWechatConcurrentEdits(t *testing.T) {
	h, _, call := formattingFixture(t)
	h.formattingConfig.Enabled = false
	h.formattingConfig.LocalEnabled = true
	in := formattingSessionInput{RequestID: "wechat-concurrent-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "正文", BodyFormat: "markdown"}}
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", in, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "wechat-concurrent-job", Platform: "wechat"}, true), 202)
	runFormattingClaim(t, h)
	results := make(chan int, 2)
	for _, input := range []wechatEditInput{{Revision: 1, RequestID: "edit-one", Markdown: "第一份"}, {Revision: 1, RequestID: "edit-two", Markdown: "第二份"}} {
		go func(in wechatEditInput) {
			results <- call("PUT", "/api/formatting-jobs/"+job.ID+"/wechat", in, true).Code
		}(input)
	}
	a, b := <-results, <-results
	if !(a == 202 && b == 409 || a == 409 && b == 202) {
		t.Fatal("并发修改未隔离", a, b)
	}
	runFormattingClaim(t, h)
	confirmations := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() {
			confirmations <- call("POST", "/api/formatting-jobs/"+job.ID+"/confirm", map[string]int64{"revision": 2}, true)
		}()
	}
	first := decodeFormatting[FormattingJob](t, <-confirmations, 200)
	second := decodeFormatting[FormattingJob](t, <-confirmations, 200)
	if !first.Confirmed || !second.Confirmed || first.ConfirmationFingerprint != second.ConfirmationFingerprint {
		t.Fatal("并发确认没有复用同一修订")
	}
}
