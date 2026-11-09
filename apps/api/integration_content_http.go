package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func integrationContentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrIntegrationExpired):
		fail(w, 410, "preparation_expired", "准备稿已过期、撤销或不可修改")
	case errors.Is(err, ErrIntegrationUnsupported):
		fail(w, 422, "unsupported_content", "目标操作或正文格式尚不支持")
	case errors.Is(err, ErrIntegrationSourceChanged):
		fail(w, 409, "source_changed", "来源状态、内容或授权已变化，请重新确认")
	case errors.Is(err, ErrIntegrationNotCancellable):
		fail(w, 409, "distribution_not_cancellable", "任务已发生或可能发生外站操作，请先核对结果")
	default:
		integrationError(w, err)
	}
}
func (h *handler) integrationEndpoint(scope string, next func(http.ResponseWriter, *http.Request, IntegrationPrincipal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.integrations == nil {
			fail(w, 503, "integration_disabled", "外部平台接入尚未配置")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			fail(w, 413, "request_too_large", "请求超过允许大小")
			return
		}
		principal, err := h.integrations.Authenticate(r, body, scope)
		if err != nil {
			integrationError(w, err)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next(w, r.WithContext(scoped(r.Context(), tenantScope{UserID: principal.OwnerUserID, CallerID: "client:" + principal.ID})), principal)
	}
}
func (h *handler) integrationRoutes() {
	h.mux.HandleFunc("GET /api/integrations/v1/targets", h.integrationEndpoint("targets:read", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		items := []any{}
		accounts, err := h.store.Accounts(r.Context())
		if err != nil {
			integrationContentError(w, err)
			return
		}
		for _, account := range accounts {
			if account.Platform == "csdn" && account.Enabled && account.Verified && integrationHas(p.Accounts, account.ID) && integrationHas(p.Operations, "save_draft") {
				items = append(items, map[string]any{
					"platform":        "csdn",
					"account_id":      account.ID,
					"display_name":    account.DisplayName,
					"status":          account.Status,
					"last_checked_at": account.LastCheckedAt,
					"operations":      []string{"save_draft"},
					"body_formats":    []string{"markdown"},
					"images":          len(csdnImageHosts()) != 0,
					"title_min":       5,
					"title_max":       100,
					"body_max":        200000,
				})
			}
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("POST /api/integrations/v1/preparations", h.integrationEndpoint("preparations:write", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		var in IntegrationPrepareInput
		if !decode(w, r, &in) {
			return
		}
		out, created, err := h.prepareIntegration(r.Context(), p.IntegrationClient, in)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		status := 200
		if created {
			status = 201
		}
		writeJSON(w, status, integrationPreparationResponse(out, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("GET /api/integrations/v1/preparations/{id}", h.integrationEndpoint("preparations:read", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		prep, err := integrationReadPreparation(r.Context(), h.store.pool, r.PathValue("id"), false)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		if prep.ClientID != p.ID || prep.SourceID != p.SourceID {
			integrationContentError(w, ErrNotFound)
			return
		}
		writeJSON(w, 200, integrationPreparationResponse(prep, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("POST /api/integrations/v1/distributions", h.integrationEndpoint("distributions:write", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		var in IntegrationSubmitInput
		if !decode(w, r, &in) {
			return
		}
		if in.SourceID != p.SourceID {
			integrationContentError(w, ErrIntegrationPermission)
			return
		}
		var previousFP, id string
		err := h.store.pool.QueryRow(r.Context(), "SELECT id,fingerprint FROM integration_distributions WHERE client_id=$1 AND request_id=$2", p.ID, in.RequestID).Scan(&id, &previousFP)
		if err == nil {
			if previousFP != integrationDigest(in) {
				integrationContentError(w, ErrConflict)
				return
			}
			out, e := integrationReadDistribution(r.Context(), h.store.pool, id)
			if e != nil {
				integrationContentError(w, e)
				return
			}
			if out.ClientID != p.ID || out.SourceID != p.SourceID {
				integrationContentError(w, ErrNotFound)
				return
			}
			h.writeIntegrationDistribution(w, r, out, 200)
			return
		}
		prep, err := integrationReadPreparation(r.Context(), h.store.pool, in.PreparationID, false)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		if prep.ClientID != p.ID || prep.SourceID != p.SourceID || prep.ArticleID != in.ArticleID {
			integrationContentError(w, ErrNotFound)
			return
		}
		if !prep.Confirmed || prep.Status != "confirmed" || !prep.ExpiresAt.After(h.store.now()) {
			integrationContentError(w, ErrIntegrationExpired)
			return
		}
		if err = validateIntegrationTargets(in.Targets); err != nil {
			integrationContentError(w, err)
			return
		}
		out, created, err := h.commitIntegrationDistribution(r.Context(), p.IntegrationClient, in)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		h.writeIntegrationDistribution(w, r, out, status)
	}))
	h.mux.HandleFunc("POST /api/integrations/v1/distributions/{id}/cancel", h.integrationEndpoint("distributions:write", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		d, err := h.cancelIntegrationDistribution(r.Context(), p.IntegrationClient, r.PathValue("id"))
		if err != nil {
			integrationContentError(w, err)
			return
		}
		h.writeIntegrationDistribution(w, r, d, 200)
	}))
	h.mux.HandleFunc("GET /api/integrations/v1/distributions/{id}", h.integrationEndpoint("distributions:read", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		out, err := integrationReadDistribution(r.Context(), h.store.pool, r.PathValue("id"))
		if err != nil {
			integrationContentError(w, err)
			return
		}
		if out.ClientID != p.ID || out.SourceID != p.SourceID {
			integrationContentError(w, ErrNotFound)
			return
		}
		h.writeIntegrationDistribution(w, r, out, 200)
	}))
	h.mux.HandleFunc("GET /api/integrations/v1/distributions", h.integrationEndpoint("distributions:read", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		var id string
		if !validKey(r.URL.Query().Get("request_id")) {
			integrationContentError(w, ErrInvalid)
			return
		}
		if err := h.store.pool.QueryRow(r.Context(), "SELECT id FROM integration_distributions WHERE client_id=$1 AND request_id=$2", p.ID, r.URL.Query().Get("request_id")).Scan(&id); err != nil {
			integrationContentError(w, ErrNotFound)
			return
		}
		out, err := integrationReadDistribution(r.Context(), h.store.pool, id)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		if out.ClientID != p.ID || out.SourceID != p.SourceID {
			integrationContentError(w, ErrNotFound)
			return
		}
		h.writeIntegrationDistribution(w, r, out, 200)
	}))
	h.mux.HandleFunc("POST /api/integrations/v1/source-events", h.integrationEndpoint("source-events:write", func(w http.ResponseWriter, r *http.Request, p IntegrationPrincipal) {
		var in IntegrationSourceEvent
		if !decode(w, r, &in) {
			return
		}
		applied, err := h.applyIntegrationEvent(r.Context(), p.IntegrationClient, in)
		if err != nil {
			integrationContentError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"received": true, "applied": applied})
	}))
	h.mux.HandleFunc("GET /api/integration-preparations", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		status := r.URL.Query().Get("status")
		var total int
		if err := h.store.pool.QueryRow(r.Context(), "SELECT count(*) FROM integration_preparations WHERE $1='' OR record->>'status'=$1", status).Scan(&total); err != nil {
			integrationAdminContentError(w, err)
			return
		}
		rows, err := h.store.pool.Query(r.Context(), "SELECT record FROM integration_preparations WHERE $1='' OR record->>'status'=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3", status, size, (page-1)*size)
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		defer rows.Close()
		items := []any{}
		for rows.Next() {
			var raw []byte
			var p IntegrationPreparation
			if err = rows.Scan(&raw); err != nil {
				break
			}
			if err = json.Unmarshal(raw, &p); err != nil {
				break
			}
			p.Snapshot.Body = ""
			p.Drafts = []IntegrationDraft{}
			items = append(items, integrationPreparationResponse(p, h.origin, h.store.now()))
		}
		if err == nil {
			err = rows.Err()
		}
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": size})
	}))
	h.mux.HandleFunc("GET /api/integration-preparations/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		p, err := integrationReadPreparation(r.Context(), h.store.pool, r.PathValue("id"), false)
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		writeJSON(w, 200, integrationAdminPreparationResponse(p, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("PUT /api/integration-preparations/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision int64              `json:"revision"`
			Drafts   []IntegrationDraft `json:"drafts"`
		}
		if !decode(w, r, &in) {
			return
		}
		p, err := h.updateIntegrationPreparation(r.Context(), r.PathValue("id"), in.Revision, in.Drafts)
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		writeJSON(w, 200, integrationAdminPreparationResponse(p, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("POST /api/integration-preparations/{id}/confirm", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision int64 `json:"revision"`
		}
		if !decode(w, r, &in) {
			return
		}
		p, err := h.confirmIntegrationPreparation(r.Context(), r.PathValue("id"), in.Revision)
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		writeJSON(w, 200, integrationAdminPreparationResponse(p, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("POST /api/integration-preparations/{id}/revoke", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		p, err := h.revokeIntegrationPreparation(r.Context(), r.PathValue("id"))
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		writeJSON(w, 200, integrationAdminPreparationResponse(p, h.origin, h.store.now()))
	}))
	h.mux.HandleFunc("GET /api/integration-distributions", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		h.listIntegrationDistributions(w, r)
	}))
	h.mux.HandleFunc("GET /api/integration-distributions/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		d, err := integrationReadDistribution(r.Context(), h.store.pool, r.PathValue("id"))
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		h.writeIntegrationDistribution(w, r, d, 200)
	}))
	h.mux.HandleFunc("POST /api/integration-distributions/{id}/resume", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			ConfirmationFingerprint string `json:"confirmation_fingerprint"`
		}
		if !decode(w, r, &in) {
			return
		}
		d, err := h.resumeIntegrationDistribution(r.Context(), r.PathValue("id"), in.ConfirmationFingerprint)
		if err != nil {
			integrationAdminContentError(w, err)
			return
		}
		h.writeIntegrationDistribution(w, r, d, 200)
	}))
}
func integrationAdminPreparationResponse(p IntegrationPreparation, origin string, now time.Time) map[string]any {
	result := integrationPreparationResponse(p, origin, now)
	if p.Status == "submitted" || p.ExpiresAt.After(now) {
		if images, err := approvedImageMarkdown(p.Snapshot.Title, p.Snapshot.Body, nil); err == nil && len(images) > 0 {
			result["preview_image_urls"] = images
		}
	}
	return result
}

func integrationPreparationResponse(p IntegrationPreparation, origin string, now time.Time) map[string]any {
	if p.Status != "submitted" && !p.ExpiresAt.After(now) {
		p.Status = "expired"
		p.Confirmed = false
		p.Snapshot = IntegrationSnapshot{}
		p.Drafts = []IntegrationDraft{}
	}
	raw, _ := json.Marshal(p)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	result["preview_url"] = origin + "/integration-preparations/" + p.ID
	return result
}
func (h *handler) writeIntegrationDistribution(w http.ResponseWriter, r *http.Request, d IntegrationDistribution, status int) {
	result, err := h.integrationDistributionSummary(r.Context(), d)
	if err != nil {
		integrationContentError(w, err)
		return
	}
	writeJSON(w, status, result)
}
func integrationAdminContentError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrIntegrationAuthentication) {
		fail(w, 409, "client_unavailable", "接入应用当前不可用，请核对授权")
		return
	}
	integrationContentError(w, err)
}

func (h *handler) disabledIntegrationRoutes() {
	unavailable := h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		fail(w, 503, "integration_disabled", "外部平台接入尚未配置")
	})
	for _, path := range []string{"/api/integration-clients", "/api/integration-clients/", "/api/integration-invitations", "/api/integration-invitations/", "/api/integration-registrations", "/api/integration-registrations/", "/api/integration-audit"} {
		h.mux.HandleFunc(path, unavailable)
	}
	h.mux.HandleFunc("/api/integrations/v1/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, 503, "integration_disabled", "外部平台接入尚未配置")
	})
}
