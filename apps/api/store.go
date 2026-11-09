package bridge

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

//go:embed tenant_schema.sql
var tenantSchemaSQL string

//go:embed integration_content_schema.sql
var integrationContentSchemaSQL string

//go:embed content_schema.sql
var contentSchemaSQL string

type Store struct {
	pool         *tenantPool
	now          func() time.Time
	integrations *IntegrationService
	contents     *contentRegistry
}
type Claim struct {
	Job            Job       `json:"job"`
	LeaseToken     string    `json:"lease_token"`
	LeaseSeconds   int       `json:"lease_seconds"`
	LeaseExpiresAt time.Time `json:"lease_expires_at"`
}
type Account struct {
	OwnerUserID   string     `json:"owner_user_id,omitempty"`
	Enabled       bool       `json:"enabled"`
	Verified      bool       `json:"verified"`
	ID            string     `json:"id"`
	Platform      string     `json:"platform"`
	Username      string     `json:"username"`
	DisplayName   string     `json:"display_name"`
	Status        string     `json:"status"`
	LastCheckedAt *time.Time `json:"last_checked_at"`
	LastError     string     `json:"last_error"`
}
type Log struct {
	Status    string    `json:"status"`
	Outcome   string    `json:"outcome"`
	RunMode   string    `json:"run_mode"`
	ID        int64     `json:"id"`
	JobID     string    `json:"job_id"`
	Attempt   int       `json:"attempt"`
	Level     string    `json:"level"`
	Stage     string    `json:"stage"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
}

func NewStore(ctx context.Context, pool *pgxpool.Pool, username, display string) (*Store, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// 串行化迁移，避免多个 API 实例同时初始化表。
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(721936419)"); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, schemaSQL); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, integrationSchemaSQL); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, integrationContentSchemaSQL); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, tenantSchemaSQL); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, contentSchemaSQL); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO account(id,username,display_name) VALUES('csdn-main',$1,$2) ON CONFLICT(id) DO NOTHING", username, display); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	store := &Store{pool: &tenantPool{Pool: pool}, now: func() time.Time { return time.Now().UTC() }}
	store.contents = builtinContentRegistry(store)
	return store, nil
}
func (s *Store) locked(ctx context.Context, fn func(pgx.Tx, time.Time) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if accountOf(ctx) != "" {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,721936419))", accountOf(ctx)); err != nil {
			return err
		}
	}
	if err = fn(tx, s.now()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func load(ctx context.Context, tx pgx.Tx, id string) (*record, error) {
	var data []byte
	if err := tx.QueryRow(ctx, "SELECT record FROM jobs WHERE id=$1 FOR UPDATE", id).Scan(&data); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var r record
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	return &r, nil
}
func save(ctx context.Context, tx pgx.Tx, r *record) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE jobs SET record=$2::jsonb||jsonb_build_object('owner_user_id',owner_user_id,'connection_version',connection_version,'created_by',created_by) WHERE id=$1", r.ID, data)
	return err
}
func appendLog(ctx context.Context, tx pgx.Tx, r *record, level, message string, now time.Time) error {
	_, err := tx.Exec(ctx, "INSERT INTO logs(job_id,attempt,level,stage,message,created_at,status,outcome,run_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", r.ID, r.Attempts, level, r.Stage, message, now, r.Status, r.Outcome, r.RunMode)
	return err
}
func fingerprint(in CreateInput) string {
	data, _ := json.Marshal(in)
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
func (s *Store) Create(ctx context.Context, in CreateInput) (Job, bool, error) {
	if in.AccountID != "" {
		sc := scopeOf(ctx)
		sc.AccountID = in.AccountID
		ctx = scoped(ctx, sc)
	}

	if in.Kind == "sync_notes" || in.Kind == "read_note" || in.AccountID != "" && !validKey(in.AccountID) {
		return Job{}, false, ErrInvalid
	}
	if readKind(in.Kind) {
		if in.Platform != "csdn" {
			return Job{}, false, ErrInvalid
		}
		return s.createReadJob(ctx, accountOf(ctx), in)
	}
	if in.Kind == "check_account" {
		if in.ArticleID != "" || !validKey(in.RequestID) || in.Platform != "csdn" || in.Title != "" || in.Markdown != "" {
			return Job{}, false, ErrInvalid
		}
	} else if err := ValidateCreate(in); err != nil {
		return Job{}, false, err
	}
	if err := s.executableAccount(ctx, accountOf(ctx)); err != nil {
		return Job{}, false, err
	}
	var job Job
	created := false
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var currentUsername string
		var verified bool
		if err := tx.QueryRow(ctx, "SELECT verified FROM account WHERE id=pb_account() FOR SHARE").Scan(&verified); err != nil {
			return err
		}
		if !verified {
			return ErrConflict
		}
		if err := tx.QueryRow(ctx, "SELECT username FROM account WHERE id=pb_account() AND platform='csdn'").Scan(&currentUsername); err != nil {
			return err
		}
		var hash string
		var data []byte
		err := tx.QueryRow(ctx, "SELECT fingerprint,record FROM jobs WHERE request_id=$1 AND request_namespace=pb_caller()", in.RequestID).Scan(&hash, &data)
		if err == nil {
			if hash != fingerprint(in) {
				return ErrConflict
			}
			var r record
			if err = json.Unmarshal(data, &r); err != nil {
				return err
			}
			if r.AccountID != accountOf(ctx) || (readKind(in.Kind) && r.AccountUsername != currentUsername) {
				return ErrConflict
			}
			job = r.Job
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		err = tx.QueryRow(ctx, "SELECT a.fingerprint,j.record FROM article_read_requests a JOIN jobs j ON j.id=a.job_id WHERE a.request_id=$1 AND a.request_namespace=pb_caller()", in.RequestID).Scan(&hash, &data)
		if err == nil {
			if hash != fingerprint(in) {
				return ErrConflict
			}
			var existing record
			if e := json.Unmarshal(data, &existing); e != nil {
				return e
			}
			if existing.AccountID != accountOf(ctx) || existing.AccountUsername != currentUsername {
				return ErrConflict
			}
			job = existing.Job
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		r := newRecord(in, now)
		r.AccountID = accountOf(ctx)
		r.AccountUsername = currentUsername
		data, err = json.Marshal(r)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)", r.ID, in.RequestID, fingerprint(in), data, now); err != nil {
			return err
		}
		job = r.Job
		created = true
		return appendLog(ctx, tx, r, "info", "任务已加入队列", now)
	})
	if err == nil && created {
		job, err = s.Get(ctx, job.ID)
	}
	return job, created, err
}
func (s *Store) Claim(ctx context.Context, worker string) (*Claim, error) {
	return s.ClaimForAccount(ctx, worker, "csdn-main")
}
func (s *Store) ClaimForAccount(ctx context.Context, worker, accountID string) (*Claim, error) {
	sc := scopeOf(ctx)
	sc.AccountID = accountID
	ctx = scoped(ctx, sc)
	if err := s.executableAccount(ctx, accountID); err != nil {
		return nil, err
	}
	if !validKey(worker) {
		return nil, ErrInvalid
	}
	var claim *Claim
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		rows, err := tx.Query(ctx, "SELECT record FROM jobs WHERE record->>'account_id'=$1 ORDER BY created_at,id FOR UPDATE SKIP LOCKED", accountID)
		if err != nil {
			return err
		}
		records := []*record{}
		for rows.Next() {
			var data []byte
			if err = rows.Scan(&data); err != nil {
				rows.Close()
				return err
			}
			var r record
			if err = json.Unmarshal(data, &r); err != nil {
				rows.Close()
				return err
			}
			records = append(records, &r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		var currentUsername string
		var currentVersion int64
		if err = tx.QueryRow(ctx, "SELECT username,connection_version FROM account WHERE id=$1", accountID).Scan(&currentUsername, &currentVersion); err != nil {
			return err
		}
		active := false
		unknown := ""
		for _, r := range records {
			if r.AccountUsername == "" && r.AccountID == "csdn-main" {
				r.AccountUsername = currentUsername
			}
			if r.Status == "reconciling" && r.ExternalStarted && !r.ManualResolved && !r.AutoReconcileStarted {
				r.AutoReconcileStarted = true
				r.RunMode = "reconcile"
				r.Ready = true
				r.AvailableAt = now.Add(20 * time.Second)
				if err = save(ctx, tx, r); err != nil {
					return err
				}
				if err = appendLog(ctx, tx, r, "info", "已安排后台自动查询草稿", now); err != nil {
					return err
				}
			}
			if r.Status == "running" && !r.LeaseExpiresAt.After(now) {
				r.recover(now)
				if err = save(ctx, tx, r); err != nil {
					return err
				}
				if err = appendLog(ctx, tx, r, "warning", "领取过期，已按外站检查点恢复", now); err != nil {
					return err
				}
			}
			if ((readKind(r.Kind) && r.AccountUsername != currentUsername) || (r.ConnectionVersion > 0 && r.ConnectionVersion != currentVersion)) && r.Status != "running" && (r.Status == "queued" || r.Status == "waiting_user") {
				r.Status = "failed"
				r.Ready = false
				r.ErrorCode = "account_mismatch"
				r.ErrorMessage = safeErrors["account_mismatch"]
				r.FinishedAt = &now
				r.UpdatedAt = now
				r.updateRetry()
				if err = save(ctx, tx, r); err != nil {
					return err
				}
				if err = appendLog(ctx, tx, r, "warning", "账号已变更，读取任务已停止", now); err != nil {
					return err
				}
			}
			if r.Status == "running" || r.LeaseToken != "" && r.LeaseExpiresAt.After(now) {
				active = true
			}
			if r.ExternalStarted && r.unresolvedResult() && !r.ManualResolved {
				unknown = r.ID
			}
		}
		if active {
			return nil
		}
		for _, r := range records {
			if !r.Ready || r.AvailableAt.After(now) || !(r.Status == "queued" || r.Status == "reconciling") {
				continue
			}
			if unknown != "" && r.RunMode != "reconcile" && r.Kind != "check_account" && !readKind(r.Kind) {
				continue
			}

			allowed, guardErr := s.integrationClaimAllowed(ctx, tx, r, now)
			if guardErr != nil {
				return guardErr
			}
			if !allowed {
				continue
			}
			allowed, budgetErr := reserveBrowser(ctx, tx, accountID, "task", now)
			if budgetErr != nil {
				return budgetErr
			}
			if !allowed {
				return nil
			}
			r.Status = "running"
			r.Attempts++
			r.LeaseToken = randomToken()
			r.LeaseExpiresAt = now.Add(60 * time.Second)
			r.WorkerID = worker
			r.Ready = false
			r.UpdatedAt = now
			r.FinishedAt = nil
			if r.RunMode == "reconcile" {
				r.Stage = "checking_login"
			} else {
				r.Stage = "queued"
			}
			if r.StartedAt == nil {
				r.StartedAt = &now
			}
			if err = save(ctx, tx, r); err != nil {
				return err
			}
			proof, proofErr := tx.Exec(ctx, "INSERT INTO worker_proofs(worker_id,seen_at,browser_idle,profile_available,account_id) VALUES($1,$2,false,false,$3) ON CONFLICT(worker_id) DO UPDATE SET seen_at=excluded.seen_at,browser_idle=false,profile_available=false WHERE worker_proofs.account_id=excluded.account_id", worker, now, accountID)
			if proofErr != nil {
				return proofErr
			}
			if proof.RowsAffected() != 1 {
				return ErrConflict
			}
			if err = appendLog(ctx, tx, r, "info", "执行器已领取任务", now); err != nil {
				return err
			}
			if r.Kind == "check_account" {
				if err = captureAccount(ctx, tx, r, "before", now); err != nil {
					return err
				}
			}
			claim = &Claim{Job: r.Job, LeaseToken: r.LeaseToken, LeaseSeconds: 60, LeaseExpiresAt: r.LeaseExpiresAt}
			return nil
		}
		return nil
	})
	return claim, err
}
func leaseValid(r *record, token string, now time.Time) bool {
	return r.Status == "running" && token != "" && r.LeaseToken == token && r.LeaseExpiresAt.After(now)
}
func (s *Store) mutateLease(ctx context.Context, id, token string, fn func(pgx.Tx, *record, time.Time) error) error {
	job, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	sc := scopeOf(ctx)
	sc.AccountID = job.AccountID
	ctx = scoped(ctx, sc)
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if !leaseValid(r, token, now) {
			return ErrConflict
		}
		matches, err := jobAccountMatches(ctx, tx, r)
		if err != nil {
			return err
		}
		if !matches {
			return ErrConflict
		}
		if err = fn(tx, r, now); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
}
func (s *Store) Heartbeat(ctx context.Context, id, token string) (bool, error) {
	cancel := false
	err := s.mutateLease(ctx, id, token, func(tx pgx.Tx, r *record, now time.Time) error {
		cancel = r.CancelRequested && r.RunMode != "reconcile"
		r.LeaseExpiresAt = now.Add(60 * time.Second)
		_, err := tx.Exec(ctx, "UPDATE account_browser_slots SET expires_at=$2 WHERE account_id=$1 AND purpose='task'", r.AccountID, now.Add(90*time.Second))
		return err
	})
	return cancel, err
}
func (s *Store) Progress(ctx context.Context, id string, in ProgressInput) error {
	if handled, err := s.integrationProgress(ctx, id, in); handled || err != nil {
		return err
	}
	return s.mutateLease(ctx, id, in.LeaseToken, func(tx pgx.Tx, r *record, now time.Time) error {
		if r.CancelRequested && r.RunMode != "reconcile" {
			return ErrConflict
		}
		if in.RemoteID != "" {
			exists, err := remoteIDInUse(ctx, tx, r, in.RemoteID)
			if err != nil {
				return err
			}
			if exists {
				return ErrConflict
			}
		}
		if r.Platform == "xiaohongshu" && (in.ExternalStarted || in.RemoteID != "" || in.Observation != nil || in.PlatformMarkdown != "" || in.PublishedHTMLSHA256 != "") {
			return ErrInvalid
		}
		if in.Observation != nil {
			if err := captureObservation(ctx, tx, r, in, now); err != nil {
				return err
			}
		}
		if err := r.progress(in, now); err != nil {
			return err
		}
		return appendLog(ctx, tx, r, "info", "执行阶段已更新", now)
	})
}
func (s *Store) Complete(ctx context.Context, id string, in CompleteInput) error {
	return s.mutateLease(ctx, id, in.LeaseToken, func(tx pgx.Tx, r *record, now time.Time) error {
		if err := s.acceptContentResult(ctx, tx, r, in, now); err != nil {
			return err
		}
		if in.RemoteID != "" {
			exists, err := remoteIDInUse(ctx, tx, r, in.RemoteID)
			if err != nil {
				return err
			}
			if r.Kind == "publish" && (exists || in.RemoteID != r.RemoteID) {
				return ErrConflict
			}
			if exists {
				in.Status = "reconciling"
				in.RemoteID = ""
				in.ErrorCode = "draft_conflict"
			}
		}
		if err := r.complete(in, now); err != nil {
			return err
		}
		status := ""
		if r.Status == "succeeded" {
			status = "connected"
		} else if r.Status == "waiting_user" {
			status = "needs_login"
		} else if in.ErrorCode == "account_mismatch" && r.Status != "cancelled" {
			status = "blocked"
		}
		if status != "" {
			if _, err := tx.Exec(ctx, "UPDATE account SET status=$1,last_checked_at=$2,last_error=$3 WHERE id=$4", status, now, r.ErrorMessage, r.AccountID); err != nil {
				return err
			}
		}
		if r.Kind == "check_account" {
			if err := captureAccount(ctx, tx, r, "after", now); err != nil {
				return err
			}
		}
		level := "info"
		if r.Status == "failed" || r.Status == "reconciling" {
			level = "warning"
		}
		if _, err := tx.Exec(ctx, "DELETE FROM account_browser_slots WHERE account_id=$1 AND purpose='task'", r.AccountID); err != nil {
			return err
		}
		return appendLog(ctx, tx, r, level, "执行器已上报任务结果", now)
	})
}
func (s *Store) Get(ctx context.Context, id string) (Job, error) {
	var data []byte
	if err := s.pool.QueryRow(ctx, "SELECT record FROM jobs WHERE id=$1", id).Scan(&data); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Job{}, ErrNotFound
		}
		return Job{}, err
	}
	var r record
	if err := json.Unmarshal(data, &r); err != nil {
		return Job{}, err
	}
	return r.Job, nil
}
func (s *Store) Action(ctx context.Context, id, action string, in ActionInput) (Job, error) {
	var result Job
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		r.recover(now)
		var proof workerProof
		var p *workerProof
		if r.WorkerID != "" {
			err = tx.QueryRow(ctx, "SELECT seen_at,browser_idle,profile_available FROM worker_proofs WHERE worker_id=$1", r.WorkerID).Scan(&proof.SeenAt, &proof.BrowserIdle, &proof.ProfileAvailable)
			if err == nil {
				p = &proof
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		if action == "resolve" {
			var active bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE record->>'status'='running' AND (record->>'LeaseExpiresAt')::timestamptz>$1)", now).Scan(&active); err != nil {
				return err
			}
			if active {
				return ErrConflict
			}
		}
		if err = s.integrationActionAllowed(ctx, tx, r, action, now); err != nil {
			return err
		}
		if err = r.action(action, in, now, p); err != nil {
			return err
		}
		if action == "resolve" {
			if _, err = tx.Exec(ctx, "INSERT INTO admin_decisions(job_id,note,created_at) VALUES($1,$2,$3)", r.ID, in.Note, now); err != nil {
				return err
			}
		}
		if err = save(ctx, tx, r); err != nil {
			return err
		}
		message := map[string]string{
			"cancel":    "管理员请求停止任务",
			"retry":     "管理员请求安全重试",
			"resume":    "管理员恢复等待任务",
			"reconcile": "管理员请求只读核对",
			"resolve":   "管理员保留草稿并人工结束任务",
		}[action]
		if action == "resolve" && r.Kind == "publish" {
			message = "管理员保留平台现有状态并人工结束任务"
		}
		if err = appendLog(ctx, tx, r, "info", message, now); err != nil {
			return err
		}
		result = r.Job
		return nil
	})
	return result, err
}
func (s *Store) WorkerHeartbeat(ctx context.Context, worker string, idle, available bool) error {
	return s.WorkerHeartbeatForAccount(ctx, worker, "csdn-main", idle, available)
}
func (s *Store) WorkerHeartbeatForAccount(ctx context.Context, worker, accountID string, idle, available bool) error {
	if !validKey(worker) {
		return ErrInvalid
	}
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		if _, err := tx.Exec(ctx, "UPDATE account_browser_slots SET expires_at=$2 WHERE account_id=$1 AND purpose='login'", accountID, now.Add(90*time.Second)); err != nil {
			return err
		}
		// 活跃领取期间的空闲声明不能用作人工结束证明。
		if idle {
			var active bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE record->>'WorkerID'=$1 AND record->>'status'='running' AND (record->>'LeaseExpiresAt')::timestamptz>$2)", worker, now).Scan(&active); err != nil {
				return err
			}
			if active {
				idle = false
				available = false
			}
		}
		tag, err := tx.Exec(ctx, "INSERT INTO worker_proofs(worker_id,seen_at,browser_idle,profile_available,account_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_id) DO UPDATE SET seen_at=excluded.seen_at,browser_idle=excluded.browser_idle,profile_available=excluded.profile_available WHERE worker_proofs.account_id=excluded.account_id", worker, now, idle, available, accountID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrConflict
		}
		return nil
	})
}
func (s *Store) Account(ctx context.Context) (Account, error) {
	if accountOf(ctx) == "" {
		return Account{}, nil
	}
	return s.AccountByID(ctx, accountOf(ctx))
}

func (s *Store) LastSeen(ctx context.Context) (*time.Time, error) {
	var seen *time.Time
	err := s.pool.QueryRow(ctx, "SELECT max(seen_at) FROM worker_proofs").Scan(&seen)
	return seen, err
}
func (s *Store) Jobs(ctx context.Context, q, status string, page, size int) ([]Job, int, error) {
	rows, err := s.pool.Query(ctx, "SELECT record,count(*) OVER() FROM jobs WHERE ($1='' OR record->>'title' ILIKE '%'||$1||'%' OR id=$1) AND ($2='' OR record->>'status'=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4", q, status, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	jobs := []Job{}
	total := 0
	for rows.Next() {
		var data []byte
		if err = rows.Scan(&data, &total); err != nil {
			return nil, 0, err
		}
		var r record
		if err = json.Unmarshal(data, &r); err != nil {
			return nil, 0, err
		}
		j := r.Job
		j.Markdown, j.PlatformMarkdown, j.ImageURLs = "", "", nil
		jobs = append(jobs, j)
	}
	if len(jobs) == 0 {
		if err = s.pool.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE ($1='' OR record->>'title' ILIKE '%'||$1||'%' OR id=$1) AND ($2='' OR record->>'status'=$2)", q, status).Scan(&total); err != nil {
			return nil, 0, err
		}
	}
	return jobs, total, rows.Err()
}
func (s *Store) Counts(ctx context.Context) (map[string]int, error) {
	result := map[string]int{
		"queued":       0,
		"running":      0,
		"waiting_user": 0,
		"reconciling":  0,
		"succeeded":    0,
		"failed":       0,
		"cancelled":    0,
	}
	rows, err := s.pool.Query(ctx, "SELECT record->>'status',count(*) FROM jobs GROUP BY record->>'status'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var n int
		if err = rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		result[state] = n
	}
	return result, rows.Err()
}
func (s *Store) Logs(ctx context.Context, job, level, q string, from, to time.Time, page, size int) ([]Log, int, error) {
	where := " FROM logs WHERE ($1='' OR job_id=$1) AND ($2='' OR level=$2) AND ($3='' OR message ILIKE '%'||$3||'%') AND created_at >= $4 AND created_at <= $5"
	rows, err := s.pool.Query(ctx, "SELECT id,job_id,attempt,level,stage,message,created_at,status,outcome,run_mode,count(*) OVER()"+where+" ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7", job, level, q, from, to, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	logs := []Log{}
	total := 0
	for rows.Next() {
		var l Log
		if err = rows.Scan(&l.ID, &l.JobID, &l.Attempt, &l.Level, &l.Stage, &l.Message, &l.CreatedAt, &l.Status, &l.Outcome, &l.RunMode, &total); err != nil {
			return nil, 0, err
		}
		logs = append(logs, l)
	}
	if len(logs) == 0 {
		if err = s.pool.QueryRow(ctx, "SELECT count(*)"+where, job, level, q, from, to).Scan(&total); err != nil {
			return nil, 0, err
		}
	}
	return logs, total, rows.Err()
}
func (s *Store) Maintain(ctx context.Context) error {
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		rows, err := tx.Query(ctx, "SELECT id FROM jobs WHERE record->>'status'='running' AND (record->>'LeaseExpiresAt')::timestamptz<=$1", now)
		if err != nil {
			return err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, id := range ids {
			r, err := load(ctx, tx, id)
			if err != nil {
				return err
			}
			r.recover(now)
			if err = save(ctx, tx, r); err != nil {
				return err
			}
			if err = appendLog(ctx, tx, r, "warning", "领取过期，已按外站检查点恢复", now); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, "DELETE FROM sessions WHERE expires_at<=$1", now); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM logs WHERE created_at<$1", now.Add(-30*24*time.Hour)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM admin_decisions WHERE created_at<$1", now.Add(-90*24*time.Hour)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM account_article_bodies WHERE fetched_at<$1", now.Add(-30*24*time.Hour)); err != nil {

			return err
		}
		for _, a := range s.contentRegistry().adapters {
			if a.BodyTTLSeconds > 0 {
				if _, err = tx.Exec(ctx, "DELETE FROM content_bodies b USING account a WHERE b.account_id=a.id AND a.platform=$1 AND b.fetched_at<$2", a.ID, now.Add(-time.Duration(a.BodyTTLSeconds)*time.Second)); err != nil {
					return err
				}
			}
		}
		if _, err = tx.Exec(ctx, "DELETE FROM process_snapshots WHERE job_id IN (SELECT id FROM jobs WHERE record->>'status' IN ('succeeded','failed','cancelled') AND record->>'outcome' NOT IN ('unknown','submitted') AND record->>'retry_allowed'<>'true' AND (record->>'updated_at')::timestamptz<$1)", now.Add(-30*24*time.Hour)); err != nil {
			return err
		}
		if err = s.maintainIntegrations(ctx, tx, now); err != nil {
			return err
		}
		// 仅清理不可重试终结记录的正文，未决和仍可重试的快照始终保留。
		_, err = tx.Exec(ctx, "UPDATE jobs SET record=jsonb_set(record - 'platform_markdown','{markdown}','\"\"'::jsonb) WHERE record->>'status' IN ('succeeded','failed','cancelled') AND record->>'outcome' NOT IN ('unknown','submitted') AND record->>'retry_allowed'<>'true' AND (record->>'updated_at')::timestamptz<$1", now.Add(-30*24*time.Hour))
		return err
	})
}
func (s *Store) Ready(ctx context.Context) error {
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT 1 FROM account WHERE id=pb_account()").Scan(&n); err != nil {
		return fmt.Errorf("数据库未就绪")
	}
	return nil
}
