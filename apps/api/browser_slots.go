package bridge

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

// 只记录资源租约，不保存平台凭据；所有入口先验证账号权限。
func reserveBrowser(ctx context.Context, tx pgx.Tx, id, purpose string, now time.Time) (bool, error) {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(721936420)"); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM account_browser_slots WHERE expires_at<=$1", now); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM account_browser_slots WHERE account_id=$1 AND purpose='task' AND NOT EXISTS(SELECT 1 FROM jobs WHERE account_id=$1 AND record->>'status'='running' AND (record->>'LeaseExpiresAt')::timestamptz>$2)", id, now); err != nil {
		return false, err
	}
	var owner *string
	if err := tx.QueryRow(ctx, "SELECT owner_user_id FROM account WHERE id=$1 AND enabled", id).Scan(&owner); err != nil {
		return false, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM account_browser_slots WHERE account_id=$1)", id).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	var total, owned int
	if err := tx.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE owner_user_id IS NOT DISTINCT FROM $1) FROM account_browser_slots", owner).Scan(&total, &owned); err != nil {
		return false, err
	}
	if total >= 8 || owned >= 2 {
		return false, nil
	}
	_, err := tx.Exec(ctx, "INSERT INTO account_browser_slots(account_id,owner_user_id,purpose,expires_at) VALUES($1,$2,$3,$4)", id, owner, purpose, now.Add(90*time.Second))
	return err == nil, err
}

func (h *handler) browserSlotRoutes() {
	h.mux.HandleFunc("POST /internal/worker/login-lease", h.worker(func(w http.ResponseWriter, r *http.Request) {
		allowed := false
		err := h.store.locked(r.Context(), func(tx pgx.Tx, now time.Time) error {
			var err error
			allowed, err = reserveBrowser(r.Context(), tx, accountOf(r.Context()), "login", now)
			return err
		})
		if err != nil {
			replyError(w, err)
			return
		}
		if !allowed {
			fail(w, 429, "browser_busy", "正在等待浏览器执行名额")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	h.mux.HandleFunc("DELETE /internal/worker/login-lease", h.worker(func(w http.ResponseWriter, r *http.Request) {
		_, err := h.store.pool.Exec(r.Context(), "DELETE FROM account_browser_slots WHERE account_id=$1 AND purpose='login'", accountOf(r.Context()))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
