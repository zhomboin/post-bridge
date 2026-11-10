package bridge

import (
	"os"
	"testing"
)

func TestDeepSeekRealXiaohongshu(t *testing.T) {
	key := os.Getenv("TEST_DEEPSEEK_REAL_KEY")
	if key == "" {
		t.Skip("真实 DeepSeek 验证仅按显式私有配置启用")
	}
	h, _, call := formattingFixture(t)
	h.formattingConfig.APIKey = key
	h.formattingConfig.BaseURL = "https://api.deepseek.com"
	s := xiaohongshuSession(t, call)
	job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+s.ID+"/jobs", formattingJobInput{RequestID: "real-synthetic-xiaohongshu", Platform: "xiaohongshu", Template: "technical"}, true), 202)
	runFormattingClaim(t, h)
	job = decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+job.ID, nil, true), 200)
	if job.Status != "succeeded" || job.Result == nil {
		t.Fatalf("真实小红书合成验证未通过，状态=%s，错误=%s", job.Status, job.ErrorCode)
	}
	if len(job.Result.Assets) < 2 {
		t.Fatal("图文素材不完整")
	}
	t.Logf("合成小红书正文与%d张卡片生成通过；输入token=%d，输出token=%d", len(job.Result.Assets), job.InputTokens, job.OutputTokens)
}
