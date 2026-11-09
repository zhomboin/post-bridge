package bridge

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var errAccountUnresolved = errors.New("account_unresolved")

var integrationTenantTables = []string{"integration_invitations", "integration_registrations", "integration_clients", "integration_keys", "integration_preparations", "integration_distributions", "integration_source_states", "integration_authorization_revocations", "integration_audit"}

func (h *handler) provisionConnections(ctx context.Context) error {
	h.accountLogins = map[string]*remoteLoginProxy{}
	ids := []string{"csdn-main"}
	for _, id := range h.workerAccounts {
		ids = append(ids, id)
	}
	if _, err := h.store.pool.Exec(ctx, "UPDATE account SET enabled=false WHERE id<>ALL($1) AND EXISTS(SELECT 1 FROM account_connections c WHERE c.account_id=account.id AND c.profile_ref='configured/'||account.id)", ids); err != nil {
		return err
	}
	rows, err := h.store.pool.Query(ctx, "SELECT id,coalesce(owner_user_id,''),connection_version FROM account WHERE enabled")
	if err != nil {
		return err
	}
	type entry struct {
		id, owner string
		version   int64
	}
	entries := []entry{}
	for rows.Next() {
		var a entry
		if err = rows.Scan(&a.id, &a.owner, &a.version); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, a := range entries {
		_, err = h.store.pool.Exec(ctx, `INSERT INTO account_connections(id,account_id,version,profile_ref,worker_token_hash)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,version) DO UPDATE SET worker_token_hash=excluded.worker_token_hash`, "conn_"+randomToken()[:32], a.id, a.version, "configured/"+a.id, hashToken(h.connectionToken(a.id, a.version)))
		if err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) connectionToken(id string, version int64) string {
	mac := hmac.New(sha256.New, []byte(h.workerToken))
	_, _ = mac.Write([]byte(integrationDigest([]any{"account-worker", id, version})))
	return hex.EncodeToString(mac.Sum(nil))
}

func (h *handler) accountManagementRoutes() {
	h.mux.HandleFunc("POST /api/accounts", h.authenticated(func(w http.ResponseWriter, r *http.Request, current session) {
		var in struct {
			Platform    string `json:"platform"`
			Username    string `json:"username"`
			UserID      string `json:"user_id"`
			DisplayName string `json:"display_name"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		if (in.Platform != "csdn" && in.Platform != "xiaohongshu") || !xhsUsername.MatchString(in.Username) || !boundedText(in.DisplayName, 400) || in.UserID != "" && (in.Platform != "xiaohongshu" || !xhsUserID.MatchString(in.UserID)) {
			replyError(w, ErrInvalid)
			return
		}
		if in.DisplayName == "" {
			in.DisplayName = in.Username
		}
		id := "acc_" + randomToken()[:32]
		err := h.store.locked(r.Context(), func(tx pgx.Tx, _ time.Time) error {
			if _, err := tx.Exec(r.Context(), "SELECT id FROM users WHERE id=$1 FOR UPDATE", current.UserID); err != nil {
				return err
			}
			var count int
			if err := tx.QueryRow(r.Context(), "SELECT count(*) FROM account WHERE owner_user_id=$1 AND enabled", current.UserID).Scan(&count); err != nil {
				return err
			}
			if count >= 100 {
				return ErrConflict
			}
			var previous string
			var enabled bool
			version := int64(1)
			lookup := tx.QueryRow(r.Context(), "SELECT id,enabled,connection_version FROM account WHERE platform=$1 AND username=$2 FOR UPDATE", in.Platform, in.Username).Scan(&previous, &enabled, &version)
			if lookup == nil {
				if enabled {
					return ErrConflict
				}
				id = previous
				var unknown bool
				if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM jobs WHERE account_id=$1 AND record->>'external_started'='true' AND (record->>'outcome'='unknown' OR record->>'status' IN ('running','waiting_user','reconciling')))", id).Scan(&unknown); err != nil {
					return err
				}
				if unknown {
					return ErrConflict
				}
				if _, err := tx.Exec(r.Context(), "UPDATE account SET enabled=true,credentials_revoked=false,verified=false,status='needs_login',last_error='' WHERE id=$1", id); err != nil {
					return err
				}
			} else if errors.Is(lookup, pgx.ErrNoRows) {
				if _, err := tx.Exec(r.Context(), "INSERT INTO account(id,platform,username,native_user_id,display_name,owner_user_id,identity_claimed,verified,status) VALUES($1,$2,$3,$4,$5,$6,false,false,'needs_login')", id, in.Platform, in.Username, in.UserID, in.DisplayName, current.UserID); err != nil {
					return ErrConflict
				}
			} else {
				return lookup
			}
			_, err := tx.Exec(r.Context(), "INSERT INTO account_connections(id,account_id,version,profile_ref,worker_token_hash) VALUES($1,$2,$3,$4,$5)", "conn_"+randomToken()[:32], id, version, current.UserID+"/"+id+"/"+strconv.FormatInt(version, 10), hashToken(h.connectionToken(id, version)))
			return err
		})
		if err != nil {
			replyError(w, err)
			return
		}
		a, err := h.store.AccountByID(r.Context(), id)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"account": a, "capabilities": accountCapabilities(a)})
	}))
	h.mux.HandleFunc("DELETE /api/accounts/{account}", h.authenticated(func(w http.ResponseWriter, r *http.Request, current session) {
		id := r.PathValue("account")
		err := h.store.locked(r.Context(), func(tx pgx.Tx, now time.Time) error {
			var unresolved bool
			if err := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM jobs WHERE account_id=$1 AND record->>'external_started'='true' AND (record->>'outcome'='unknown' OR record->>'status' IN ('running','waiting_user','reconciling'))) ", id).Scan(&unresolved); err != nil {
				return err
			}
			if unresolved {
				return errAccountUnresolved
			}
			tag, err := tx.Exec(r.Context(), "UPDATE account SET enabled=false,credentials_revoked=true,connection_version=connection_version+1,status='disconnected' WHERE id=$1 AND enabled", id)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return ErrNotFound
			}
			if _, err = tx.Exec(r.Context(), "UPDATE account_connections SET enabled=false WHERE account_id=$1", id); err != nil {
				return err
			}
			rows, err := tx.Query(r.Context(), "SELECT id FROM jobs WHERE account_id=$1 AND record->>'status' IN ('queued','running','waiting_user','reconciling') FOR UPDATE", id)
			if err != nil {
				return err
			}
			ids := []string{}
			for rows.Next() {
				var jobID string
				if err = rows.Scan(&jobID); err != nil {
					rows.Close()
					return err
				}
				ids = append(ids, jobID)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			for _, jobID := range ids {
				job, err := load(r.Context(), tx, jobID)
				if err != nil {
					return err
				}
				job.CancelRequested = true
				job.Ready = false
				if job.ExternalStarted {
					job.Status = "reconciling"
					job.RunMode = "reconcile"
					job.Outcome = "unknown"
				} else {
					job.Status = "cancelled"
					job.FinishedAt = &now
				}
				job.UpdatedAt = now
				if err = save(r.Context(), tx, job); err != nil {
					return err
				}
			}
			return nil
		})
		if errors.Is(err, errAccountUnresolved) {
			fail(w, 409, "account_unresolved", "请先核对尚未确认的平台结果，或人工结束任务，再解绑账号")
			return
		}
		if err != nil {
			replyError(w, err)
			return
		}
		h.closeAccountLogin(r.Context(), id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("GET /internal/worker/accounts", func(w http.ResponseWriter, r *http.Request) {
		if !h.schedulerAuthorized(r) {
			fail(w, 401, "unauthorized", "需要调度器身份")
			return
		}
		rows, err := h.store.pool.Query(r.Context(), `SELECT a.id,a.platform,a.username,a.native_user_id,a.owner_user_id,a.connection_version,c.profile_ref,a.enabled AND u.enabled,a.credentials_revoked,(coalesce(c.wanted_at>now()-interval '30 seconds',false) OR EXISTS(SELECT 1 FROM jobs wanted WHERE wanted.account_id=a.id AND (wanted.record->>'status'='running' OR wanted.record->>'Ready'='true'))),ARRAY(SELECT profile_ref FROM account_connections retired WHERE retired.account_id=a.id AND NOT retired.enabled ORDER BY retired.version)
 FROM account a JOIN users u ON u.id=a.owner_user_id LEFT JOIN LATERAL (SELECT profile_ref,wanted_at FROM account_connections WHERE account_id=a.id ORDER BY version DESC LIMIT 1) c ON true ORDER BY EXISTS(SELECT 1 FROM jobs running WHERE running.account_id=a.id AND running.record->>'status'='running') DESC,c.wanted_at DESC,a.id`)
		if err != nil {
			replyError(w, err)
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, platform, username, native, owner string
			var profile *string
			var version int64
			var enabled, revoked, wanted bool
			var retired []string
			if err = rows.Scan(&id, &platform, &username, &native, &owner, &version, &profile, &enabled, &revoked, &wanted, &retired); err != nil {
				replyError(w, err)
				return
			}
			h.accountLoginMu.Lock()
			proxy := h.accountLogins[id]
			controlURL := ""
			if proxy != nil {
				controlURL = proxy.endpoint
			}
			h.accountLoginMu.Unlock()
			item := map[string]any{"control_url": controlURL, "id": id, "platform": platform, "username": username, "user_id": native, "owner_user_id": owner, "connection_version": version, "enabled": enabled, "credentials_revoked": revoked, "retired_profiles": retired, "wanted": wanted}
			if profile != nil {
				item["profile_ref"] = *profile
			}
			if enabled {
				item["token"] = h.connectionToken(id, version)
			}
			items = append(items, item)
		}
		if err = rows.Err(); err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	})
	h.mux.HandleFunc("POST /internal/worker/control", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL string `json:"url"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		proxy, err := newRemoteLoginProxy(in.URL)
		if err != nil {
			replyError(w, ErrInvalid)
			return
		}
		proxy.token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		id := accountOf(r.Context())
		h.accountLoginMu.Lock()
		old := h.accountLogins[id]
		if old != nil && old.endpoint == proxy.endpoint {
			h.accountLoginMu.Unlock()
			proxy.client.CloseIdleConnections()
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		h.accountLogins[id] = proxy
		h.accountLoginMu.Unlock()
		if old != nil {
			old.client.CloseIdleConnections()
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("DELETE /internal/worker/control", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL string `json:"url"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		h.accountLoginMu.Lock()
		proxy := h.accountLogins[accountOf(r.Context())]
		if proxy != nil && proxy.endpoint == in.URL {
			delete(h.accountLogins, accountOf(r.Context()))
		} else {
			proxy = nil
		}
		h.accountLoginMu.Unlock()
		if proxy != nil {
			proxy.client.CloseIdleConnections()
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("POST /internal/worker/identity", h.worker(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			UserID string `json:"user_id"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		a, err := h.store.AccountByID(r.Context(), accountOf(r.Context()))
		if err != nil {
			replyError(w, err)
			return
		}
		if a.Platform == "xiaohongshu" && !xhsUserID.MatchString(in.UserID) || a.Platform == "csdn" && in.UserID != "" {
			replyError(w, ErrInvalid)
			return
		}
		tag, err := h.store.pool.Exec(r.Context(), "UPDATE account SET native_user_id=$2,identity_claimed=true,verified=true,status='connected',last_error='' WHERE id=$1 AND enabled AND connection_version=$3 AND (native_user_id='' OR native_user_id=$2)", accountOf(r.Context()), in.UserID, scopeOf(r.Context()).ConnectionVersion)
		if err != nil {
			replyError(w, ErrConflict)
			return
		}
		if tag.RowsAffected() != 1 {
			replyError(w, ErrConflict)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}

func (h *handler) schedulerAuthorized(r *http.Request) bool {
	return hmac.Equal([]byte(r.Header.Get("Authorization")), []byte("Bearer "+h.workerToken))
}

func (h *handler) accountLogin(ctx context.Context) *remoteLoginProxy {
	h.accountLoginMu.Lock()
	defer h.accountLoginMu.Unlock()
	if p := h.accountLogins[accountOf(ctx)]; p != nil {
		return p
	}
	if accountOf(ctx) == "csdn-main" {
		return h.remoteLoginProxy
	}
	return nil
}
func (h *handler) loginProxies() []*remoteLoginProxy {
	h.accountLoginMu.Lock()
	defer h.accountLoginMu.Unlock()
	out := []*remoteLoginProxy{}
	if h.remoteLoginProxy != nil {
		out = append(out, h.remoteLoginProxy)
	}
	for _, p := range h.accountLogins {
		out = append(out, p)
	}
	return out
}

func (h *handler) closeAccountLogin(ctx context.Context, id string) {
	h.accountLoginMu.Lock()
	p := h.accountLogins[id]
	delete(h.accountLogins, id)
	h.accountLoginMu.Unlock()
	if p != nil {
		p.disabled.Store(true)
		p.mu.Lock()
		if p.current != nil {
			_, _ = p.revoke(ctx, p.token)
		}
		p.mu.Unlock()
		p.client.CloseIdleConnections()
	}
}
