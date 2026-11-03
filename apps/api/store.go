package bridge

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

//go:embed schema.sql
var schemaSQL string

type Store struct {
	pool *pgxpool.Pool
	now  func() time.Time
}
type Claim struct {
	Job            Job       `json:"job"`
	LeaseToken     string    `json:"lease_token"`
	LeaseSeconds   int       `json:"lease_seconds"`
	LeaseExpiresAt time.Time `json:"lease_expires_at"`
}
type Account struct {
	ID            string     `json:"id"`
	Platform      string     `json:"platform"`
	Username      string     `json:"username"`
	DisplayName   string     `json:"display_name"`
	Status        string     `json:"status"`
	LastCheckedAt *time.Time `json:"last_checked_at"`
	LastError     string     `json:"last_error"`
}
type Log struct {
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
	if _, err = tx.Exec(ctx, "INSERT INTO account(id,username,display_name) VALUES('csdn-main',$1,$2) ON CONFLICT(id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name", username, display); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Store{pool: pool, now: func() time.Time { return time.Now().UTC() }}, nil
}
func (s *Store) locked(ctx context.Context, fn func(pgx.Tx, time.Time) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, "SELECT id FROM account WHERE id='csdn-main' FOR UPDATE").Scan(&id); err != nil {
		return err
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
	_, err = tx.Exec(ctx, "UPDATE jobs SET record=$2 WHERE id=$1", r.ID, data)
	return err
}
func appendLog(ctx context.Context, tx pgx.Tx, r *record, level, message string, now time.Time) error {
	_, err := tx.Exec(ctx, "INSERT INTO logs(job_id,attempt,level,stage,message,created_at) VALUES($1,$2,$3,$4,$5,$6)", r.ID, r.Attempts, level, r.Stage, message, now)
	return err
}
func fingerprint(in CreateInput) string {
	data, _ := json.Marshal(in)
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
func (s *Store) Create(ctx context.Context, in CreateInput) (Job, bool, error) {
	if in.Kind == "check_account" {
		if !validKey(in.RequestID) || in.Platform != "csdn" || in.Title != "" || in.Markdown != "" {
			return Job{}, false, ErrInvalid
		}
	} else if err := ValidateCreate(in); err != nil {
		return Job{}, false, err
	}
	var job Job
	created := false
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var hash string
		var data []byte
		err := tx.QueryRow(ctx, "SELECT fingerprint,record FROM jobs WHERE request_id=$1", in.RequestID).Scan(&hash, &data)
		if err == nil {
			if hash != fingerprint(in) {
				return ErrConflict
			}
			var r record
			if err = json.Unmarshal(data, &r); err != nil {
				return err
			}
			job = r.Job
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		r := newRecord(in, now)
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
	return job, created, err
}
func (s *Store) Claim(ctx context.Context, worker string) (*Claim, error) {
	if !validKey(worker) {
		return nil, ErrInvalid
	}
	var claim *Claim
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		rows, err := tx.Query(ctx, "SELECT record FROM jobs ORDER BY created_at,id FOR UPDATE SKIP LOCKED")
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
		active := false
		unknown := ""
		for _, r := range records {
			if r.Status == "running" && !r.LeaseExpiresAt.After(now) {
				r.recover(now)
				if err = save(ctx, tx, r); err != nil {
					return err
				}
				if err = appendLog(ctx, tx, r, "warning", "领取过期，已按外站检查点恢复", now); err != nil {
					return err
				}
			}
			if r.Status == "running" {
				active = true
			}
			if r.ExternalStarted && r.Outcome == "unknown" && !r.ManualResolved {
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
			if unknown != "" && r.RunMode != "reconcile" && r.Kind != "check_account" {
				continue
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
			if _, err = tx.Exec(ctx, "INSERT INTO worker_proofs(worker_id,seen_at,browser_idle,profile_available) VALUES($1,$2,false,false) ON CONFLICT(worker_id) DO UPDATE SET seen_at=excluded.seen_at,browser_idle=false,profile_available=false", worker, now); err != nil {
				return err
			}
			if err = appendLog(ctx, tx, r, "info", "执行器已领取任务", now); err != nil {
				return err
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
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if !leaseValid(r, token, now) {
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
		cancel = r.CancelRequested
		r.LeaseExpiresAt = now.Add(60 * time.Second)
		return nil
	})
	return cancel, err
}
func (s *Store) Progress(ctx context.Context, id string, in ProgressInput) error {
	return s.mutateLease(ctx, id, in.LeaseToken, func(tx pgx.Tx, r *record, now time.Time) error {
		if r.CancelRequested {
			return ErrConflict
		}
		if err := r.progress(in, now); err != nil {
			return err
		}
		return appendLog(ctx, tx, r, "info", "执行阶段已更新", now)
	})
}
func (s *Store) Complete(ctx context.Context, id string, in CompleteInput) error {
	return s.mutateLease(ctx, id, in.LeaseToken, func(tx pgx.Tx, r *record, now time.Time) error {
		if err := r.complete(in, now); err != nil {
			return err
		}
		status := ""
		if r.Status == "succeeded" {
			status = "connected"
		} else if r.Status == "waiting_user" {
			status = "needs_login"
		} else if in.ErrorCode == "account_mismatch" {
			status = "blocked"
		}
		if status != "" {
			if _, err := tx.Exec(ctx, "UPDATE account SET status=$1,last_checked_at=$2,last_error=$3 WHERE id='csdn-main'", status, now, r.ErrorMessage); err != nil {
				return err
			}
		}
		level := "info"
		if r.Status == "failed" || r.Status == "reconciling" {
			level = "warning"
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
		if err = appendLog(ctx, tx, r, "info", map[string]string{"cancel": "管理员请求停止任务", "retry": "管理员请求安全重试", "resume": "管理员恢复等待任务", "reconcile": "管理员请求只读核对", "resolve": "管理员保留草稿并人工结束任务"}[action], now); err != nil {
			return err
		}
		result = r.Job
		return nil
	})
	return result, err
}
func (s *Store) WorkerHeartbeat(ctx context.Context, worker string, idle, available bool) error {
	if !validKey(worker) {
		return ErrInvalid
	}
	return s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
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
		_, err := tx.Exec(ctx, "INSERT INTO worker_proofs(worker_id,seen_at,browser_idle,profile_available) VALUES($1,$2,$3,$4) ON CONFLICT(worker_id) DO UPDATE SET seen_at=excluded.seen_at,browser_idle=excluded.browser_idle,profile_available=excluded.profile_available", worker, now, idle, available)
		return err
	})
}
func (s *Store) Account(ctx context.Context) (Account, error) {
	a := Account{ID: "csdn-main", Platform: "csdn"}
	err := s.pool.QueryRow(ctx, "SELECT username,display_name,status,last_checked_at,last_error FROM account WHERE id='csdn-main'").Scan(&a.Username, &a.DisplayName, &a.Status, &a.LastCheckedAt, &a.LastError)
	return a, err
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
		j.Markdown = ""
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
	result := map[string]int{"queued": 0, "running": 0, "waiting_user": 0, "reconciling": 0, "succeeded": 0, "failed": 0, "cancelled": 0}
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
	rows, err := s.pool.Query(ctx, "SELECT id,job_id,attempt,level,stage,message,created_at,count(*) OVER()"+where+" ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7", job, level, q, from, to, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	logs := []Log{}
	total := 0
	for rows.Next() {
		var l Log
		if err = rows.Scan(&l.ID, &l.JobID, &l.Attempt, &l.Level, &l.Stage, &l.Message, &l.CreatedAt, &total); err != nil {
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
		// 仅清理不可重试终结记录的正文，未决和仍可重试的快照始终保留。
		_, err = tx.Exec(ctx, "UPDATE jobs SET record=jsonb_set(record,'{markdown}','\"\"'::jsonb) WHERE record->>'status' IN ('succeeded','failed','cancelled') AND record->>'outcome'<>'unknown' AND record->>'retry_allowed'<>'true' AND (record->>'updated_at')::timestamptz<$1", now.Add(-30*24*time.Hour))
		return err
	})
}
func (s *Store) Ready(ctx context.Context) error {
	var n int
	if err := s.pool.QueryRow(ctx, "SELECT 1 FROM account WHERE id='csdn-main'").Scan(&n); err != nil {
		return fmt.Errorf("数据库未就绪")
	}
	return nil
}
