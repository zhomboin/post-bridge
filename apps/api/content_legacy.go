package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func contentExtension(platform string, value any) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{platform: value})
	return raw
}
func contentMetrics(value any, names ...string) map[string]ContentMetric {
	raw, _ := json.Marshal(value)
	var values map[string]json.RawMessage
	_ = json.Unmarshal(raw, &values)
	metrics := map[string]ContentMetric{}
	for _, name := range names {
		var number *float64
		if v := values[name]; len(v) > 0 {
			_ = json.Unmarshal(v, &number)
		}
		metrics[name] = ContentMetric{Value: number, Unit: "count"}
	}
	return metrics
}
func articleContent(a Article, username string) ContentItem {
	articleLinks(&a, username)
	return ContentItem{ID: a.ID, Title: a.Title, Status: a.Status, PlatformStatus: a.PlatformStatus, PostedAt: a.PostedAt, Kind: "article", CoverURLs: a.CoverURLs, Metrics: contentMetrics(a, "views", "likes", "comments", "favorites", "exposures", "gained_fans"), Extensions: contentExtension("csdn", a)}
}
func noteContent(n Note) ContentItem {
	kind := n.Type
	if kind == "" {
		kind = "unknown"
	}
	covers := n.CoverURLs
	if covers == nil {
		covers = []string{}
	}
	return ContentItem{ID: n.ID, Title: n.Title, Status: n.Status, PlatformStatus: n.PlatformStatus, PostedAt: n.PostedAt, Kind: kind, CoverURLs: covers, Metrics: contentMetrics(n, "views", "likes", "comments", "favorites", "shares"), Extensions: contentExtension("xiaohongshu", n)}
}
func articleContentBody(b ArticleBody) *ContentBody {
	if b.Tags == nil {
		b.Tags = []string{}
	}
	if b.Categories == nil {
		b.Categories = []string{}
	}
	return &ContentBody{ID: b.ID, Format: "markdown", Text: b.Markdown, HTML: b.HTML, Images: []string{}, Tags: b.Tags, Extensions: contentExtension("csdn", b)}
}
func noteContentBody(b NoteBody) *ContentBody {
	return &ContentBody{ID: b.ID, Format: "text", Text: b.Text, Images: b.Images, Tags: b.Tags, Extensions: contentExtension("xiaohongshu", b)}
}

func (s *Store) projectArticles(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, now time.Time) error {
	if in.Articles != nil {
		v := in.Articles
		items := make([]ContentItem, 0, len(v.Items))
		for _, item := range v.Items {
			items = append(items, articleContent(item, v.Username))
		}
		info := ArticleSnapshotInfo{Username: v.Username, Profile: v.Profile, Counts: v.Counts, Stats: v.Stats, Trend: v.Trend, SyncedAt: now}
		if info.Trend == nil {
			info.Trend = []ArticleTrend{}
		}
		a, _ := s.contentRegistry().get(r.Platform)
		return saveContentSnapshot(ctx, tx, r.AccountID, a, &ContentSnapshot{Identity: ContentIdentity{Username: v.Username}, Scope: "all", Complete: true, Items: items, Extensions: contentExtension(r.Platform, info)}, now)
	}
	if in.Article != nil {
		return saveContentBody(ctx, tx, r.AccountID, ContentIdentity{Username: r.AccountUsername}, articleContentBody(*in.Article), now)
	}
	return nil
}
func (s *Store) projectNotes(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, now time.Time) error {
	if in.Notes != nil {
		v := *in.Notes
		items := make([]ContentItem, 0, len(v.Items))
		for _, item := range v.Items {
			items = append(items, noteContent(item))
		}
		v.Items = nil
		v.SyncedAt = &now
		a, _ := s.contentRegistry().get(r.Platform)
		return saveContentSnapshot(ctx, tx, r.AccountID, a, &ContentSnapshot{Identity: ContentIdentity{Username: v.Username, UserID: v.UserID}, Scope: "all", Complete: true, Items: items, Extensions: contentExtension(r.Platform, v)}, now)
	}
	if in.Note != nil {
		return saveContentBody(ctx, tx, r.AccountID, ContentIdentity{Username: r.AccountUsername, UserID: r.AccountNativeID}, noteContentBody(*in.Note), now)
	}
	return nil
}

// 首次使用公共接口时在账号事务内补齐投影，不改动已有平台数据与采集时间。
func (s *Store) backfillArticles(ctx context.Context, tx pgx.Tx, account string) error {
	var raw []byte
	var username string
	err := tx.QueryRow(ctx, `SELECT s.record,a.username FROM account_article_snapshots s JOIN account a ON a.id=s.account_id AND a.username=s.username WHERE s.account_id=$1`, account).Scan(&raw, &username)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var info ArticleSnapshotInfo
	if err = json.Unmarshal(raw, &info); err != nil {
		return err
	}
	items := []Article{}
	rows, err := tx.Query(ctx, "SELECT record FROM account_articles WHERE account_id=$1 AND username=$2", account, username)
	if err != nil {
		return err
	}
	for rows.Next() {
		var a Article
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			break
		}
		items = append(items, a)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	r := &record{Job: Job{Platform: "csdn", AccountID: account, AccountUsername: username}}
	if err = s.projectArticles(ctx, tx, r, CompleteInput{Articles: &ArticleSnapshot{Username: username, Profile: info.Profile, Counts: info.Counts, Stats: info.Stats, Trend: info.Trend, Items: items}}, info.SyncedAt); err != nil {
		return err
	}
	return s.backfillContentBodies(ctx, tx, r, "account_article_bodies")
}
func (s *Store) backfillNotes(ctx context.Context, tx pgx.Tx, account string) error {
	var raw []byte
	var identity ContentIdentity
	err := tx.QueryRow(ctx, `SELECT s.record,a.username,a.native_user_id FROM account_note_snapshots s JOIN account a ON a.id=s.account_id WHERE s.account_id=$1`, account).Scan(&raw, &identity.Username, &identity.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var snapshot NotesSnapshot
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	if snapshot.Username != identity.Username || snapshot.UserID != identity.UserID {
		return nil
	}
	r := &record{Job: Job{Platform: "xiaohongshu", AccountID: account, AccountUsername: identity.Username, AccountNativeID: identity.UserID}}
	if snapshot.SyncedAt == nil {
		return ErrInvalid
	}
	if err = s.projectNotes(ctx, tx, r, CompleteInput{Notes: &snapshot}, *snapshot.SyncedAt); err != nil {
		return err
	}
	return s.backfillContentBodies(ctx, tx, r, "account_note_bodies")
}
func (s *Store) backfillContentBodies(ctx context.Context, tx pgx.Tx, r *record, table string) error {
	query := "SELECT record,fetched_at FROM account_article_bodies WHERE account_id=$1 AND username=$2"
	args := []any{r.AccountID, r.AccountUsername}
	if table == "account_note_bodies" {
		query = "SELECT record,fetched_at FROM account_note_bodies WHERE account_id=$1 AND username=$2 AND native_user_id=$3"
		args = append(args, r.AccountNativeID)
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	type saved struct {
		body *ContentBody
		at   time.Time
	}
	bodies := []saved{}
	for rows.Next() {
		var raw []byte
		var at time.Time
		if err = rows.Scan(&raw, &at); err != nil {
			break
		}
		if table == "account_note_bodies" {
			var b NoteBody
			if err = json.Unmarshal(raw, &b); err != nil {
				break
			}
			bodies = append(bodies, saved{noteContentBody(b), at})
		} else {
			var b ArticleBody
			if err = json.Unmarshal(raw, &b); err != nil {
				break
			}
			bodies = append(bodies, saved{articleContentBody(b), at})
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, saved := range bodies {
		if err = saveContentBody(ctx, tx, r.AccountID, ContentIdentity{Username: r.AccountUsername, UserID: r.AccountNativeID}, saved.body, saved.at); err != nil {
			return err
		}
	}
	return nil
}
