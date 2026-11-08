package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type AccountIdentity struct {
	Username string `json:"username"`
	UserID   string `json:"user_id"`
}
type Note struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Status         string `json:"status"`
	PlatformStatus string `json:"platform_status"`
	PostedAt       string `json:"posted_at"`
	Views          *int64 `json:"views"`
	Likes          *int64 `json:"likes"`
	Comments       *int64 `json:"comments"`
	Favorites      *int64 `json:"favorites"`
}
type NotesSnapshot struct {
	Username string     `json:"username"`
	UserID   string     `json:"user_id"`
	Items    []Note     `json:"items"`
	SyncedAt *time.Time `json:"synced_at,omitempty"`
}
type NotePage struct {
	Items    []Note         `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
	Snapshot *NotesSnapshot `json:"snapshot"`
	SyncJob  *Job           `json:"sync_job"`
}

func validateNotes(snapshot *NotesSnapshot, username, userID string) error {
	if snapshot == nil || snapshot.Username != username || snapshot.UserID != userID || snapshot.Items == nil || len(snapshot.Items) > 2000 || snapshot.SyncedAt != nil {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, n := range snapshot.Items {
		if !xhsUserID.MatchString(n.ID) || seen[n.ID] || strings.TrimSpace(n.Title) == "" || !boundedText(n.Title, 2000) || !boundedText(n.PlatformStatus, 100) || !nullableMetrics(n.Views, n.Likes, n.Comments, n.Favorites) {
			return ErrInvalid
		}
		if n.Status != "published" && n.Status != "reviewing" && n.Status != "rejected" && n.Status != "unknown" {
			return ErrInvalid
		}
		if n.PostedAt != "" {
			if _, err := time.Parse(time.RFC3339, n.PostedAt); err != nil {
				return ErrInvalid
			}
		}
		seen[n.ID] = true
	}
	data, err := json.Marshal(snapshot)
	if err != nil || len(data) > 6<<20 {
		return ErrInvalid
	}
	return nil
}

func (s *Store) CreateAccountJob(ctx context.Context, accountID, kind, requestID string) (Job, bool, error) {
	if accountID == "csdn-main" && kind == "check_account" {
		return s.Create(ctx, CreateInput{RequestID: requestID, Kind: kind, Platform: "csdn"})
	}
	var out Job
	created := false
	if !validKey(accountID) || !validKey(requestID) || (kind != "check_account" && kind != "sync_notes") {
		return out, false, ErrInvalid
	}
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var platform, username, native string
		err := tx.QueryRow(ctx, "SELECT platform,username,native_user_id FROM account WHERE id=$1", accountID).Scan(&platform, &username, &native)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if platform != "xiaohongshu" {
			return ErrInvalid
		}
		input := CreateInput{RequestID: requestID, Kind: kind, Platform: platform, AccountID: accountID}
		fp := fingerprint(input)
		var hash string
		var data []byte
		err = tx.QueryRow(ctx, "SELECT fingerprint,record FROM jobs WHERE request_id=$1 UNION ALL SELECT a.fingerprint,j.record FROM article_read_requests a JOIN jobs j ON j.id=a.job_id WHERE a.request_id=$1", requestID).Scan(&hash, &data)
		if err == nil {
			var r record
			if json.Unmarshal(data, &r) != nil {
				return ErrInvalid
			}
			if hash != fp || r.AccountID != accountID || r.AccountUsername != username || r.AccountNativeID != native {
				return ErrConflict
			}
			out = r.Job
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if kind == "sync_notes" {
			err = tx.QueryRow(ctx, "SELECT record FROM jobs WHERE record->>'account_id'=$1 AND record->>'kind'=$2 AND record->>'account_username'=$3 AND record->>'status' IN ('queued','running','waiting_user') ORDER BY created_at DESC,id DESC LIMIT 1", accountID, kind, username).Scan(&data)
			if err == nil {
				var r record
				if json.Unmarshal(data, &r) != nil {
					return ErrInvalid
				}
				if r.AccountNativeID != native {
					return ErrConflict
				}
				if _, err = tx.Exec(ctx, "INSERT INTO article_read_requests(request_id,fingerprint,job_id) VALUES($1,$2,$3)", requestID, fp, r.ID); err != nil {
					return err
				}
				out = r.Job
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		r := newRecord(input, now)
		r.Platform = platform
		r.AccountID = accountID
		r.AccountUsername = username
		r.AccountNativeID = native
		data, err = json.Marshal(r)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)", r.ID, requestID, fp, data, now); err != nil {
			return err
		}
		out = r.Job
		created = true
		return appendLog(ctx, tx, r, "info", "只读任务已加入队列", now)
	})
	return out, created, err
}

func (s *Store) acceptNotesResult(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, now time.Time) error {
	if in.Articles != nil || in.Article != nil || in.RemoteID != "" || in.PublishAccepted || in.Status == "reconciling" || r.ExternalStarted || r.RunMode != "execute" {
		return ErrInvalid
	}
	if r.Kind != "check_account" && r.Kind != "sync_notes" {
		return ErrInvalid
	}
	if in.Status != "succeeded" {
		if in.Notes != nil || in.AccountIdentity != nil {
			return ErrInvalid
		}
		return nil
	}
	var username, native string
	if err := tx.QueryRow(ctx, "SELECT username,native_user_id FROM account WHERE id=$1 AND platform='xiaohongshu'", r.AccountID).Scan(&username, &native); err != nil {
		return err
	}
	if username != r.AccountUsername || native != r.AccountNativeID {
		return ErrConflict
	}
	if in.AccountIdentity == nil || in.AccountIdentity.Username != username || in.AccountIdentity.UserID != native {
		return ErrInvalid
	}
	if r.Kind == "check_account" {
		if r.Stage != "checking_login" {
			return ErrConflict
		}
		if in.Notes != nil {
			return ErrInvalid
		}
		return nil
	}
	if validateNotes(in.Notes, username, native) != nil {
		return ErrInvalid
	}
	snapshot := *in.Notes
	snapshot.SyncedAt = &now
	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO account_note_snapshots(account_id,record) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET record=excluded.record", r.AccountID, data)
	return err
}

func (s *Store) Notes(ctx context.Context, accountID, q, status string, page, size int) (NotePage, error) {
	out := NotePage{Items: []Note{}, Page: page, PageSize: size}
	if page < 1 || page > 1000000 || size < 1 || size > 100 || !boundedText(q, 200) || status != "" && status != "published" && status != "reviewing" && status != "rejected" && status != "unknown" {
		return out, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var platform, username, native string
	err = tx.QueryRow(ctx, "SELECT platform,username,native_user_id FROM account WHERE id=$1", accountID).Scan(&platform, &username, &native)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if platform != "xiaohongshu" {
		return out, ErrInvalid
	}
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT record FROM account_note_snapshots WHERE account_id=$1", accountID).Scan(&raw)
	if err == nil {
		var snapshot NotesSnapshot
		if json.Unmarshal(raw, &snapshot) != nil {
			return out, ErrInvalid
		}
		if snapshot.Username == username && snapshot.UserID == native {
			filtered := []Note{}
			for _, n := range snapshot.Items {
				if (status == "" || n.Status == status) && (q == "" || strings.Contains(strings.ToLower(n.Title), strings.ToLower(q)) || n.ID == q) {
					filtered = append(filtered, n)
				}
			}
			out.Total = len(filtered)
			start := (page - 1) * size
			if start < len(filtered) {
				end := start + size
				if end > len(filtered) {
					end = len(filtered)
				}
				out.Items = filtered[start:end]
			}
			snapshot.Items = nil
			out.Snapshot = &snapshot
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	err = tx.QueryRow(ctx, "SELECT record FROM jobs WHERE record->>'account_id'=$1 AND record->>'kind'='sync_notes' AND record->>'account_username'=$2 AND record->>'account_native_id'=$3 ORDER BY created_at DESC,id DESC LIMIT 1", accountID, username, native).Scan(&raw)
	if err == nil {
		var r record
		if json.Unmarshal(raw, &r) != nil {
			return out, ErrInvalid
		}
		out.SyncJob = &r.Job
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	return out, tx.Commit(ctx)
}
