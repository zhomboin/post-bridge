package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type NoteBody struct {
	ID     string   `json:"id"`
	UserID string   `json:"user_id"`
	Title  string   `json:"title"`
	Text   string   `json:"text"`
	Images []string `json:"images"`
	Tags   []string `json:"tags"`
}
type NoteDetail struct {
	Note      Note       `json:"note"`
	Body      *NoteBody  `json:"body"`
	FetchedAt *time.Time `json:"fetched_at"`
	ReadJob   *Job       `json:"read_job"`
}

func currentNote(ctx context.Context, tx pgx.Tx, accountID, id, username, native string) (*Note, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, "SELECT record FROM account_note_snapshots WHERE account_id=$1", accountID).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var snapshot NotesSnapshot
	if json.Unmarshal(raw, &snapshot) != nil {
		return nil, ErrInvalid
	}
	if snapshot.Username != username || snapshot.UserID != native {
		return nil, ErrNotFound
	}
	for _, n := range snapshot.Items {
		if n.ID == id {
			return &n, nil
		}
	}
	return nil, ErrNotFound
}
func validateNoteBody(body *NoteBody, id, native string) error {
	if body == nil || body.ID != id || body.UserID != native || !boundedText(body.Title, 8000) || !boundedText(body.Text, 800000) || body.Images == nil || len(body.Images) > 50 || body.Tags == nil || len(body.Tags) > 100 {
		return ErrInvalid
	}
	for _, image := range body.Images {
		if image == "" || !safeNoteImage(image) {
			return ErrInvalid
		}
	}
	for _, tag := range body.Tags {
		if !boundedText(tag, 800) {
			return ErrInvalid
		}
	}
	return nil
}
func (s *Store) acceptNoteBody(ctx context.Context, tx pgx.Tx, r *record, in CompleteInput, username, native string, now time.Time) error {
	if in.Notes != nil || validateNoteBody(in.Note, r.ArticleID, native) != nil {
		return ErrInvalid
	}
	if _, err := currentNote(ctx, tx, r.AccountID, r.ArticleID, username, native); err != nil {
		return ErrConflict
	}
	data, err := json.Marshal(in.Note)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO account_note_bodies(account_id,id,username,native_user_id,record,fetched_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,id) DO UPDATE SET username=excluded.username,native_user_id=excluded.native_user_id,record=excluded.record,fetched_at=excluded.fetched_at", r.AccountID, r.ArticleID, username, native, data, now)
	return err
}
func (s *Store) Note(ctx context.Context, accountID, id string) (NoteDetail, error) {
	var out NoteDetail
	if !validKey(accountID) || !xhsUserID.MatchString(id) {
		return out, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	var username, native string
	err = tx.QueryRow(ctx, "SELECT username,native_user_id FROM account WHERE id=$1 AND platform='xiaohongshu'", accountID).Scan(&username, &native)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	note, err := currentNote(ctx, tx, accountID, id, username, native)
	if err != nil {
		return out, err
	}
	out.Note = *note
	var raw []byte
	var fetched time.Time
	err = tx.QueryRow(ctx, "SELECT record,fetched_at FROM account_note_bodies WHERE account_id=$1 AND id=$2 AND username=$3 AND native_user_id=$4", accountID, id, username, native).Scan(&raw, &fetched)
	if err == nil {
		if json.Unmarshal(raw, &out.Body) != nil {
			return out, ErrInvalid
		}
		out.FetchedAt = &fetched
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	err = tx.QueryRow(ctx, "SELECT record FROM jobs WHERE account_id=$1 AND record->>'kind'='read_note' AND record->>'article_id'=$2 AND record->>'account_username'=$3 AND record->>'account_native_id'=$4 ORDER BY created_at DESC,id DESC LIMIT 1", accountID, id, username, native).Scan(&raw)
	if err == nil {
		var r record
		if json.Unmarshal(raw, &r) != nil {
			return out, ErrInvalid
		}
		out.ReadJob = &r.Job
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (h *handler) noteDetailRoutes() {
	h.mux.HandleFunc("GET /api/accounts/{account}/notes/{note}", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		out, err := h.store.Note(r.Context(), r.PathValue("account"), r.PathValue("note"))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("POST /api/accounts/{account}/notes/{note}/read", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		out, created, err := h.store.createNoteJob(r.Context(), r.PathValue("account"), "read_note", in.RequestID, r.PathValue("note"))
		if err != nil {
			replyError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		writeJSON(w, status, out)
	}))
}
