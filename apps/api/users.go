package bridge

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"strings"
	"time"
)

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Enabled  bool   `json:"enabled"`
}

func (h *handler) initializeUsers(ctx context.Context, username string) error {
	return h.store.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		if _, err := tx.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) SELECT 'usr_'||md5(username),username,password_hash,'admin' FROM admins ON CONFLICT(username) DO NOTHING`); err != nil {
			return err
		}
		var owner string
		if err := tx.QueryRow(ctx, "SELECT id FROM users WHERE username=$1", username).Scan(&owner); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE sessions s SET user_id=u.id,auth_version=u.auth_version FROM users u WHERE s.username=u.username AND s.user_id IS NULL"); err != nil {
			return err
		}
		var migrated bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM tenant_migrations WHERE name='ownership')").Scan(&migrated); err != nil {
			return err
		}
		if migrated {
			return nil
		}
		if _, err := tx.Exec(ctx, "UPDATE account SET owner_user_id=$1 WHERE owner_user_id IS NULL", owner); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE jobs j SET owner_user_id=a.owner_user_id,account_id=a.id,created_by='user:'||a.owner_user_id,request_namespace='user:'||a.owner_user_id,record=j.record||jsonb_build_object('owner_user_id',a.owner_user_id,'connection_version',1,'created_by','user:'||a.owner_user_id,'account_username',CASE WHEN coalesce(j.record->>'account_username','')='' THEN a.username ELSE j.record->>'account_username' END) FROM account a WHERE a.id=j.record->>'account_id'"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE article_read_requests q SET owner_user_id=j.owner_user_id,request_namespace=j.request_namespace FROM jobs j WHERE j.id=q.job_id"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO tenant_settings(id,bootstrap_user_id) VALUES(true,$1) ON CONFLICT(id) DO NOTHING", owner); err != nil {
			return err
		}
		for _, table := range integrationTenantTables {
			if _, err := tx.Exec(ctx, "UPDATE "+table+" SET owner_user_id=$1 WHERE owner_user_id=''", owner); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, "INSERT INTO tenant_migrations(name) VALUES('ownership')")
		return err
	})
}

func (h *handler) userContext(r *http.Request, current session) (context.Context, error) {
	s := tenantScope{UserID: current.UserID, CallerID: "user:" + current.UserID}
	ctx := scoped(r.Context(), s)
	id := r.PathValue("account")
	if id == "" {
		id = r.URL.Query().Get("account_id")
	}
	if strings.HasPrefix(r.URL.Path, "/api/jobs/") || strings.HasPrefix(r.URL.Path, "/api/processes/") {
		job, err := h.store.Get(ctx, r.PathValue("id"))
		if err != nil {
			return ctx, err
		}
		id = job.AccountID
	}
	if id != "" {
		var valid bool
		if err := h.store.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM account WHERE id=$1)", id).Scan(&valid); err != nil {
			return ctx, err
		}
		if !valid {
			return ctx, ErrNotFound
		}
	} else {
		err := h.store.pool.QueryRow(ctx, "SELECT id FROM account WHERE enabled ORDER BY (id='csdn-main') DESC,platform,id LIMIT 1").Scan(&id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return ctx, err
		}
	}
	s.AccountID = id
	return scoped(ctx, s), nil
}

func (s *Store) executableAccount(ctx context.Context, id string) error {
	var valid bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account a LEFT JOIN users u ON u.id=a.owner_user_id WHERE a.id=$1 AND a.enabled AND (a.owner_user_id IS NULL OR u.enabled))`, id).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrNotFound
	}
	return nil
}

func (h *handler) userRoutes() {
	h.mux.HandleFunc("GET /api/users", h.authenticated(func(w http.ResponseWriter, r *http.Request, s session) {
		if s.Role != "admin" {
			fail(w, 403, "forbidden", "需要用户管理权限")
			return
		}
		r = r.WithContext(scoped(r.Context(), tenantScope{}))
		rows, err := h.store.pool.Query(r.Context(), "SELECT id,username,role,enabled FROM users ORDER BY created_at,id")
		if err != nil {
			replyError(w, err)
			return
		}
		defer rows.Close()
		items := []User{}
		for rows.Next() {
			var u User
			if err = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Enabled); err != nil {
				replyError(w, err)
				return
			}
			items = append(items, u)
		}
		if err = rows.Err(); err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("POST /api/users", h.authenticated(func(w http.ResponseWriter, r *http.Request, s session) {
		if s.Role != "admin" {
			fail(w, 403, "forbidden", "需要用户管理权限")
			return
		}
		r = r.WithContext(scoped(r.Context(), tenantScope{}))
		var in struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		if !validKey(in.Username) || len(in.Password) < 12 || len(in.Password) > 72 {
			replyError(w, ErrInvalid)
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err != nil {
			replyError(w, err)
			return
		}
		u := User{ID: "usr_" + randomToken()[:32], Username: in.Username, Role: "user", Enabled: true}
		_, err = h.store.pool.Exec(r.Context(), "INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)", u.ID, u.Username, string(hash))
		if err != nil {
			replyError(w, ErrConflict)
			return
		}
		writeJSON(w, 201, u)
	}))
	h.mux.HandleFunc("PATCH /api/users/{user}", h.authenticated(func(w http.ResponseWriter, r *http.Request, s session) {
		if s.Role != "admin" {
			fail(w, 403, "forbidden", "需要用户管理权限")
			return
		}
		r = r.WithContext(scoped(r.Context(), tenantScope{}))
		var in struct {
			Enabled  *bool  `json:"enabled"`
			Password string `json:"password"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		id := r.PathValue("user")
		if !validKey(id) || in.Enabled == nil && in.Password == "" || id == s.UserID && in.Enabled != nil && !*in.Enabled {
			replyError(w, ErrInvalid)
			return
		}
		var hash string
		if in.Password != "" {
			if len(in.Password) < 12 || len(in.Password) > 72 {
				replyError(w, ErrInvalid)
				return
			}
			b, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
			if err != nil {
				replyError(w, err)
				return
			}
			hash = string(b)
		}
		err := h.store.locked(r.Context(), func(tx pgx.Tx, _ time.Time) error {
			tag, err := tx.Exec(r.Context(), "UPDATE users SET enabled=coalesce($2,enabled),password_hash=CASE WHEN $3='' THEN password_hash ELSE $3 END,auth_version=auth_version+1 WHERE id=$1 AND (role='user' OR id=$4)", id, in.Enabled, hash, s.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return ErrNotFound
			}
			_, err = tx.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", id)
			return err
		})
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
