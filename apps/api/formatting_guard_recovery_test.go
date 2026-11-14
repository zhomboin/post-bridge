package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func formattingStoredJob(t *testing.T, h *handler, id string) FormattingJob {
	t.Helper()
	var raw []byte
	if err := h.store.pool.QueryRow(context.Background(), "SELECT record FROM formatting_jobs WHERE id=$1", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var job FormattingJob
	if err := json.Unmarshal(raw, &job); err != nil {
		t.Fatal(err)
	}
	return job
}

func TestFormattingSourceRevokedOrAccountDisabledDuringModel(t *testing.T) {
	for _, change := range []string{"source", "account", "user"} {
		t.Run(change, func(t *testing.T) {
			h, client, call := formattingFixture(t)
			client = enableSourceFormatting(t, h, client)
			snapshot := IntegrationSnapshot{Title: "合成来源文章", Body: "# 标题\n\n完整正文。", BodyFormat: "markdown", Tags: []string{}}
			fingerprint, err := IntegrationContentFingerprint(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			input := IntegrationPrepareInput{RequestID: "guard-prepare", SourceID: client.SourceID, ArticleID: "guard-article", SourceVersion: 1, StateSeq: 1, AuthorizationID: "guard-auth", AuthorizationExpiresAt: h.store.now().Add(time.Hour), ContentFingerprint: fingerprint, Snapshot: snapshot, Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}}, Formatting: &FormattingAuthorization{AllowAIProcessing: true, Platforms: []string{"csdn"}}}
			preparation := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integrations/v1/preparations", input, false), 201)
			session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "guard-session", PreparationID: preparation.ID, BaseRevision: preparation.Revision, Platforms: []string{"csdn"}, AllowAIProcessing: true}, true), 201)
			job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "guard-job", Platform: "csdn"}, true), 202)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var err error
				switch change {
				case "source":
					_, err = h.applyIntegrationEvent(context.Background(), client, IntegrationSourceEvent{EventID: "guard-revoke", SourceID: client.SourceID, ArticleID: "guard-article", StateSeq: 2, SourceVersion: 1, Type: "authorization_revoked", Status: "published", AuthorizationID: "guard-auth", AuthorizationValid: false, ContentFingerprint: fingerprint})
				case "account":
					_, err = h.store.pool.Exec(context.Background(), "UPDATE account SET enabled=false WHERE id=$1", "csdn-main")
				case "user":
					_, err = h.store.pool.Exec(context.Background(), "UPDATE users SET enabled=false WHERE username=$1", "admin")
				}
				if err != nil {
					t.Error(err)
					w.WriteHeader(500)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": `{"title":"合成文章"}`}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 5}})
			}))
			t.Cleanup(provider.Close)
			h.formattingConfig.BaseURL = provider.URL
			runFormattingClaim(t, h)
			stored := formattingStoredJob(t, h, job.ID)
			if stored.Status != "failed" || stored.ErrorCode != "source_unavailable" || stored.Result != nil {
				t.Fatal("授权或账号失效后不能保存候选结果", change, stored.Status, stored.ErrorCode)
			}
			if response := call("POST", "/api/formatting-jobs/"+job.ID+"/adopt", map[string]int64{"revision": 1}, true); response.Code == 200 {
				t.Fatal("授权或账号失效后不能采用结果", change)
			}
		})
	}
}

func TestFormattingWechatRestartRecovery(t *testing.T) {
	h, _, call := formattingFixture(t)
	h.formattingConfig.LocalEnabled = true
	session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "restart-session", Platforms: []string{"wechat"}, Snapshot: FormattingSnapshot{Title: "合成文章", Body: "合成正文。", BodyFormat: "markdown"}}, true), 201)
	first := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "restart-first", Platform: "wechat"}, true), 202)
	stale, err := h.claimFormatting(context.Background())
	if err != nil || stale.Job.ID != first.ID {
		t.Fatal("未领取第一个任务", err)
	}
	second := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "restart-second", Platform: "wechat"}, true), 202)
	if _, err = h.store.pool.Exec(context.Background(), "UPDATE formatting_jobs SET lease_expires_at=$2 WHERE id=$1", first.ID, h.store.now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	// 新调度实例只依赖持久状态，不继承前一个实例的执行上下文。
	restarted := &handler{store: h.store, formattingConfig: h.formattingConfig, integrations: h.integrations}
	restarted.maintainFormatting(context.Background())
	interrupted := formattingStoredJob(t, h, first.ID)
	if interrupted.Status != "failed" || interrupted.ErrorCode != "processing_interrupted" || interrupted.Result != nil {
		t.Fatal("重启后未将失租任务标记中断", interrupted.Status, interrupted.ErrorCode)
	}
	// 旧执行器即使迟到，也不能覆盖恢复后的状态。
	h.runFormatting(context.Background(), stale)
	interrupted = formattingStoredJob(t, h, first.ID)
	if interrupted.Status != "failed" || interrupted.ErrorCode != "processing_interrupted" || interrupted.Result != nil {
		t.Fatal("旧执行器覆盖了恢复状态", interrupted.Status, interrupted.ErrorCode)
	}
	next, err := restarted.claimFormatting(context.Background())
	if err != nil || next.Job.ID != second.ID {
		t.Fatal("待处理任务未由新实例恢复", err)
	}
	restarted.runFormatting(context.Background(), next)
	completed := formattingStoredJob(t, h, second.ID)
	if completed.Status != "succeeded" || completed.Result == nil || completed.Result.Wechat == nil {
		t.Fatal("新实例未完成待处理任务", completed.Status, completed.ErrorCode)
	}
	if _, err = restarted.claimFormatting(context.Background()); err == nil {
		t.Fatal("中断任务被自动重试")
	}
}

func TestFormattingResultUnavailableAfterRevocation(t *testing.T) {
	for _, change := range []string{"source", "account"} {
		t.Run(change, func(t *testing.T) {
			h, client, call := formattingFixture(t)
			client = enableSourceFormatting(t, h, client)
			snapshot := IntegrationSnapshot{Title: "合成来源文章", Body: "# 技术说明\n\n这是完整正文。", BodyFormat: "markdown", Tags: []string{}}
			fingerprint, err := IntegrationContentFingerprint(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			input := IntegrationPrepareInput{RequestID: "after-prepare", SourceID: client.SourceID, ArticleID: "after-article", SourceVersion: 1, StateSeq: 1, AuthorizationID: "after-auth", AuthorizationExpiresAt: h.store.now().Add(time.Hour), ContentFingerprint: fingerprint, Snapshot: snapshot, Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}}, Formatting: &FormattingAuthorization{AllowAIProcessing: true, Platforms: []string{"csdn"}}}
			preparation := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integrations/v1/preparations", input, false), 201)
			session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "after-session", PreparationID: preparation.ID, BaseRevision: preparation.Revision, Platforms: []string{"csdn"}, AllowAIProcessing: true}, true), 201)
			job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "after-job", Platform: "csdn"}, true), 202)
			runFormattingClaim(t, h)
			if result := formattingStoredJob(t, h, job.ID); result.Status != "succeeded" || result.Result == nil {
				t.Fatal("候选稿未成功生成", result.Status, result.ErrorCode)
			}
			visible := decodeFormatting[struct {
				Items []FormattingJob `json:"items"`
			}](t, call("GET", "/api/formatting-jobs", nil, true), 200)
			if len(visible.Items) != 1 || visible.Items[0].ID != job.ID || visible.Items[0].Title != snapshot.Title {
				t.Fatal("有效来源的任务标题不可见")
			}
			if change == "source" {
				_, err = h.applyIntegrationEvent(context.Background(), client, IntegrationSourceEvent{EventID: "after-revoke", SourceID: client.SourceID, ArticleID: "after-article", StateSeq: 2, SourceVersion: 1, Type: "authorization_revoked", Status: "published", AuthorizationID: "after-auth", AuthorizationValid: false, ContentFingerprint: fingerprint})
			} else {
				_, err = h.store.pool.Exec(context.Background(), "UPDATE account SET enabled=false WHERE id=$1", "csdn-main")
			}
			if err != nil {
				t.Fatal(err)
			}
			want := http.StatusGone
			if change == "account" {
				want = http.StatusForbidden
			}
			if response := call("GET", "/api/formatting-jobs/"+job.ID, nil, true); response.Code != want {
				t.Fatal("失效后的候选稿没有返回预期拒绝", change, response.Code)
			}
			if response := call("POST", "/api/formatting-jobs/"+job.ID+"/adopt", map[string]int64{"revision": 1}, true); response.Code != want {
				t.Fatal("失效后的候选稿没有拒绝采用", change, response.Code)
			}
			list := decodeFormatting[struct {
				Items []FormattingJob `json:"items"`
			}](t, call("GET", "/api/formatting-jobs", nil, true), 200)
			for _, item := range list.Items {
				if item.ID == job.ID && (item.Title != "来源不可用" || item.Result != nil) {
					t.Fatal("列表泄露已失效来源标题或候选稿", change)
				}
			}
		})
	}
}

func TestFormattingGuardStopsModelBeforeStart(t *testing.T) {
	for _, change := range []string{"source", "account", "user"} {
		t.Run(change, func(t *testing.T) {
			h, client, call := formattingFixture(t)
			client = enableSourceFormatting(t, h, client)
			snapshot := IntegrationSnapshot{Title: "合成来源文章", Body: "# 技术说明\n\n这是完整正文。", BodyFormat: "markdown", Tags: []string{}}
			fingerprint, err := IntegrationContentFingerprint(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			input := IntegrationPrepareInput{RequestID: "before-prepare", SourceID: client.SourceID, ArticleID: "before-article", SourceVersion: 1, StateSeq: 1, AuthorizationID: "before-auth", AuthorizationExpiresAt: h.store.now().Add(time.Hour), ContentFingerprint: fingerprint, Snapshot: snapshot, Targets: []IntegrationTarget{{Platform: "csdn", AccountID: "csdn-main", Operation: "save_draft"}}, Formatting: &FormattingAuthorization{AllowAIProcessing: true, Platforms: []string{"csdn"}}}
			preparation := decodeFormatting[IntegrationPreparation](t, call("POST", "/api/integrations/v1/preparations", input, false), 201)
			session := decodeFormatting[FormattingSession](t, call("POST", "/api/formatting-sessions", formattingSessionInput{RequestID: "before-session", PreparationID: preparation.ID, BaseRevision: preparation.Revision, Platforms: []string{"csdn"}, AllowAIProcessing: true}, true), 201)
			job := decodeFormatting[FormattingJob](t, call("POST", "/api/formatting-sessions/"+session.ID+"/jobs", formattingJobInput{RequestID: "before-job", Platform: "csdn"}, true), 202)
			var requests atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			t.Cleanup(provider.Close)
			h.formattingConfig.BaseURL = provider.URL
			switch change {
			case "source":
				_, err = h.applyIntegrationEvent(context.Background(), client, IntegrationSourceEvent{EventID: "before-revoke", SourceID: client.SourceID, ArticleID: "before-article", StateSeq: 2, SourceVersion: 1, Type: "authorization_revoked", Status: "published", AuthorizationID: "before-auth", AuthorizationValid: false, ContentFingerprint: fingerprint})
			case "account":
				_, err = h.store.pool.Exec(context.Background(), "UPDATE account SET enabled=false WHERE id=$1", "csdn-main")
			case "user":
				_, err = h.store.pool.Exec(context.Background(), "UPDATE users SET enabled=false WHERE username=$1", "admin")
			}
			if err != nil {
				t.Fatal(err)
			}
			runFormattingClaim(t, h)
			stored := formattingStoredJob(t, h, job.ID)
			if stored.Status != "failed" || stored.ErrorCode != "source_unavailable" || stored.Result != nil || requests.Load() != 0 {
				t.Fatal("失效来源不应调用模型或生成结果", change, stored.Status, stored.ErrorCode, requests.Load())
			}
		})
	}
}
