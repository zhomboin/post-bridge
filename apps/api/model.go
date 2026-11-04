package bridge

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrConflict = errors.New("conflict")
var ErrInvalid = errors.New("invalid")
var ErrNotFound = errors.New("not_found")

type CreateInput struct {
	ArticleID string `json:"article_id,omitempty"`
	RequestID string `json:"request_id"`
	Kind      string `json:"kind"`
	Platform  string `json:"platform"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown"`
}
type Job struct {
	ArticleID            string     `json:"article_id,omitempty"`
	AccountUsername      string     `json:"account_username,omitempty"`
	ID                   string     `json:"id"`
	RequestID            string     `json:"request_id"`
	Platform             string     `json:"platform"`
	AccountID            string     `json:"account_id"`
	Kind                 string     `json:"kind"`
	Title                string     `json:"title"`
	Markdown             string     `json:"markdown,omitempty"`
	Status               string     `json:"status"`
	Outcome              string     `json:"outcome"`
	Stage                string     `json:"stage"`
	Attempts             int        `json:"attempts"`
	ReconcileCount       int        `json:"reconcile_count"`
	AutoReconcileStarted bool       `json:"auto_reconcile_started"`
	AbsenceChecks        int        `json:"absence_checks"`
	LastAbsenceAt        time.Time  `json:"last_absence_at"`
	RetryCount           int        `json:"retry_count"`
	MaxRetries           int        `json:"max_retries"`
	RunMode              string     `json:"run_mode"`
	ExternalStarted      bool       `json:"external_started"`
	RemoteID             string     `json:"remote_id"`
	ReconcileCandidateID string     `json:"reconcile_candidate_id"`
	ManualResolved       bool       `json:"manual_resolved"`
	RemoteURL            string     `json:"remote_url"`
	CancelRequested      bool       `json:"cancel_requested"`
	ErrorCode            string     `json:"error_code"`
	ErrorMessage         string     `json:"error_message"`
	RetryAllowed         bool       `json:"retry_allowed"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
	StartedAt            *time.Time `json:"started_at"`
	FinishedAt           *time.Time `json:"finished_at"`
	AvailableAt          time.Time  `json:"available_at"`
}
type record struct {
	Job
	Ready          bool
	LeaseToken     string
	LeaseExpiresAt time.Time
	WorkerID       string
}
type Observation struct {
	Phase    string `json:"phase"`
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
	Status   string `json:"status"`
	RemoteID string `json:"remote_id,omitempty"`
}

type ProgressInput struct {
	Observation     *Observation `json:"observation,omitempty"`
	LeaseToken      string       `json:"lease_token"`
	Stage           string       `json:"stage"`
	RemoteID        string       `json:"remote_id"`
	ExternalStarted bool         `json:"external_started"`
	Message         string       `json:"message"`
}
type CompleteInput struct {
	Articles     *ArticleSnapshot `json:"articles,omitempty"`
	Article      *ArticleBody     `json:"article,omitempty"`
	LeaseToken   string           `json:"lease_token"`
	Status       string           `json:"status"`
	RemoteID     string           `json:"remote_id"`
	ErrorCode    string           `json:"error_code"`
	ErrorMessage string           `json:"error_message"`
	Retryable    bool             `json:"retryable"`
}
type ActionInput struct {
	RemoteID                string `json:"remote_id"`
	ConfirmedBrowserStopped bool   `json:"confirmed_browser_stopped"`
	Note                    string `json:"note"`
}
type workerProof struct {
	SeenAt           time.Time
	BrowserIdle      bool
	ProfileAvailable bool
}

func ValidateCreate(in CreateInput) error {
	if in.ArticleID != "" || !validKey(in.RequestID) || in.Kind != "save_draft" || in.Platform != "csdn" || utf8.RuneCountInString(strings.TrimSpace(in.Title)) < 5 || utf8.RuneCountInString(in.Title) > 100 || strings.TrimSpace(in.Markdown) == "" || utf8.RuneCountInString(in.Markdown) > 200000 || !utf8.ValidString(in.Markdown) {
		return ErrInvalid
	}
	fence := byte(0)
	length := 0
	markdown := strings.ReplaceAll(strings.ReplaceAll(in.Markdown, "\r\n", "\n"), "\r", "\n")
	for _, line := range strings.Split(markdown, "\n") {
		// 围栏至多缩进三个字面空格，不能把缩进代码或其他空白当成围栏。
		spaces := 0
		for spaces < len(line) && line[spaces] == ' ' {
			spaces++
		}
		s := line[spaces:]
		if spaces <= 3 && len(s) >= 3 && (s[0] == '`' || s[0] == '~') {
			ch := s[0]
			n := 0
			for n < len(s) && s[n] == ch {
				n++
			}
			if n >= 3 {
				rest := s[n:]
				if fence == 0 {
					// 反引号围栏的语言说明不能再包含反引号。
					if ch != '`' || !strings.ContainsRune(rest, '`') {
						fence = ch
						length = n
						continue
					}
				} else if ch == fence && n >= length && strings.Trim(rest, " \t") == "" {
					fence = 0
					continue
				}
			}
		}
		if fence != 0 {
			continue
		}
		if unsupportedContent.MatchString(line) {
			return ErrInvalid
		}
	}
	return nil
}

var unsupportedContent = regexp.MustCompile(`!\[|<\s*/?\s*[A-Za-z]|\{|\}|^\s*(import|export)\s`)
var numericID = regexp.MustCompile(`^[0-9]{1,32}$`)
var requestKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validKey(s string) bool { return requestKey.MatchString(s) }
func randomToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("安全随机源不可用")
	}
	return hex.EncodeToString(b[:])
}
func newRecord(in CreateInput, now time.Time) *record {
	return &record{Job: Job{ID: randomToken(), RequestID: in.RequestID, Platform: "csdn", AccountID: "csdn-main", Kind: in.Kind, ArticleID: in.ArticleID, Title: in.Title, Markdown: in.Markdown, Status: "queued", Outcome: "not_submitted", Stage: "queued", MaxRetries: 3, RunMode: "execute", CreatedAt: now, UpdatedAt: now, AvailableAt: now}, Ready: true}
}
func (r *record) bind(id string) error {
	if id == "" {
		return nil
	}
	if !numericID.MatchString(id) || !r.ExternalStarted || (r.RemoteID != "" && r.RemoteID != id) {
		return ErrConflict
	}
	if r.RunMode == "reconcile" && r.RemoteID == "" && r.ReconcileCandidateID != "" && r.ReconcileCandidateID != id {
		return ErrConflict
	}
	r.RemoteID = id
	r.RemoteURL = "https://editor.csdn.net/md/?articleId=" + id
	return nil
}

var stages = map[string]int{"queued": 0, "checking_login": 1, "opening_editor": 2, "draft_acquired": 3, "filling": 4, "saving": 5, "verifying": 6, "finished": 7}

func (r *record) progress(in ProgressInput, now time.Time) error {
	rank, ok := stages[in.Stage]
	if !ok || in.Stage == "queued" || in.Stage == "finished" || r.Status != "running" {
		return ErrConflict
	}
	if readKind(r.Kind) {
		if in.ExternalStarted || in.RemoteID != "" || !(in.Stage == "checking_login" || in.Stage == "verifying") || rank < stages[r.Stage] {
			return ErrConflict
		}
	} else if r.RunMode == "reconcile" {
		if in.ExternalStarted || !(in.Stage == "checking_login" || in.Stage == "verifying") || in.RemoteID != "" {
			return ErrConflict
		}
	} else {
		if rank < stages[r.Stage] {
			return ErrConflict
		}
		if r.Kind == "check_account" && (rank > 1 || in.ExternalStarted || in.RemoteID != "") {
			return ErrConflict
		}
		if rank >= 2 && !r.ExternalStarted && !in.ExternalStarted {
			return ErrConflict
		}
		if in.RemoteID != "" && rank < 3 {
			return ErrConflict
		}
		if in.ExternalStarted {
			r.ExternalStarted = true
			r.Outcome = "unknown"
		}
		if err := r.bind(in.RemoteID); err != nil {
			return err
		}
	}
	r.Stage = in.Stage
	r.UpdatedAt = now
	return nil
}

var safeErrors = map[string]string{
	"article_read_unavailable": "平台文章读取暂不可用",
	"article_not_found":        "文章已不存在或无法读取",
	"draft_absent":             "平台完整查询未找到同名草稿",
	"draft_conflict":           "草稿存在重复或不完整内容，自动恢复已停止",
	"reconcile_unavailable":    "平台草稿查询暂不可用",
	"reconcile_exhausted":      "自动核对次数已用尽，平台结果仍未确认",
	"network_error":            "平台连接暂时失败",
	"timeout":                  "平台操作超时",
	"needs_login":              "需要人工登录",
	"account_mismatch":         "平台账号与配置不符",
	"adapter_mismatch":         "平台页面结构已变化",
	"draft_mismatch":           "草稿内容与任务快照不匹配",
	"draft_not_found":          "未找到匹配草稿",
	"browser_busy":             "账号浏览器仍在使用",
	"lease_expired":            "执行器领取已失效",
	"cancelled":                "执行器已停止",
	"shutdown":                 "执行器已停止",
}

func safeError(code string) (string, string) {
	if msg, ok := safeErrors[code]; ok {
		return code, msg
	}
	if code == "" {
		return "", ""
	}
	return "worker_error", "执行器未能完成任务"
}
func (r *record) complete(in CompleteInput, now time.Time) error {
	if r.Status != "running" {
		return ErrConflict
	}
	switch in.Status {
	case "succeeded", "failed", "waiting_user", "reconciling", "cancelled":
	default:
		return ErrInvalid
	}
	if readKind(r.Kind) && (in.Status == "reconciling" || in.RemoteID != "" || r.ExternalStarted || r.RunMode != "execute") {
		return ErrInvalid
	}
	if readKind(r.Kind) && r.CancelRequested && in.Status != "succeeded" {
		in.Status = "cancelled"
		in.ErrorCode = "cancelled"
		in.Retryable = false
	}
	if in.Status == "succeeded" {
		if readKind(r.Kind) && r.Stage != "verifying" {
			return ErrConflict
		}
		if r.CancelRequested && r.RunMode != "reconcile" {
			return ErrConflict
		}
		if r.Kind == "save_draft" {
			if r.RunMode == "reconcile" {
				if in.RemoteID == "" || r.Stage != "verifying" {
					return ErrConflict
				}
			}
			if err := r.bind(in.RemoteID); err != nil {
				return err
			}
			if !r.ExternalStarted || r.RemoteID == "" || r.Stage != "verifying" {
				return ErrConflict
			}
			r.Outcome = "draft_saved"
		}
		r.Status = "succeeded"
		if r.CancelRequested {
			r.Status = "cancelled"
		}
		r.ErrorCode, r.ErrorMessage = "", ""
		r.Stage = "finished"
		r.FinishedAt = &now
		r.Ready = false
	} else {
		if in.RemoteID != "" {
			if r.RunMode == "reconcile" {
				return ErrConflict
			}
			if err := r.bind(in.RemoteID); err != nil {
				return err
			}
		}
		r.ErrorCode, r.ErrorMessage = safeError(in.ErrorCode)
		r.Ready = false
		if r.ExternalStarted {
			wasReconcile := r.RunMode == "reconcile"
			r.Status, r.Outcome, r.RunMode = "reconciling", "unknown", "reconcile"
			r.AutoReconcileStarted = true
			if in.Status == "waiting_user" {
				r.Status = "waiting_user"
				r.AbsenceChecks = 0
			} else if wasReconcile {
				r.finishReconcile(in, now)
			} else {
				r.Ready = true
				r.AvailableAt = now.Add(20 * time.Second)
			}
		} else {
			switch in.Status {
			case "waiting_user":
				r.Status = "waiting_user"
			case "reconciling":
				return ErrConflict
			case "cancelled":
				if !r.CancelRequested && in.ErrorCode != "shutdown" {
					return ErrConflict
				}
				r.Status = "cancelled"
				r.FinishedAt = &now
			default:
				r.Status = "failed"
				r.FinishedAt = &now
				if !r.CancelRequested && in.Retryable && (in.ErrorCode == "network_error" || in.ErrorCode == "timeout" || in.ErrorCode == "browser_busy") && r.RetryCount < r.MaxRetries {
					backoff := []time.Duration{5 * time.Second, 20 * time.Second, 60 * time.Second}
					idx := r.RetryCount
					r.RetryCount++
					r.Status = "queued"
					r.Stage = "queued"
					r.AvailableAt = now.Add(backoff[idx])
					r.Ready = true
					r.FinishedAt = nil
				}
			}
		}
	}
	r.LeaseToken = ""
	r.LeaseExpiresAt = time.Time{}
	r.UpdatedAt = now
	r.updateRetry()
	return nil
}
func (r *record) updateRetry() {
	r.RetryAllowed = r.Status == "failed" && !r.ExternalStarted && !r.ManualResolved && r.RetryCount < r.MaxRetries && !(readKind(r.Kind) && r.ErrorCode == "account_mismatch")
}
func (r *record) action(action string, in ActionInput, now time.Time, proof *workerProof) error {
	active := r.LeaseToken != "" && r.LeaseExpiresAt.After(now)
	switch action {
	case "cancel":
		if r.Status == "running" {
			r.CancelRequested = true
			break
		}
		if (r.Status != "queued" && !(readKind(r.Kind) && r.Status == "waiting_user")) || r.ExternalStarted {
			return ErrConflict
		}
		r.Status = "cancelled"
		r.Ready = false
		r.FinishedAt = &now
	case "retry":
		r.updateRetry()
		if !r.RetryAllowed || active {
			return ErrConflict
		}
		r.RetryCount++
		r.Status = "queued"
		r.Stage = "queued"
		r.Ready = true
		r.AvailableAt = now
		r.FinishedAt = nil
		r.CancelRequested = false
	case "resume":
		if r.Status != "waiting_user" || active || r.ManualResolved {
			return ErrConflict
		}
		if r.ExternalStarted {
			r.Status = "reconciling"
			r.RunMode = "reconcile"
		} else {
			r.Status = "queued"
			r.Stage = "queued"
		}
		r.Ready = true
		r.AvailableAt = now
		if !r.ExternalStarted {
			r.CancelRequested = false
		}
	case "reconcile":
		if !r.ExternalStarted || r.ManualResolved || active || !(r.Status == "reconciling" || r.Status == "waiting_user" || (r.Status == "failed" && r.Outcome == "unknown")) {
			return ErrConflict
		}
		if in.RemoteID == "" && r.RemoteID == "" {
			r.ReconcileCandidateID = ""
		}
		if in.RemoteID != "" {
			if !numericID.MatchString(in.RemoteID) || (r.RemoteID != "" && r.RemoteID != in.RemoteID) {
				return ErrInvalid
			}
			if r.RemoteID == "" {
				r.ReconcileCandidateID = in.RemoteID
			}
		}
		r.Status = "reconciling"
		r.RunMode = "reconcile"
		r.Ready = true
		r.AutoReconcileStarted = true
		r.AvailableAt = now
	case "resolve":
		if !r.ExternalStarted || r.ManualResolved || active || !(r.Status == "reconciling" || r.Status == "waiting_user" || (r.Status == "failed" && r.Outcome == "unknown")) || !in.ConfirmedBrowserStopped || utf8.RuneCountInString(strings.TrimSpace(in.Note)) < 1 || utf8.RuneCountInString(in.Note) > 500 || proof == nil || now.Sub(proof.SeenAt) > 45*time.Second || proof.SeenAt.After(now) || !proof.BrowserIdle || !proof.ProfileAvailable {
			return ErrConflict
		}
		r.ManualResolved = true
		r.Status = "failed"
		r.Outcome = "unknown"
		r.Ready = false
		r.FinishedAt = &now
		r.ErrorCode = "manual_resolved"
		r.ErrorMessage = "管理员确认保留已有或可能存在的草稿，人工结束任务"
		r.LeaseToken = ""
	default:
		return ErrInvalid
	}
	r.UpdatedAt = now
	r.updateRetry()
	return nil
}
func (r *record) recover(now time.Time) {
	if r.Status != "running" || r.LeaseExpiresAt.After(now) {
		return
	}
	if r.ExternalStarted {
		r.Status = "reconciling"
		r.RunMode = "reconcile"
		r.Outcome = "unknown"
		r.AutoReconcileStarted = true
		r.Ready = true
		r.AvailableAt = now.Add(20 * time.Second)
		// 失租的核对也消耗持久预算，防止重启无限重试。
		r.ReconcileCount++
		if r.ReconcileCount >= 4 {
			r.Status = "failed"
			r.Ready = false
			r.FinishedAt = &now
		}
		r.AbsenceChecks = 0
	} else if r.CancelRequested {
		r.Status = "cancelled"
		r.Ready = false
		r.FinishedAt = &now
	} else if r.RetryCount >= r.MaxRetries {
		r.Status = "failed"
		r.Ready = false
		r.FinishedAt = &now
	} else {
		delay := []time.Duration{5 * time.Second, 20 * time.Second, 60 * time.Second}[r.RetryCount]
		r.RetryCount++
		r.Status = "queued"
		r.Stage = "queued"
		r.Ready = true
		r.AvailableAt = now.Add(delay)
	}
	r.LeaseToken = ""
	r.LeaseExpiresAt = time.Time{}
	r.ErrorCode = "lease_expired"
	r.ErrorMessage = safeErrors["lease_expired"]
	r.UpdatedAt = now
	r.updateRetry()
}

// 核对只消费读取预算；只有两次间隔完整空结果才能重新排队写入。
func (r *record) finishReconcile(in CompleteInput, now time.Time) {
	r.ReconcileCount++
	if in.ErrorCode == "draft_absent" && r.Stage == "verifying" && r.RemoteID == "" && r.ReconcileCandidateID == "" {
		if r.AbsenceChecks == 0 || !now.Before(r.LastAbsenceAt.Add(20*time.Second)) {
			r.AbsenceChecks++
			r.LastAbsenceAt = now
		}
		if r.AbsenceChecks >= 2 {
			r.ExternalStarted = false
			r.Outcome = "not_submitted"
			r.AbsenceChecks = 0
			if r.CancelRequested {
				r.Status = "cancelled"
				r.FinishedAt = &now
				return
			}
			if r.RetryCount >= r.MaxRetries {
				r.Status = "failed"
				r.FinishedAt = &now
				return
			}
			r.RetryCount++
			r.ReconcileCount = 0
			r.Status, r.Stage, r.RunMode = "queued", "queued", "execute"
			r.Ready = true
			r.AvailableAt = now.Add(5 * time.Second)
			return
		}
	} else {
		r.AbsenceChecks = 0
	}
	if in.ErrorCode == "draft_conflict" || in.ErrorCode == "draft_mismatch" || r.ReconcileCount >= 4 {
		r.Status = "failed"
		r.FinishedAt = &now
		if r.ReconcileCount >= 4 && in.ErrorCode != "draft_conflict" && in.ErrorCode != "draft_mismatch" {
			r.ErrorCode, r.ErrorMessage = safeError("reconcile_exhausted")
		}
		return
	}
	r.Ready = true
	r.AvailableAt = now.Add(20 * time.Second)
}
