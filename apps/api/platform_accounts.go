package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type PlatformAccountConfig struct {
	ID              string `json:"id"`
	Platform        string `json:"platform"`
	Username        string `json:"username"`
	UserID          string `json:"user_id"`
	DisplayName     string `json:"display_name"`
	ProfileDir      string `json:"profile_dir"`
	WorkerTokenFile string `json:"worker_token_file"`
	WorkerToken     string `json:"-"`
}

var xhsUserID = regexp.MustCompile(`^[a-f0-9]{24}$`)
var xhsUsername = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func loadPlatformAccounts(path, legacyToken string) ([]PlatformAccountConfig, error) {
	if path == "" {
		return nil, nil
	}
	info, err := os.Lstat(path)
	if err != nil || !filepath.IsAbs(path) || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 65536 {
		return nil, ErrInvalid
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, ErrInvalid
	}
	var file struct {
		Accounts []PlatformAccountConfig `json:"accounts"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&file) != nil || decoder.Decode(new(any)) != io.EOF || len(file.Accounts) != 1 {
		return nil, ErrInvalid
	}
	for i := range file.Accounts {
		a := &file.Accounts[i]
		if !validKey(a.ID) || a.ID == "csdn-main" || a.Platform != "xiaohongshu" || !xhsUsername.MatchString(a.Username) || !xhsUserID.MatchString(a.UserID) || strings.TrimSpace(a.DisplayName) == "" || !boundedText(a.DisplayName, 400) || !filepath.IsAbs(a.ProfileDir) {
			return nil, ErrInvalid
		}
		tokenInfo, tokenErr := os.Lstat(a.WorkerTokenFile)
		if tokenErr != nil || !filepath.IsAbs(a.WorkerTokenFile) || !tokenInfo.Mode().IsRegular() {
			return nil, ErrInvalid
		}
		a.WorkerToken, err = privateSecret(a.WorkerTokenFile)
		if err != nil || len(a.WorkerToken) < 32 || strings.ContainsAny(a.WorkerToken, " \t\n\r") || a.WorkerToken == legacyToken {
			return nil, ErrInvalid
		}
	}
	return file.Accounts, nil
}

func (s *Store) ConfigurePlatformAccounts(ctx context.Context, accounts []PlatformAccountConfig) error {
	if len(accounts) > 1 {
		return ErrInvalid
	}
	return s.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		for _, a := range accounts {
			if a.Platform != "xiaohongshu" || !validKey(a.ID) || a.ID == "csdn-main" || !xhsUsername.MatchString(a.Username) || !xhsUserID.MatchString(a.UserID) {
				return ErrInvalid
			}
			tag, err := tx.Exec(ctx, `INSERT INTO account(id,platform,username,native_user_id,display_name) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name
    WHERE account.platform=excluded.platform AND account.username=excluded.username AND account.native_user_id=excluded.native_user_id`, a.ID, a.Platform, a.Username, a.UserID, a.DisplayName)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return ErrConflict
			}
		}
		return nil
	})
}

func (s *Store) AccountByID(ctx context.Context, id string) (Account, error) {
	var a Account
	if !validKey(id) {
		return a, ErrInvalid
	}
	err := s.pool.QueryRow(ctx, `SELECT id,platform,username,display_name,status,last_checked_at,last_error FROM account WHERE id=$1`, id).Scan(&a.ID, &a.Platform, &a.Username, &a.DisplayName, &a.Status, &a.LastCheckedAt, &a.LastError)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return a, err
}
func (s *Store) Accounts(ctx context.Context) ([]Account, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,platform,username,display_name,status,last_checked_at,last_error FROM account ORDER BY platform,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Account{}
	for rows.Next() {
		var a Account
		if err = rows.Scan(&a.ID, &a.Platform, &a.Username, &a.DisplayName, &a.Status, &a.LastCheckedAt, &a.LastError); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func accountCapabilities(a Account) map[string]bool {
	return map[string]bool{
		"check_login":   true,
		"sync_articles": a.Platform == "csdn",
		"read_article":  a.Platform == "csdn",
		"sync_notes":    a.Platform == "xiaohongshu",
		"remote_login":  a.Platform == "csdn",
		"save_draft":    a.Platform == "csdn",
		"publish":       a.Platform == "csdn",
	}
}
func (h *handler) platformAccountRoutes() {
	h.mux.HandleFunc("GET /api/accounts", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		accounts, err := h.store.Accounts(r.Context())
		if err != nil {
			replyError(w, err)
			return
		}
		items := []map[string]any{}
		for _, a := range accounts {
			if !h.configuredAccount(a.ID) {
				continue
			}
			items = append(items, map[string]any{"account": a, "capabilities": accountCapabilities(a)})
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("GET /api/accounts/{account}", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		a, err := h.store.AccountByID(r.Context(), r.PathValue("account"))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"account": a, "capabilities": accountCapabilities(a)})
	}))
	h.mux.HandleFunc("POST /api/accounts/{account}/check", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		job, created, err := h.store.CreateAccountJob(r.Context(), r.PathValue("account"), "check_account", in.RequestID)
		if err != nil {
			replyError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		writeJSON(w, status, job)
	}))
	h.mux.HandleFunc("GET /api/accounts/{account}/notes", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		out, err := h.store.Notes(r.Context(), r.PathValue("account"), r.URL.Query().Get("q"), r.URL.Query().Get("status"), page, size)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("POST /api/accounts/{account}/notes/sync", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		job, created, err := h.store.CreateAccountJob(r.Context(), r.PathValue("account"), "sync_notes", in.RequestID)
		if err != nil {
			replyError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		writeJSON(w, status, job)
	}))
}

func jobAccountMatches(ctx context.Context, tx pgx.Tx, r *record) (bool, error) {
	var current, native, platform string
	err := tx.QueryRow(ctx, "SELECT username,native_user_id,platform FROM account WHERE id=$1", r.AccountID).Scan(&current, &native, &platform)
	return current == r.AccountUsername && current != "" && platform == r.Platform && (platform != "xiaohongshu" || native == r.AccountNativeID), err
}

func (h *handler) configuredAccount(id string) bool {
	for _, accountID := range h.workerAccounts {
		if accountID == id {
			return true
		}
	}
	return false
}

func (h *handler) platformAccountAdmin(next func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return h.admin(func(w http.ResponseWriter, r *http.Request, current session) {
		if id := r.PathValue("account"); id != "" && !h.configuredAccount(id) {
			fail(w, http.StatusNotFound, "not_found", "未找到已配置的平台账号")
			return
		}
		next(w, r, current)
	})
}
