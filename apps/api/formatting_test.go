package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type formattingTestCall = func(string, string, any, bool) *httptest.ResponseRecorder

func formattingFixture(t *testing.T) (*handler, IntegrationClient, formattingTestCall) {
	t.Helper()
	if os.Getenv("TEST_FORMATTER_URL") == "" {
		t.Skip("需要隔离 formatter")
	}
	h, c, call := integrationHTTPFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-deepseek-secret" {
			t.Error("missing provider credential")
		}
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
			ResponseFormat map[string]string `json:"response_format"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.ResponseFormat["type"] != "json_object" {
			t.Error("missing JSON mode")
			w.WriteHeader(400)
			return
		}
		var input struct {
			Title  string            `json:"title"`
			Blocks []FormattingBlock `json:"blocks"`
		}
		if json.Unmarshal([]byte(request.Messages[len(request.Messages)-1].Content), &input) != nil {
			t.Error("bad model input")
			w.WriteHeader(400)
			return
		}
		edits := []FormattingEdit{}
		for _, block := range input.Blocks {
			if block.Kind == "heading" && !block.Protected {
				edits = append(edits, FormattingEdit{ID: block.ID, Markdown: "#" + block.Markdown})
				break
			}
		}
		result := FormattingModelResult{Title: input.Title, Summary: "文章中的技术说明", Tags: []string{"技术"}, Edits: edits, Issues: []FormattingIssue{}}
		if strings.Contains(request.Messages[0].Content, "小红书知识图文") {
			ids := []string{}
			for _, b := range input.Blocks {
				if b.Kind == "paragraph" {
					ids = append(ids, b.ID)
				}
			}
			result = FormattingModelResult{Title: "技术笔记格式化", Body: "这是完整正文。", Topics: []string{"技术笔记"}, CoverTitle: "技术笔记", CoverSubtitle: "合成内容验证", Cards: []FormattingCard{{Title: "技术要点", Paragraphs: []string{"这是完整正文。"}, CodeRefs: []string{}, SourceBlockIds: ids}}, Omissions: []string{}, Issues: []FormattingIssue{}}
		}
		content, _ := json.Marshal(result)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 50}})
	}))
	t.Cleanup(provider.Close)
	config := defaultFormattingConfig()
	config.Enabled = true
	config.APIKey = "synthetic-deepseek-secret"
	config.BaseURL = provider.URL
	config.FormatterURL = os.Getenv("TEST_FORMATTER_URL")
	config.FormatterToken = os.Getenv("TEST_FORMATTER_TOKEN")
	h.formattingConfig = config
	return h, c, call
}
func decodeFormatting[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP status %d, want %d: %s", w.Code, status, w.Body.String())
	}
	var value T
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func formattingLocalSession(t *testing.T, call func(string, string, any, bool) *httptest.ResponseRecorder) FormattingSession {
	t.Helper()
	return decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{
		RequestID: "local-session", AccountID: "csdn-main", Platforms: []string{"csdn"}, AllowAIProcessing: true,
		Snapshot: FormattingSnapshot{Title: "代码保护验证文章", Body: "# 技术说明\n\n这是完整正文。\n\n~~~go\nimport \"fmt\"\n\nfmt.Println(\"{}\")\n~~~", BodyFormat: "markdown", Tags: []string{}},
	}, true), 201)
}
func runFormattingClaim(t *testing.T, h *handler) {
	t.Helper()
	c, err := h.claimFormatting(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	h.runFormatting(context.Background(), c)
}
func enableSourceFormatting(t *testing.T, h *handler, c IntegrationClient) IntegrationClient {
	t.Helper()
	c.AIProcessingAllowed = true
	c.FormattingPlatforms = []string{"csdn"}
	tx, err := h.store.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err = integrationSaveClient(context.Background(), tx, c); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return c
}
func TestFormattingCSDNLocalLifecycle(t *testing.T) {
	h, _, call := formattingFixture(t)
	s := formattingLocalSession(t, call)
	input := formattingJobInput{RequestID: "local-generate", Platform: "csdn"}
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", input, true), 202)
	repeated := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", input, true), 200)
	if job.ID != repeated.ID {
		t.Fatal("duplicate request created work")
	}
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil || !strings.Contains(job.Result.Markdown, "## 技术说明") || !strings.Contains(job.Result.Markdown, "fmt.Println(\"{}\")") {
		t.Fatalf("formatting failed: %+v", job)
	}
	if job.InputTokens != 100 || job.OutputTokens != 50 {
		t.Fatal("missing usage")
	}
	list := decodeFormatting[struct {
		Items []FormattingJob `json:"items"`
	}](t, call("GET", "/api/formatting-jobs", nil, true), 200)
	if len(list.Items) != 1 || list.Items[0].Result != nil {
		t.Fatal("list exposed body")
	}
	saved := decodeFormatting[Job](t, call("POST", "/api/formatting-jobs/"+job.ID+"/csdn-draft", map[string]int64{"revision": job.Revision}, true), 202)
	if saved.Markdown != job.Result.Markdown || saved.Kind != "save_draft" {
		t.Fatal("worker payload differs from confirmed output")
	}
	again := decodeFormatting[Job](t, call("POST", "/api/formatting-jobs/"+job.ID+"/csdn-draft", map[string]int64{"revision": job.Revision}, true), 200)
	if again.ID != saved.ID {
		t.Fatal("repeat draft duplicated side effect")
	}
}
func TestFormattingSourceAdoptionAndAuthorization(t *testing.T) {
	h, c, call := formattingFixture(t)
	snapshot := IntegrationSnapshot{Title: "来源平台格式化文章", Body: "# 技术说明\n\n完整正文。", BodyFormat: "markdown", Tags: []string{}}
	fp, _ := IntegrationContentFingerprint(snapshot)
	prepare := IntegrationPrepareInput{RequestID: "source-prepare", SourceID: c.SourceID, ArticleID: "source-article", SourceVersion: 1, StateSeq: 1, AuthorizationID: "source-auth", AuthorizationExpiresAt: h.store.now().Add(time.Hour), ContentFingerprint: fp, Snapshot: snapshot, Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}}, Formatting: &FormattingAuthorization{AllowAIProcessing: true, Platforms: []string{"csdn"}}}
	if w := call("POST", "/api/integrations/v1/preparations", prepare, false); w.Code != 403 {
		t.Fatal("source app implicitly opted in", w.Code)
	}
	enableSourceFormatting(t, h, c)
	p := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integrations/v1/preparations", prepare, false), 201)
	s := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "source-session", PreparationID: p.ID, BaseRevision: p.Revision, Platforms: []string{"csdn"}, AllowAIProcessing: true}, true), 201)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "source-job", Platform: "csdn"}, true), 202)
	runFormattingClaim(t, h)
	adopted := decodeFormatting[struct {
		Job         FormattingJob          `json:"job"`
		Preparation IntegrationPreparation `json:"preparation"`
	}](t, call("POST", "/api/formatting-jobs/"+job.ID+"/adopt", map[string]int64{"revision": 1}, true), 200)
	if adopted.Preparation.Revision != p.Revision+1 || adopted.Preparation.Confirmed || adopted.Preparation.ContentFingerprint != fp || adopted.Preparation.Snapshot.Body != snapshot.Body {
		t.Fatal("source or confirmation was replaced")
	}
	if adopted.Preparation.Drafts[0].PublishOptions.CreationDeclaration != "ai_assisted" {
		t.Fatal("AI provenance missing")
	}
	if w := call("POST", "/api/formatting-jobs/"+job.ID+"/csdn-draft", map[string]int64{"revision": 1}, true); w.Code != 403 {
		t.Fatal("source bypassed distribution", w.Code)
	}
	confirmed := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integration-preparations/"+p.ID+"/confirm", map[string]int64{"revision": adopted.Preparation.Revision}, true), 200)
	if !confirmed.Confirmed || confirmed.ConfirmationFingerprint == "" {
		t.Fatal("existing confirmation failed")
	}
}
func TestFormattingCancellationAndStaleRevision(t *testing.T) {
	h, _, call := formattingFixture(t)
	s := formattingLocalSession(t, call)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "cancel-job", Platform: "csdn"}, true), 202)
	decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-jobs/"+job.ID+"/cancel", nil, true), 200)
	if _, err := h.claimFormatting(context.Background()); err == nil {
		t.Fatal("cancelled work claimed")
	}
	job = decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "new-job", Platform: "csdn"}, true), 202)
	runFormattingClaim(t, h)
	if w := call("POST", "/api/formatting-jobs/"+job.ID+"/adopt", map[string]int64{"revision": 2}, true); w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	if w := call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "new-job", Platform: "xiaohongshu"}, true); w.Code != 400 {
		t.Fatal("unsupported platform accepted", w.Code)
	}
	if w := call("POST", "/api/formatting-jobs/"+job.ID+"/cancel", nil, false); w.Code != 401 {
		t.Fatal("signed caller reached admin formatting", w.Code)
	}
}
