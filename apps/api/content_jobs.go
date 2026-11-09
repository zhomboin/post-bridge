package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) CreateContentJob(ctx context.Context, account, operation, id, request string) (Job, bool, error) {
	var platform string
	if err := s.pool.QueryRow(ctx, "SELECT platform FROM account WHERE id=$1", account).Scan(&platform); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			err = ErrNotFound
		}
		return Job{}, false, err
	}
	a, err := s.contentRegistry().get(platform)
	if err != nil {
		return Job{}, false, err
	}
	kind := a.SyncJob
	switch operation {
	case "list":
		if !a.supports("list") {
			return Job{}, false, ErrInvalid
		}
	case "body":
		if !a.supports("body") {
			return Job{}, false, ErrInvalid
		}
		kind = a.ReadJob
	default:
		return Job{}, false, ErrInvalid
	}
	return s.createReadJob(ctx, account, CreateInput{AccountID: account, Platform: platform, Kind: kind, ArticleID: id, RequestID: request})
}

func (s *Store) createReadJob(ctx context.Context, account string, in CreateInput) (Job, bool, error) {
	var out Job
	created := false
	if !validKey(account) || !validKey(in.RequestID) || in.Title != "" || in.Markdown != "" {
		return out, false, ErrInvalid
	}
	scope := scopeOf(ctx)
	scope.AccountID = account
	ctx = scoped(ctx, scope)
	if err := s.executableAccount(ctx, account); err != nil {
		return out, false, err
	}
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		var verified bool
		var version int64
		if err := tx.QueryRow(ctx, "SELECT verified,connection_version FROM account WHERE id=$1 FOR SHARE", account).Scan(&verified, &version); err != nil {
			return err
		}
		if !verified {
			return ErrConflict
		}
		a, identity, err := s.contentAccount(ctx, tx, account)
		if err != nil {
			return err
		}
		if in.Platform != a.ID || !a.identity(identity.Username, identity.UserID) {
			return ErrInvalid
		}
		if in.Kind == "check_account" && !a.supports("check_account") {
			return ErrInvalid
		}
		syncing := in.Kind == a.SyncJob
		reading := in.Kind == a.ReadJob
		if in.Kind != "check_account" && (!syncing && !reading || syncing && !a.supports("list") || reading && !a.supports("body")) {
			return ErrInvalid
		}
		if reading && !a.validID(in.ArticleID) || !reading && in.ArticleID != "" {
			return ErrInvalid
		}
		legacyInput := in
		legacyInput.AccountID = ""
		in.AccountID = account
		fp := fingerprint(in)
		var hash string
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT fingerprint,record FROM jobs WHERE request_id=$1 AND request_namespace=pb_caller()
 UNION ALL SELECT a.fingerprint,j.record FROM article_read_requests a JOIN jobs j ON j.id=a.job_id WHERE a.request_id=$1 AND a.request_namespace=pb_caller()`, in.RequestID).Scan(&hash, &raw)
		if err == nil {
			var r record
			if json.Unmarshal(raw, &r) != nil {
				return ErrInvalid
			}
			if (hash != fp && hash != fingerprint(legacyInput)) || r.AccountID != account || r.Platform != a.ID || r.AccountUsername != identity.Username || r.AccountNativeID != identity.UserID || r.ConnectionVersion != version {
				return ErrConflict
			}
			out = r.Job
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if syncing || reading {
			err = tx.QueryRow(ctx, `SELECT record FROM jobs WHERE account_id=$1 AND record->>'kind'=$2 AND record->>'account_username'=$3
 AND COALESCE(record->>'article_id','')=$4 AND connection_version=$5 AND record->>'status' IN ('queued','running','waiting_user') ORDER BY created_at DESC,id DESC LIMIT 1`, account, in.Kind, identity.Username, in.ArticleID, version).Scan(&raw)
			if err == nil {
				var r record
				if json.Unmarshal(raw, &r) != nil {
					return ErrInvalid
				}
				if r.AccountNativeID != identity.UserID {
					return ErrConflict
				}
				if _, err = tx.Exec(ctx, "INSERT INTO article_read_requests(request_id,fingerprint,job_id) VALUES($1,$2,$3)", in.RequestID, fp, r.ID); err != nil {
					return err
				}
				out = r.Job
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		var title string
		if reading {
			if err = s.ensureContentProjection(ctx, tx, account, a); err != nil {
				return err
			}
			item, err := currentContent(ctx, tx, account, in.ArticleID, identity)
			if err != nil {
				return err
			}
			if !a.canRead(item.Status) {
				return ErrConflict
			}
			title = item.Title
		}
		r := newRecord(in, now)
		r.Platform = a.ID
		r.AccountID = account
		r.AccountUsername = identity.Username
		r.AccountNativeID = identity.UserID
		r.Title = title
		raw, err = json.Marshal(r)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)", r.ID, in.RequestID, fp, raw, now); err != nil {
			return err
		}
		out = r.Job
		created = true
		return appendLog(ctx, tx, r, "info", "只读任务已加入队列", now)
	})
	if err == nil && created {
		out, err = s.Get(ctx, out.ID)
	}
	return out, created, err
}

func (s *Store) acceptContentResult(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, now time.Time) error {
	a, err := s.contentRegistry().get(r.Platform)
	if err != nil {
		return err
	}
	if a.AcceptLegacy != nil {
		if in.Contents != nil || in.Content != nil || in.ContentIdentity != nil {
			return ErrInvalid
		}
		if err = a.AcceptLegacy(ctx, tx, r, in, now); err != nil {
			return err
		}
		if in.Status == "succeeded" && a.ProjectLegacy != nil {
			return a.ProjectLegacy(ctx, tx, r, in, now)
		}
		return nil
	}
	if in.Articles != nil || in.Article != nil || in.Notes != nil || in.Note != nil || in.AccountIdentity != nil {
		return ErrInvalid
	}
	if r.Kind != "check_account" && (!readKind(r.Kind) || r.Kind != a.SyncJob && r.Kind != a.ReadJob) {
		return ErrInvalid
	}
	if in.RemoteID != "" || in.PublishAccepted || r.ExternalStarted || r.RunMode != "execute" || in.Status == "reconciling" {
		return ErrInvalid
	}
	if in.Status != "succeeded" {
		if in.Contents != nil || in.Content != nil || in.ContentIdentity != nil {
			return ErrInvalid
		}
		return nil
	}
	_, identity, err := s.contentAccount(ctx, tx, r.AccountID)
	if err != nil {
		return err
	}
	if identity.Username != r.AccountUsername || identity.UserID != r.AccountNativeID {
		return ErrConflict
	}
	if in.ContentIdentity == nil || *in.ContentIdentity != identity {
		return ErrInvalid
	}
	if r.Kind == "check_account" {
		if !a.supports("check_account") || r.Stage != "checking_login" || in.Contents != nil || in.Content != nil {
			return ErrInvalid
		}
		return nil
	}
	if r.Kind == a.SyncJob {
		if !a.supports("list") {
			return ErrInvalid
		}
		if in.Content != nil || a.validateSnapshot(in.Contents, identity) != nil {
			return ErrInvalid
		}
		return saveContentSnapshot(ctx, tx, r.AccountID, a, in.Contents, now)
	}
	if !a.supports("body") || in.Contents != nil || a.validateContentBody(in.Content, r.ArticleID) != nil {
		return ErrInvalid
	}
	item, err := currentContent(ctx, tx, r.AccountID, r.ArticleID, identity)
	if err != nil || !a.canRead(item.Status) {
		return ErrConflict
	}
	return saveContentBody(ctx, tx, r.AccountID, identity, in.Content, now)
}
