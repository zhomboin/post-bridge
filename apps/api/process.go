package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type ProcessSummary struct {
	Job
	ObjectType   string `json:"object_type"`
	ObjectID     string `json:"object_id"`
	ObjectName   string `json:"object_name"`
	AccountName  string `json:"account_name"`
	EventCount   int    `json:"event_count"`
	ErrorCount   int    `json:"error_count"`
	WarningCount int    `json:"warning_count"`
}
type ProcessFilter struct {
	Q, Status, Platform, Kind, JobID, Level string
	From, To                                time.Time
	Page, Size                              int
}
type ProcessSnapshot struct {
	ID          int64     `json:"id"`
	Attempt     int       `json:"attempt"`
	Phase       string    `json:"phase"`
	ObjectType  string    `json:"object_type"`
	Title       string    `json:"title"`
	Markdown    string    `json:"markdown"`
	Status      string    `json:"status"`
	RemoteID    string    `json:"remote_id,omitempty"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	CapturedAt  time.Time `json:"captured_at"`
}
type ProcessChanges struct {
	Submitted struct {
		Title    string `json:"title"`
		Markdown string `json:"markdown"`
	} `json:"submitted"`
	Snapshots       []ProcessSnapshot `json:"snapshots"`
	Attempts        []int             `json:"attempts"`
	ContentRetained bool              `json:"content_retained"`
}

func writeSnapshot(ctx context.Context, tx pgx.Tx, r *record, phase, kind string, data any, now time.Time) error {
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, "INSERT INTO process_snapshots(job_id,attempt,phase,object_type,data,captured_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,attempt,phase) DO NOTHING", r.ID, r.Attempts, phase, kind, raw, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var same bool
		if err = tx.QueryRow(ctx, "SELECT object_type=$4 AND data=$5::jsonb FROM process_snapshots WHERE job_id=$1 AND attempt=$2 AND phase=$3", r.ID, r.Attempts, phase, kind, raw).Scan(&same); err != nil {
			return err
		}
		if !same {
			return ErrConflict
		}
	}
	return nil
}
func captureObservation(ctx context.Context, tx pgx.Tx, r *record, in ProgressInput, now time.Time) error {
	o := in.Observation
	if r.Kind != "save_draft" || (o.Phase != "before" && o.Phase != "after") {
		return ErrInvalid
	}
	if (o.Phase == "before" && (in.Stage != "filling" || r.RunMode != "execute" || stages[r.Stage] > stages["filling"])) || (o.Phase == "after" && in.Stage != "verifying") {
		return ErrConflict
	}
	if !utf8.ValidString(o.Title) || !utf8.ValidString(o.Markdown) || !utf8.ValidString(o.Status) || !utf8.ValidString(o.RemoteID) || strings.ContainsRune(o.Title, 0) || strings.ContainsRune(o.Markdown, 0) || strings.ContainsRune(o.Status, 0) || utf8.RuneCountInString(o.Title) > 100 || utf8.RuneCountInString(o.Markdown) > 200000 || strings.TrimSpace(o.Status) == "" || utf8.RuneCountInString(o.Status) > 100 || o.RemoteID != "" && !numericID.MatchString(o.RemoteID) {
		return ErrInvalid
	}
	// 平台标识可在只读核对期间新发现，已有绑定则必须一致。
	if o.RemoteID != "" && ((r.RemoteID != "" && r.RemoteID != o.RemoteID) || (in.RemoteID != "" && in.RemoteID != o.RemoteID) || (r.RunMode == "reconcile" && r.ReconcileCandidateID != "" && r.ReconcileCandidateID != o.RemoteID)) {
		return ErrConflict
	}
	return writeSnapshot(ctx, tx, r, o.Phase, "article", o, now)
}
func captureAccount(ctx context.Context, tx pgx.Tx, r *record, phase string, now time.Time) error {
	var a struct {
		Status      string `json:"status"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	}
	if err := tx.QueryRow(ctx, "SELECT status,username,display_name FROM account WHERE id=$1", r.AccountID).Scan(&a.Status, &a.Username, &a.DisplayName); err != nil {
		return err
	}
	return writeSnapshot(ctx, tx, r, phase, "account", a, now)
}
func (s *Store) Processes(ctx context.Context, f ProcessFilter) ([]ProcessSummary, int, error) {
	const base = ` FROM jobs j JOIN account a ON a.id=j.record->>'account_id'
 LEFT JOIN LATERAL (SELECT count(*)::int AS events,count(*) FILTER(WHERE level='error')::int AS errors,count(*) FILTER(WHERE level='warning')::int AS warnings,max(created_at) AS latest FROM logs WHERE job_id=j.id) l ON true
 WHERE a.id=j.record->>'account_id'
 AND ($1='' OR j.record->>'title' ILIKE '%'||$1||'%' OR j.id ILIKE '%'||$1||'%' OR j.record->>'remote_id' ILIKE '%'||$1||'%' OR j.record->>'article_id' ILIKE '%'||$1||'%' OR (j.record->>'kind' IN ('check_account','sync_articles','sync_notes','sync_contents') AND a.display_name ILIKE '%'||$1||'%') OR EXISTS(SELECT 1 FROM logs x WHERE x.job_id=j.id AND x.message ILIKE '%'||$1||'%'))
 AND ($2='' OR j.record->>'status'=$2) AND ($3='' OR j.record->>'platform'=$3)
 AND ($4='' OR j.record->>'kind'=$4) AND ($5='' OR j.id=$5)
 AND ($6='' OR EXISTS(SELECT 1 FROM logs x WHERE x.job_id=j.id AND x.level=$6))
 AND greatest((j.record->>'updated_at')::timestamptz,coalesce(l.latest,j.created_at)) BETWEEN $7 AND $8`
	args := []any{f.Q, f.Status, f.Platform, f.Kind, f.JobID, f.Level, f.From, f.To}
	items := []ProcessSummary{}
	total := 0
	if err := s.pool.QueryRow(ctx, "SELECT count(*)"+base, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, f.Size, (f.Page-1)*f.Size)
	rows, err := s.pool.Query(ctx, "SELECT j.record-'markdown',a.display_name,l.events,l.errors,l.warnings"+base+" ORDER BY greatest((j.record->>'updated_at')::timestamptz,coalesce(l.latest,j.created_at)) DESC,j.id LIMIT $9 OFFSET $10", args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var p ProcessSummary
		if err = rows.Scan(&raw, &p.AccountName, &p.EventCount, &p.ErrorCount, &p.WarningCount); err != nil {
			return nil, 0, err
		}
		if err = json.Unmarshal(raw, &p.Job); err != nil {
			return nil, 0, err
		}
		p.ObjectType = "article"
		p.ObjectID = p.RemoteID
		p.ObjectName = p.Title
		if p.ObjectID == "" {
			p.ObjectID = p.ID
		}
		if p.Kind == "check_account" || p.Kind == "sync_articles" || p.Kind == "sync_notes" || p.Kind == "sync_contents" {
			p.ObjectType = "account"
			p.ObjectID = p.AccountID
			p.ObjectName = p.AccountName
		}
		if p.Kind == "read_article" || p.Kind == "read_note" || p.Kind == "read_content" {
			p.ObjectID = p.ArticleID
		}
		items = append(items, p)
	}
	return items, total, rows.Err()
}

const logColumns = "id,job_id,attempt,level,stage,message,created_at,status,outcome,run_mode"

func scanLogs(rows pgx.Rows) ([]Log, error) {
	defer rows.Close()
	items := []Log{}
	for rows.Next() {
		var l Log
		if err := rows.Scan(&l.ID, &l.JobID, &l.Attempt, &l.Level, &l.Stage, &l.Message, &l.CreatedAt, &l.Status, &l.Outcome, &l.RunMode); err != nil {
			return nil, err
		}
		items = append(items, l)
	}
	return items, rows.Err()
}
func (s *Store) History(ctx context.Context, id string, page, size int) ([]Log, int, []Log, error) {
	if _, err := s.Get(ctx, id); err != nil {
		return nil, 0, nil, err
	}
	var total int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM logs WHERE job_id=$1", id).Scan(&total); err != nil {
		return nil, 0, nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT "+logColumns+" FROM logs WHERE job_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3", id, size, (page-1)*size)
	if err != nil {
		return nil, 0, nil, err
	}
	items, err := scanLogs(rows)
	if err != nil {
		return nil, 0, nil, err
	}
	// 旧事件的状态保持空值；仅合并相邻相同状态，保留重新核对等状态往返。
	rows, err = s.pool.Query(ctx, "SELECT "+logColumns+" FROM (SELECT "+logColumns+",lag(attempt) OVER w AS previous_attempt,lag(status) OVER w AS previous_status,lag(stage) OVER w AS previous_stage,lag(run_mode) OVER w AS previous_run_mode,lag(outcome) OVER w AS previous_outcome FROM logs WHERE job_id=$1 WINDOW w AS (ORDER BY created_at,id)) events WHERE attempt IS DISTINCT FROM previous_attempt OR status IS DISTINCT FROM previous_status OR stage IS DISTINCT FROM previous_stage OR run_mode IS DISTINCT FROM previous_run_mode OR outcome IS DISTINCT FROM previous_outcome ORDER BY created_at,id", id)
	if err != nil {
		return nil, 0, nil, err
	}
	transitions, err := scanLogs(rows)
	return items, total, transitions, err
}
func (s *Store) Changes(ctx context.Context, id string, attempt int) (ProcessChanges, error) {
	result := ProcessChanges{Snapshots: []ProcessSnapshot{}, Attempts: []int{}}
	j, err := s.Get(ctx, id)
	if err != nil {
		return result, err
	}
	result.Submitted.Title = j.Title
	result.Submitted.Markdown = j.Markdown
	result.ContentRetained = j.Markdown != ""
	rows, err := s.pool.Query(ctx, "SELECT DISTINCT attempt FROM process_snapshots WHERE job_id=$1 ORDER BY attempt", id)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var a int
		if err = rows.Scan(&a); err != nil {
			rows.Close()
			return result, err
		}
		result.Attempts = append(result.Attempts, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if j.Kind == "check_account" {
		result.ContentRetained = len(result.Attempts) > 0
	}
	query := "SELECT id,attempt,phase,object_type,data,captured_at FROM process_snapshots WHERE job_id=$1 AND ($2=0 OR attempt=$2)"
	if attempt == 0 {
		query += " AND id IN (SELECT DISTINCT ON(phase) id FROM process_snapshots WHERE job_id=$1 ORDER BY phase,CASE WHEN phase='before' THEN attempt ELSE -attempt END,captured_at,id)"
	}
	query += " ORDER BY CASE phase WHEN 'before' THEN 0 ELSE 1 END,captured_at,id"
	rows, err = s.pool.Query(ctx, query, id, attempt)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var p ProcessSnapshot
		var data []byte
		if err = rows.Scan(&p.ID, &p.Attempt, &p.Phase, &p.ObjectType, &data, &p.CapturedAt); err != nil {
			return result, err
		}
		if err = json.Unmarshal(data, &p); err != nil {
			return result, err
		}
		result.Snapshots = append(result.Snapshots, p)
	}
	return result, rows.Err()
}
