package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) acceptArticleResult(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, now time.Time) error {
	if r.Platform == "xiaohongshu" {
		return s.acceptNotesResult(ctx, tx, r, in, now)
	}
	if in.Notes != nil || in.Note != nil || in.AccountIdentity != nil {
		return ErrInvalid
	}
	if !readKind(r.Kind) {
		if in.Articles != nil || in.Article != nil {
			return ErrInvalid
		}
		return nil
	}
	if in.RemoteID != "" || r.ExternalStarted || r.RunMode != "execute" {
		return ErrInvalid
	}
	if in.Status != "succeeded" {
		if in.Articles != nil || in.Article != nil {
			return ErrInvalid
		}
		return nil
	}
	var username string
	if err := tx.QueryRow(ctx, "SELECT username FROM account WHERE id=pb_account()").Scan(&username); err != nil {
		return err
	}
	if username != r.AccountUsername {
		return ErrConflict
	}
	if r.Kind == "sync_articles" {
		if in.Article != nil || validateArticles(in.Articles, username) != nil {
			return ErrInvalid
		}
		snapshot := in.Articles
		info := ArticleSnapshotInfo{
			Username: username,
			Profile:  snapshot.Profile,
			Counts:   snapshot.Counts,
			Stats:    snapshot.Stats,
			Trend:    snapshot.Trend,
			SyncedAt: now,
		}
		if info.Trend == nil {
			info.Trend = []ArticleTrend{}
		}
		data, err := json.Marshal(info)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO account_article_snapshots(account_id,username,record,synced_at) VALUES(pb_account(),$1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET username=excluded.username,record=excluded.record,synced_at=excluded.synced_at", username, data, now); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM account_articles WHERE account_id=pb_account()"); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM account_article_bodies WHERE account_id=pb_account()"); err != nil {
			return err
		}
		batch := &pgx.Batch{}
		for _, item := range snapshot.Items {
			data, err = json.Marshal(item)
			if err != nil {
				return err
			}
			batch.Queue("INSERT INTO account_articles(account_id,username,id,record) VALUES(pb_account(),$1,$2,$3)", username, item.ID, data)
		}
		results := tx.SendBatch(ctx, batch)
		if err = results.Close(); err != nil {
			return err
		}
		return nil
	}
	if in.Articles != nil || validateArticleBody(in.Article, r.ArticleID) != nil {
		return ErrInvalid
	}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM account_articles WHERE account_id=pb_account() AND username=$1 AND id=$2)", username, r.ArticleID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrConflict
	}
	body := *in.Article
	if body.Tags == nil {
		body.Tags = []string{}
	}
	if body.Categories == nil {
		body.Categories = []string{}
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO account_article_bodies(account_id,username,id,record,fetched_at) VALUES(pb_account(),$1,$2,$3,$4) ON CONFLICT(account_id,id) DO UPDATE SET username=excluded.username,record=excluded.record,fetched_at=excluded.fetched_at", username, r.ArticleID, data, now)
	return err
}
func latestArticleJob(ctx context.Context, tx pgx.Tx, username, kind, id string) (*Job, error) {
	var data []byte
	err := tx.QueryRow(ctx, "SELECT record FROM jobs WHERE record->>'account_id'=pb_account() AND record->>'kind'=$1 AND record->>'account_username'=$2 AND COALESCE(record->>'article_id','')=$3 ORDER BY created_at DESC,id DESC LIMIT 1", kind, username, id).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r record
	if err = json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	r.Markdown = ""
	return &r.Job, nil
}
func currentArticleAccount(ctx context.Context, tx pgx.Tx) (string, error) {
	var username string
	err := tx.QueryRow(ctx, "SELECT username FROM account WHERE id=pb_account()").Scan(&username)
	return username, err
}
func (s *Store) Articles(ctx context.Context, q, status string, page, size int) (ArticlePage, error) {
	result := ArticlePage{Items: []Article{}, Page: page, PageSize: size}
	if page < 1 || page > 1000000 || size < 1 || size > 100 || len(q) > 200 || (status != "" && !validArticleStatus(status)) {
		return result, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	username, err := currentArticleAccount(ctx, tx)
	if err != nil {
		return result, err
	}
	var data []byte
	err = tx.QueryRow(ctx, "SELECT record FROM account_article_snapshots WHERE account_id=pb_account() AND username=$1", username).Scan(&data)
	if err == nil {
		var info ArticleSnapshotInfo
		if err = json.Unmarshal(data, &info); err != nil {
			return result, err
		}
		result.Snapshot = &info
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if result.SyncJob, err = latestArticleJob(ctx, tx, username, "sync_articles", ""); err != nil {
		return result, err
	}
	where := " FROM account_articles WHERE account_id=pb_account() AND username=$1 AND ($2='' OR strpos(lower(record->>'title'),lower($2))>0 OR id=$2) AND ($3='' OR record->>'status'=$3)"
	if err = tx.QueryRow(ctx, "SELECT count(*)"+where, username, q, status).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, "SELECT record"+where+" ORDER BY COALESCE(NULLIF(record->>'posted_at','')::timestamptz,'epoch'::timestamptz) DESC,id DESC LIMIT $4 OFFSET $5", username, q, status, size, (page-1)*size)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var data []byte
		var item Article
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return result, err
		}
		if err = json.Unmarshal(data, &item); err != nil {
			rows.Close()
			return result, err
		}
		articleLinks(&item, username)
		result.Items = append(result.Items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}
func (s *Store) Article(ctx context.Context, id string) (ArticleDetail, error) {
	var result ArticleDetail
	if !numericID.MatchString(id) {
		return result, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	username, err := currentArticleAccount(ctx, tx)
	if err != nil {
		return result, err
	}
	var data []byte
	err = tx.QueryRow(ctx, "SELECT record FROM account_articles WHERE account_id=pb_account() AND username=$1 AND id=$2", username, id).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(data, &result.Article); err != nil {
		return result, err
	}
	articleLinks(&result.Article, username)
	var fetchedAt time.Time
	err = tx.QueryRow(ctx, "SELECT record,fetched_at FROM account_article_bodies WHERE account_id=pb_account() AND username=$1 AND id=$2 AND fetched_at >= $3", username, id, s.now().Add(-30*24*time.Hour)).Scan(&data, &fetchedAt)
	if err == nil {
		var body ArticleBody
		if err = json.Unmarshal(data, &body); err != nil {
			return result, err
		}
		result.Body = &body
		result.FetchedAt = &fetchedAt
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if result.ReadJob, err = latestArticleJob(ctx, tx, username, "read_article", id); err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}
