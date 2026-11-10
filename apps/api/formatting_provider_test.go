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

func TestDeepSeekResponseBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		content string
		finish  string
		want    string
	}{
		{"空白JSON", 200, "   ", "stop", "provider_invalid_json"},
		{"被截断", 200, "{}", "length", "provider_incomplete"},
		{"多余字段", 200, `{"title":"文章标题","unexpected":"不允许"}`, "stop", "provider_invalid_json"},
		{"错误密钥", 401, "", "", "provider_credentials"},
		{"限流", 429, "", "", "provider_rate_limited"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				if tc.status == 200 {
					_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": tc.finish, "message": map[string]string{"content": tc.content}}}})
				}
			}))
			defer server.Close()
			c := defaultFormattingConfig()
			c.BaseURL = server.URL
			c.APIKey = "synthetic-only"
			_, _, err := c.generate(context.Background(), "csdn", FormattingSnapshot{Title: "合成测试文章"}, nil)
			if formattingErrorCode(err) != tc.want {
				t.Fatalf("got %v, want %s", err, tc.want)
			}
		})
	}
}
func TestDeepSeekConfigurationIsolation(t *testing.T) {
	t.Setenv("AI_FORMATTING_ENABLED", "false")
	t.Setenv("DEEPSEEK_API", "existing-user-secret")
	c, err := loadFormattingConfig()
	if err != nil || c.Enabled || c.APIKey != "" {
		t.Fatal("disabled feature consumed credential")
	}
	c = defaultFormattingConfig()
	c.APIKey = "private"
	c.FormatterURL = "http://127.0.0.1:19001"
	if c.validate() != nil {
		t.Fatal("valid configuration rejected")
	}
	for _, url := range []string{"http://example.test:80", "http://127.0.0.1:80/forward", "http://u:p@127.0.0.1:80", "http://127.0.0.1:0"} {
		c.FormatterURL = url
		if c.validate() == nil {
			t.Fatal("unsafe renderer URL accepted")
		}
	}
}
func TestDeepSeekRealCSDN(t *testing.T) {
	key := os.Getenv("TEST_DEEPSEEK_REAL_KEY")
	if key == "" {
		t.Skip("真实 DeepSeek 验证仅按显式私有配置启用")
	}
	h, _, call := formattingFixture(t)
	h.formattingConfig.APIKey = key
	h.formattingConfig.BaseURL = "https://api.deepseek.com"
	h.formattingConfig.Timeout = 180 * time.Second
	s := formattingLocalSession(t, call)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "real-synthetic-csdn", Platform: "csdn"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil {
		t.Fatalf("真实模型合成验证未通过，状态=%s，错误=%s", job.Status, job.ErrorCode)
	}
	if !strings.Contains(job.Result.Markdown, "fmt.Println(\"{}\")") {
		t.Fatal("代码完整性验证失败")
	}
	t.Logf("合成 CSDN 稿生成通过；输入 token=%d，输出 token=%d", job.InputTokens, job.OutputTokens)
}
