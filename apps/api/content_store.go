package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

type ContentSnapshotInfo struct {
	Identity   ContentIdentity `json:"identity"`
	Scope      string          `json:"scope"`
	Complete   bool            `json:"complete"`
	Extensions json.RawMessage `json:"extensions"`
	SyncedAt   time.Time       `json:"synced_at"`
}
type ContentPage struct {
	Items    []ContentItem        `json:"items"`
	Total    int                  `json:"total"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"page_size"`
	Snapshot *ContentSnapshotInfo `json:"snapshot"`
	SyncJob  *Job                 `json:"sync_job"`
}
type ContentDetail struct {
	Platform  string       `json:"platform"`
	Item      ContentItem  `json:"item"`
	Body      *ContentBody `json:"body"`
	FetchedAt *time.Time   `json:"fetched_at"`
	ReadJob   *Job         `json:"read_job"`
}

func (s *Store) contentAccount(ctx context.Context, tx pgx.Tx, id string) (contentAdapter, ContentIdentity, error) {
	var platform string
	var identity ContentIdentity
	err := tx.QueryRow(ctx, "SELECT platform,username,native_user_id FROM account WHERE id=$1", id).Scan(&platform, &identity.Username, &identity.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		return contentAdapter{}, identity, err
	}
	a, err := s.contentRegistry().get(platform)
	return a, identity, err
}

func saveContentSnapshot(ctx context.Context, tx pgx.Tx, account string, a contentAdapter, snapshot *ContentSnapshot, now time.Time) error {
	if snapshot.Complete {
		if _, err := tx.Exec(ctx, "DELETE FROM contents WHERE account_id=$1", account); err != nil {
			return err
		}
		if a.InvalidateBodyOnSync {
			if _, err := tx.Exec(ctx, "DELETE FROM content_bodies WHERE account_id=$1", account); err != nil {
				return err
			}
		}
	}
	for _, item := range snapshot.Items {
		raw, err := json.Marshal(item)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO contents(account_id,id,record) VALUES($1,$2,$3) ON CONFLICT(account_id,id) DO UPDATE SET record=excluded.record", account, item.ID, raw); err != nil {
			return err
		}
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM contents WHERE account_id=$1", account).Scan(&count); err != nil {
		return err
	}
	if count > 2000 {
		return ErrInvalid
	}
	info := ContentSnapshotInfo{snapshot.Identity, snapshot.Scope, snapshot.Complete, snapshot.Extensions, now}
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO content_snapshots(account_id,platform,username,native_user_id,record,synced_at) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(account_id) DO UPDATE SET platform=excluded.platform,username=excluded.username,native_user_id=excluded.native_user_id,record=excluded.record,synced_at=excluded.synced_at`, account, a.ID, snapshot.Identity.Username, snapshot.Identity.UserID, raw, now)
	return err
}

func saveContentBody(ctx context.Context, tx pgx.Tx, account string, identity ContentIdentity, body *ContentBody, now time.Time) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO content_bodies(account_id,id,username,native_user_id,record,fetched_at) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(account_id,id) DO UPDATE SET username=excluded.username,native_user_id=excluded.native_user_id,record=excluded.record,fetched_at=excluded.fetched_at`, account, body.ID, identity.Username, identity.UserID, raw, now)
	return err
}

func (s *Store) ensureContentProjection(ctx context.Context, tx pgx.Tx, account string, a contentAdapter) error {
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM content_snapshots WHERE account_id=$1)", account).Scan(&exists); err != nil {
		return err
	}
	if !exists && a.Backfill != nil {
		return a.Backfill(ctx, tx, account)
	}
	return nil
}

func (s *Store) prepareContents(ctx context.Context, account string) error {
	scope := scopeOf(ctx)
	scope.AccountID = account
	ctx = scoped(ctx, scope)
	return s.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		a, _, err := s.contentAccount(ctx, tx, account)
		if err != nil {
			return err
		}
		return s.ensureContentProjection(ctx, tx, account, a)
	})
}

func currentContent(ctx context.Context, tx pgx.Tx, account, id string, identity ContentIdentity) (ContentItem, error) {
	var item ContentItem
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT c.record FROM contents c JOIN content_snapshots s ON s.account_id=c.account_id
 WHERE c.account_id=$1 AND c.id=$2 AND s.username=$3 AND s.native_user_id=$4`, account, id, identity.Username, identity.UserID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	err = json.Unmarshal(raw, &item)
	return item, err
}

func latestContentJob(ctx context.Context, tx pgx.Tx, account, kind, id string, identity ContentIdentity) (*Job, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT record FROM jobs WHERE account_id=$1 AND record->>'kind'=$2
 AND COALESCE(record->>'article_id','')=$3 AND record->>'account_username'=$4
 AND COALESCE(record->>'account_native_id','')=$5 ORDER BY created_at DESC,id DESC LIMIT 1`, account, kind, id, identity.Username, identity.UserID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r record
	if err = json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	r.Markdown = ""
	return &r.Job, nil
}

func (s *Store) Contents(ctx context.Context, account, q, status string, page, size int) (ContentPage, error) {
	out := ContentPage{Items: []ContentItem{}, Page: page, PageSize: size}
	if !validKey(account) || !boundedText(q, 200) || page < 1 || page > 1000000 || size < 1 || size > 100 || status != "" && !slices.Contains(contentStatuses, status) {
		return out, ErrInvalid
	}
	if err := s.prepareContents(ctx, account); err != nil {
		return out, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	a, identity, err := s.contentAccount(ctx, tx, account)
	if err != nil {
		return out, err
	}
	if !a.supports("list") {
		return out, ErrInvalid
	}
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT record FROM content_snapshots WHERE account_id=$1 AND username=$2 AND native_user_id=$3", account, identity.Username, identity.UserID).Scan(&raw)
	if err == nil {
		if err = json.Unmarshal(raw, &out.Snapshot); err != nil {
			return out, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	where := ` FROM contents c JOIN content_snapshots s ON s.account_id=c.account_id WHERE c.account_id=$1 AND s.username=$2 AND s.native_user_id=$3
 AND ($4='' OR strpos(lower(c.record->>'title'),lower($4))>0 OR c.id=$4) AND ($5='' OR c.record->>'status'=$5)`
	args := []any{account, identity.Username, identity.UserID, q, status}
	if err = tx.QueryRow(ctx, "SELECT count(*)"+where, args...).Scan(&out.Total); err != nil {
		return out, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := tx.Query(ctx, "SELECT c.record"+where+" ORDER BY COALESCE(NULLIF(c.record->>'posted_at','')::timestamptz,'epoch'::timestamptz) DESC,c.id DESC LIMIT $6 OFFSET $7", args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item ContentItem
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal(raw, &item); err != nil {
			break
		}
		out.Items = append(out.Items, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return out, err
	}
	out.SyncJob, err = latestContentJob(ctx, tx, account, a.SyncJob, "", identity)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) Content(ctx context.Context, account, id string) (ContentDetail, error) {
	var out ContentDetail
	if !validKey(account) {
		return out, ErrInvalid
	}
	if err := s.prepareContents(ctx, account); err != nil {
		return out, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	a, identity, err := s.contentAccount(ctx, tx, account)
	if err != nil {
		return out, err
	}
	if !a.validID(id) {
		return out, ErrInvalid
	}
	out.Platform = a.ID
	out.Item, err = currentContent(ctx, tx, account, id, identity)
	if err != nil {
		return out, err
	}
	var raw []byte
	var fetched time.Time
	cutoff := time.Unix(0, 0)
	if a.BodyTTLSeconds > 0 {
		cutoff = s.now().Add(-time.Duration(a.BodyTTLSeconds) * time.Second)
	}
	err = tx.QueryRow(ctx, "SELECT record,fetched_at FROM content_bodies WHERE account_id=$1 AND id=$2 AND username=$3 AND native_user_id=$4 AND fetched_at >= $5", account, id, identity.Username, identity.UserID, cutoff).Scan(&raw, &fetched)
	if err == nil {
		if err = json.Unmarshal(raw, &out.Body); err != nil {
			return out, err
		}
		out.FetchedAt = &fetched
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	out.ReadJob, err = latestContentJob(ctx, tx, account, a.ReadJob, id, identity)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
