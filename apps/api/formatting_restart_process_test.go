package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestFormattingWechatRecoveryAcrossProcesses(t *testing.T) {
	formatterURL := os.Getenv("TEST_FORMATTER_URL")
	if os.Getenv("TEST_DATABASE_URL") == "" || formatterURL == "" {
		t.Skip("需要隔离 PostgreSQL 和 formatter")
	}
	target, err := url.Parse(formatterURL)
	if err != nil {
		t.Fatal("隔离 formatter 地址无效")
	}

	executable := filepath.Join(t.TempDir(), "post-bridge-api")
	buildCtx, cancelBuild := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancelBuild()
	build := exec.CommandContext(buildCtx, "go", "build", "-o", executable, "./cmd/server")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建 API 入口失败: %v %s", err, output)
	}

	for _, path := range []string{"/convert-wechat", "/validate-wechat"} {
		t.Run(path[1:], func(t *testing.T) {
			testFormattingAPICrash(t, executable, target, path)
		})
	}
}

func testFormattingAPICrash(t *testing.T, executable string, target *url.URL, blockedPath string) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()

	const firstBody = "将中断的合成正文。"
	const secondBody = "等待排版的合成正文。"
	token := os.Getenv("TEST_FORMATTER_TOKEN")
	started, disconnected := make(chan struct{}), make(chan struct{})
	var interruptedCalls atomic.Int32
	proxy := httputil.NewSingleHostReverseProxy(target)
	formatter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("缺少测试排版服务凭据")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(r.Body)
		var input struct {
			Markdown string `json:"markdown"`
		}
		if err != nil || json.Unmarshal(body, &input) != nil {
			t.Error("排版请求格式无效")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Path == blockedPath && input.Markdown == firstBody {
			if interruptedCalls.Add(1) != 1 {
				t.Error("中断任务被自动重发")
				w.WriteHeader(http.StatusConflict)
				return
			}
			close(started)
			select {
			case <-r.Context().Done():
				close(disconnected)
			case <-ctx.Done():
			}
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(formatter.Close)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err = listener.Close(); err != nil {
		t.Fatal(err)
	}
	origin := "http://" + address
	dir := t.TempDir()
	password := randomToken()
	writeSecret := func(name, value string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	env := []string{
		"DATABASE_URL=" + isolatedRuntimeDatabaseURL(t, pool.Config()),
		"API_ADDR=" + address,
		"ADMIN_USERNAME=restart-fixture",
		"ADMIN_PASSWORD_FILE=" + writeSecret("admin", password),
		"WORKER_TOKEN_FILE=" + writeSecret("worker", randomToken()),
		"CSDN_USERNAME=restart-fixture",
		"CSDN_DISPLAY_NAME=重启验证账号",
		"CONTENT_FORMATTING_ENABLED=true",
		"FORMATTER_URL=" + formatter.URL,
		"FORMATTER_TOKEN_FILE=" + writeSecret("formatter", token),
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar, Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	firstAPI := startFormattingTestAPI(t, ctx, executable, env, client, origin)

	var csrf string
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, method, origin+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", csrf)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(method, path, err)
		}
		defer resp.Body.Close()
		result := httptest.NewRecorder()
		result.Code = resp.StatusCode
		if _, err := io.Copy(result.Body, resp.Body); err != nil {
			t.Fatal(err)
		}
		return result
	}
	login := decodeFormatting[struct {
		CSRF string `json:"csrf_token"`
	}](t, call("POST", "/api/login", map[string]string{"username": "restart-fixture", "password": password}), 200)
	csrf = login.CSRF

	queueJob := func(key, markdown string) (string, FormattingJob) {
		t.Helper()
		session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{
			RequestID: key + "-session",
			Platforms: []string{"wechat"},
			Snapshot:  FormattingSnapshot{Title: "合成文章", Body: markdown, BodyFormat: "markdown"},
		}), 201)
		path := "/api/formatting-sessions/" + session.ID + "/jobs"
		return path, decodeFormatting[FormattingJob](t, call("POST", path, formattingJobInput{RequestID: key, Platform: "wechat"}), 202)
	}
	readJob := func(id string) FormattingJob {
		t.Helper()
		return decodeFormatting[FormattingJob](t, call("GET", "/api/formatting-jobs/"+id, nil), 200)
	}
	firstPath, first := queueJob("crash-first", firstBody)
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("排版服务未收到需阻塞的请求")
	}
	_, second := queueJob("crash-second", secondBody)
	if a, b := readJob(first.ID), readJob(second.ID); a.Status != "running" || a.Result != nil || b.Status != "queued" {
		t.Fatal("退出前任务状态异常", a.Status, b.Status)
	}

	if err := firstAPI.Process.Kill(); err != nil {
		t.Fatal("无法强制终止本用例启动的 API", err)
	}
	if err := firstAPI.Wait(); err == nil || firstAPI.ProcessState == nil || firstAPI.ProcessState.Success() {
		t.Fatal("API 未以异常状态退出", err)
	}
	select {
	case <-disconnected:
	case <-ctx.Done():
		t.Fatal("API 退出后排版请求未断开")
	}
	startFormattingTestAPI(t, ctx, executable, env, client, origin)
	if a, b := readJob(first.ID), readJob(second.ID); a.Status != "running" || a.Result != nil || b.Status != "queued" {
		t.Fatal("重启后有效租约或排队状态未保留", a.Status, b.Status)
	}
	// 只推进此任务的租约截止时间，恢复仍由正式调度器执行。
	tag, err := pool.Exec(ctx, "UPDATE formatting_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1 AND record->>'status'='running' AND lease_expires_at>now()", first.ID)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatal("未能模拟执行租约到期", err)
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		first, second = readJob(first.ID), readJob(second.ID)
		if first.Status == "failed" && second.Status != "queued" && second.Status != "running" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("重启后未恢复任务", first.Status, second.Status)
		case <-ticker.C:
		}
	}
	if first.Stage != "finished" || first.ErrorCode != "processing_interrupted" || first.Result != nil || first.Confirmed {
		t.Fatal("中断任务状态异常", first.Status, first.Stage, first.ErrorCode)
	}
	if second.Status != "succeeded" || second.Result == nil || second.Result.Wechat == nil ||
		second.Result.Wechat.CandidateMarkdown == nil || *second.Result.Wechat.CandidateMarkdown != secondBody {
		t.Fatal("重启后排队任务未完成", second.Status, second.ErrorCode)
	}
	replayed := decodeFormatting[FormattingJob](t, call("POST", firstPath, formattingJobInput{RequestID: "crash-first", Platform: "wechat"}), 200)
	if replayed.ID != first.ID || replayed.Status != "failed" || interruptedCalls.Load() != 1 {
		t.Fatal("重放生成请求改变了中断结果", replayed.Status)
	}
	var lease string
	var firstRevisions, secondRevisions int
	if err := pool.QueryRow(ctx, `SELECT lease_token,
		(SELECT count(*) FROM formatting_revisions WHERE job_id=$1),
		(SELECT count(*) FROM formatting_revisions WHERE job_id=$2)
		FROM formatting_jobs WHERE id=$1`, first.ID, second.ID).Scan(&lease, &firstRevisions, &secondRevisions); err != nil {
		t.Fatal(err)
	}
	if lease != "" || firstRevisions != 0 || secondRevisions != 1 {
		t.Fatal("恢复后的租约或修订未正确持久化", firstRevisions, secondRevisions)
	}
}

func startFormattingTestAPI(t *testing.T, ctx context.Context, executable string, env []string, client *http.Client, origin string) *exec.Cmd {
	t.Helper()
	// 仅传入本用例的配置，避免读取本地平台、模型或私有服务配置。
	cmd := exec.CommandContext(ctx, executable)
	cmd.Env = env
	log, err := os.CreateTemp(t.TempDir(), "api-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = log.Close() })
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, err := http.NewRequestWithContext(ctx, "GET", origin+"/healthz", nil)
		if err != nil {
			t.Fatal(err)
		}
		if response, err := client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return cmd
			}
		}
		select {
		case <-ctx.Done():
			output, _ := os.ReadFile(log.Name())
			t.Fatalf("API 未就绪: %s", output)
		case <-ticker.C:
		}
	}
}
