package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var integrationScopes = []string{"targets:read", "preparations:write", "preparations:read", "distributions:write", "distributions:read", "source-events:write"}

type IntegrationInvitationInput struct {
	SourceID           string    `json:"source_id"`
	Environment        string    `json:"environment"`
	Scopes             []string  `json:"scopes"`
	Accounts           []string  `json:"accounts"`
	Operations         []string  `json:"operations"`
	ExpiresAt          time.Time `json:"expires_at"`
	ClientExpiresAt    time.Time `json:"client_expires_at"`
	RateLimitPerMinute int       `json:"rate_limit_per_minute"`
}
type IntegrationInvitation struct {
	ID        string    `json:"invitation_id"`
	Token     string    `json:"invitation_token"`
	ExpiresAt time.Time `json:"expires_at"`
}
type IntegrationRegistrationInput struct {
	Name        string   `json:"name"`
	Environment string   `json:"environment"`
	SourceID    string   `json:"source_id"`
	Scopes      []string `json:"scopes"`
	Accounts    []string `json:"accounts"`
	Operations  []string `json:"operations"`
}
type IntegrationRegistration struct {
	IntegrationRegistrationInput
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}
type IntegrationGrantInput struct {
	AIProcessingAllowed bool      `json:"ai_processing_allowed,omitempty"`
	FormattingPlatforms []string  `json:"formatting_platforms,omitempty"`
	SourceID            string    `json:"source_id,omitempty"`
	Scopes              []string  `json:"scopes"`
	Accounts            []string  `json:"accounts"`
	Operations          []string  `json:"operations"`
	ExpiresAt           time.Time `json:"expires_at"`
	RateLimitPerMinute  int       `json:"rate_limit_per_minute"`
}
type IntegrationIssued struct {
	ClientID string `json:"client_id"`
	KeyID    string `json:"key_id"`
	Secret   string `json:"client_secret"`
	Status   string `json:"status"`
}

func integrationSubset(values, cap []string) bool {
	if len(values) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range values {
		if !integrationHas(cap, v) || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func integrationPermissions(scopes, accounts, operations []string) bool {
	if !integrationSubset(scopes, integrationScopes) || !integrationSubset(operations, []string{"save_draft", "publish"}) || len(accounts) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, a := range accounts {
		if !integrationIdentifier.MatchString(a) || seen[a] {
			return false
		}
		seen[a] = true
	}
	return true
}
func (s *IntegrationService) Invite(ctx context.Context, in IntegrationInvitationInput, actor string) (IntegrationInvitation, error) {
	now := s.store.now()
	if !integrationIdentifier.MatchString(in.SourceID) || in.Environment != s.environment || !integrationPermissions(in.Scopes, in.Accounts, in.Operations) || len(in.Scopes) == 0 || !in.ExpiresAt.After(now) || in.ExpiresAt.After(now.Add(24*time.Hour)) || !in.ClientExpiresAt.After(now) || in.ClientExpiresAt.After(now.Add(366*24*time.Hour)) || in.RateLimitPerMinute < 1 || in.RateLimitPerMinute > 600 {
		return IntegrationInvitation{}, ErrInvalid
	}
	result := IntegrationInvitation{ID: randomToken(), Token: randomToken(), ExpiresAt: in.ExpiresAt}
	raw, _ := json.Marshal(in)
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return result, e
	}
	defer tx.Rollback(ctx)
	owner, err := integrationOwner(ctx, tx)
	if err != nil {
		return result, err
	}
	if err = integrationOwnedAccounts(ctx, tx, owner, in.Accounts); err != nil {
		return result, err
	}
	_, e = tx.Exec(ctx, "INSERT INTO integration_invitations(id,token_hash,settings,expires_at,created_at) VALUES($1,$2,$3,$4,$5)", result.ID, hashToken(result.Token), raw, in.ExpiresAt, now)
	if e != nil {
		return IntegrationInvitation{}, e
	}
	if e = integrationAudit(ctx, tx, "", "invitation_created", actor, now); e != nil {
		return IntegrationInvitation{}, e
	}
	e = tx.Commit(ctx)
	return result, e
}
func (s *IntegrationService) Register(ctx context.Context, token string, in IntegrationRegistrationInput) (IntegrationRegistration, error) {
	result := IntegrationRegistration{}
	if len(token) != 64 {
		return result, ErrIntegrationAuthentication
	}
	if len(strings.TrimSpace(in.Name)) < 1 || len(in.Name) > 100 || !integrationPermissions(in.Scopes, in.Accounts, in.Operations) {
		return result, ErrInvalid
	}
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return result, e
	}
	defer tx.Rollback(ctx)
	now := s.store.now()
	if e = integrationRate(ctx, tx, "registration:"+hashToken(token), 10, now); e != nil {
		_ = tx.Commit(ctx)
		return result, e
	}
	var id, owner string
	var raw []byte
	e = tx.QueryRow(ctx, "SELECT id,settings,owner_user_id FROM integration_invitations WHERE token_hash=$1 AND expires_at>$2 AND consumed_at IS NULL FOR UPDATE", hashToken(token), now).Scan(&id, &raw, &owner)
	if e != nil {
		return result, ErrIntegrationAuthentication
	}
	if _, e = tx.Exec(ctx, "SELECT set_config('post_bridge.user_id',$1,true)", owner); e != nil {
		return result, e
	}
	var cap IntegrationInvitationInput
	if e = json.Unmarshal(raw, &cap); e != nil {
		return result, e
	}
	if in.SourceID != cap.SourceID || in.Environment != cap.Environment || !integrationSubset(in.Scopes, cap.Scopes) || !integrationSubset(in.Accounts, cap.Accounts) || !integrationSubset(in.Operations, cap.Operations) {
		return result, ErrIntegrationPermission
	}
	result = IntegrationRegistration{IntegrationRegistrationInput: in, ID: randomToken(), Status: "pending", CreatedAt: now}
	raw, _ = json.Marshal(result)
	_, e = tx.Exec(ctx, "UPDATE integration_invitations SET consumed_at=$2 WHERE id=$1", id, now)
	if e != nil {
		return result, e
	}
	_, e = tx.Exec(ctx, "INSERT INTO integration_registrations(id,invitation_id,application,status,created_at) VALUES($1,$2,$3,'pending',$4)", result.ID, id, raw, now)
	if e != nil {
		return result, e
	}
	if e = integrationAudit(ctx, tx, "", "registered", "integration", now); e != nil {
		return result, e
	}
	e = tx.Commit(ctx)
	return result, e
}
func (s *IntegrationService) issue(ctx context.Context, tx pgx.Tx, c IntegrationClient) (IntegrationIssued, error) {
	owner, err := integrationOwner(ctx, tx)
	if err != nil {
		return IntegrationIssued{}, err
	}
	if err = integrationOwnedAccounts(ctx, tx, owner, c.Accounts); err != nil {
		return IntegrationIssued{}, err
	}
	raw := make([]byte, 32)
	if _, e := rand.Read(raw); e != nil {
		return IntegrationIssued{}, e
	}
	key := randomToken()
	encrypted, e := s.seal(raw, key)
	if e != nil {
		return IntegrationIssued{}, e
	}
	_, e = tx.Exec(ctx, "INSERT INTO integration_keys(id,client_id,encrypted_secret,status,expires_at,created_at) VALUES($1,$2,$3,'pending_activation',$4,$5)", key, c.ID, encrypted, c.ExpiresAt, s.store.now())
	return IntegrationIssued{
		ClientID: c.ID,
		KeyID:    key,
		Secret:   base64.StdEncoding.EncodeToString(raw),
		Status:   "pending_activation",
	}, e
}
func integrationApplyGrant(c *IntegrationClient, in IntegrationGrantInput, now time.Time) error {
	if in.AIProcessingAllowed && !formattingPlatformsValid(in.FormattingPlatforms) || !in.AIProcessingAllowed && len(in.FormattingPlatforms) > 0 {
		return ErrInvalid
	}
	if !integrationPermissions(in.Scopes, in.Accounts, in.Operations) || !in.ExpiresAt.After(now) || in.ExpiresAt.After(now.Add(366*24*time.Hour)) || in.RateLimitPerMinute < 1 || in.RateLimitPerMinute > 600 {
		return ErrInvalid
	}
	if in.SourceID != "" {
		if !integrationIdentifier.MatchString(in.SourceID) {
			return ErrInvalid
		}
		c.SourceID = in.SourceID
	}
	c.AIProcessingAllowed = in.AIProcessingAllowed
	c.FormattingPlatforms = in.FormattingPlatforms
	c.Scopes = in.Scopes
	c.Accounts = in.Accounts
	c.Operations = in.Operations
	c.ExpiresAt = in.ExpiresAt
	c.RateLimitPerMinute = in.RateLimitPerMinute
	return nil
}
func (s *IntegrationService) Approve(ctx context.Context, id string, in IntegrationGrantInput, actor string) (IntegrationIssued, error) {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return IntegrationIssued{}, e
	}
	defer tx.Rollback(ctx)
	var raw, capraw []byte
	e = tx.QueryRow(ctx, "SELECT r.application,i.settings FROM integration_registrations r JOIN integration_invitations i ON i.id=r.invitation_id WHERE r.id=$1 AND r.status='pending' FOR UPDATE OF r", id).Scan(&raw, &capraw)
	if errors.Is(e, pgx.ErrNoRows) {
		return IntegrationIssued{}, ErrConflict
	}
	if e != nil {
		return IntegrationIssued{}, e
	}
	var reg IntegrationRegistration
	var cap IntegrationInvitationInput
	json.Unmarshal(raw, &reg)
	json.Unmarshal(capraw, &cap)
	if in.SourceID != "" && in.SourceID != cap.SourceID || !integrationSubset(in.Scopes, cap.Scopes) || !integrationSubset(in.Accounts, cap.Accounts) || !integrationSubset(in.Operations, cap.Operations) || in.ExpiresAt.After(cap.ClientExpiresAt) || in.RateLimitPerMinute > cap.RateLimitPerMinute {
		return IntegrationIssued{}, ErrIntegrationPermission
	}
	c := IntegrationClient{
		ID:           randomToken(),
		Name:         reg.Name,
		SourceID:     reg.SourceID,
		Environment:  s.environment,
		ServiceID:    s.serviceID,
		Status:       "pending_activation",
		GrantVersion: 1,
	}
	if e = integrationApplyGrant(&c, in, s.store.now()); e != nil {
		return IntegrationIssued{}, e
	}
	raw, _ = json.Marshal(c)
	_, e = tx.Exec(ctx, "INSERT INTO integration_clients(id,registration_id,metadata,created_at) VALUES($1,$2,$3,$4)", c.ID, id, raw, s.store.now())
	if e != nil {
		return IntegrationIssued{}, e
	}
	issued, e := s.issue(ctx, tx, c)
	if e != nil {
		return issued, e
	}
	_, e = tx.Exec(ctx, "UPDATE integration_registrations SET status='approved' WHERE id=$1", id)
	if e != nil {
		return IntegrationIssued{}, e
	}
	if e = integrationAudit(ctx, tx, c.ID, "approved", actor, s.store.now()); e != nil {
		return IntegrationIssued{}, e
	}
	e = tx.Commit(ctx)
	return issued, e
}
func (s *IntegrationService) Update(ctx context.Context, id string, in IntegrationGrantInput, actor string) (IntegrationClient, error) {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return IntegrationClient{}, e
	}
	defer tx.Rollback(ctx)
	c, e := integrationLoadClient(ctx, tx, id)
	if e != nil {
		return c, e
	}
	if c.Status == "revoked" {
		return c, ErrConflict
	}
	before := c
	if e = integrationApplyGrant(&c, in, s.store.now()); e != nil {
		return c, e
	}
	// 来源标识或权限变动推进代次。
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(c)
	if string(a) != string(b) {
		c.GrantVersion++
	}
	if e = integrationSaveClient(ctx, tx, c); e != nil {
		return c, e
	}

	if e = integrationAudit(ctx, tx, id, "permissions_updated", actor, s.store.now()); e != nil {
		return c, e
	}
	e = tx.Commit(ctx)
	return c, e
}
func (s *IntegrationService) Rotate(ctx context.Context, id, actor string) (IntegrationIssued, error) {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return IntegrationIssued{}, e
	}
	defer tx.Rollback(ctx)
	c, e := integrationLoadClient(ctx, tx, id)
	if e != nil {
		return IntegrationIssued{}, e
	}
	if c.Status != "active" && c.Status != "pending_activation" {
		return IntegrationIssued{}, ErrConflict
	}
	_, e = tx.Exec(ctx, "UPDATE integration_keys SET status='revoked' WHERE client_id=$1 AND status='pending_activation'", id)
	if e != nil {
		return IntegrationIssued{}, e
	}
	issued, e := s.issue(ctx, tx, c)
	if e != nil {
		return issued, e
	}
	if e = integrationAudit(ctx, tx, id, "key_rotated", actor, s.store.now()); e != nil {
		return issued, e
	}
	e = tx.Commit(ctx)
	return issued, e
}
func (s *IntegrationService) Transition(ctx context.Context, id, action, actor string) error {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	c, e := integrationLoadClient(ctx, tx, id)
	if e != nil {
		return e
	}
	switch action {
	case "suspend":
		if c.Status != "active" && c.Status != "pending_activation" {
			return ErrConflict
		}
		c.Status = "suspended"
		c.GrantVersion++
	case "resume":
		if c.Status != "suspended" {
			return ErrConflict
		}
		var valid bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM integration_keys WHERE client_id=$1 AND status IN ('active','handover') AND expires_at>$2)", id, s.store.now()).Scan(&valid)
		if e != nil {
			return e
		}
		if !valid {
			return ErrConflict
		}
		c.Status = "active"
		c.GrantVersion++
	case "revoke":
		if c.Status == "revoked" {
			return ErrConflict
		}
		c.Status = "revoked"
		c.GrantVersion++
		_, e = tx.Exec(ctx, "UPDATE integration_keys SET status='revoked' WHERE client_id=$1", id)
		if e != nil {
			return e
		}
	default:
		return ErrInvalid
	}
	if e = integrationSaveClient(ctx, tx, c); e != nil {
		return e
	}
	if e = integrationAudit(ctx, tx, id, action, actor, s.store.now()); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func integrationError(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, ErrIntegrationAuthentication):
		fail(w, 401, "unauthorized", "调用身份验证失败")
	case errors.Is(e, ErrIntegrationPermission):
		fail(w, 403, "forbidden", "调用权限不足")
	case errors.Is(e, ErrIntegrationRateLimited):
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "rate_limited", "请求过于频繁")
	default:
		replyError(w, e)
	}
}
func (s *IntegrationService) RegisterRoutes(h *handler) {
	if s == nil || h == nil {
		return
	}
	h.mux.HandleFunc("GET /api/integration-invitations", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		rows, e := s.store.pool.Query(r.Context(), "SELECT id,settings,expires_at,consumed_at,created_at FROM integration_invitations ORDER BY created_at DESC LIMIT 100")
		if e != nil {
			integrationError(w, e)
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id string
			var raw []byte
			var expires, created time.Time
			var consumed *time.Time
			if e = rows.Scan(&id, &raw, &expires, &consumed, &created); e != nil {
				integrationError(w, e)
				return
			}
			var cap IntegrationInvitationInput
			if e = json.Unmarshal(raw, &cap); e != nil {
				integrationError(w, e)
				return
			}
			status := "pending"
			if consumed != nil {
				status = "consumed"
			} else if !expires.After(s.store.now()) {
				status = "expired"
			}
			items = append(items, map[string]any{
				"invitation_id":         id,
				"source_id":             cap.SourceID,
				"environment":           cap.Environment,
				"scopes":                cap.Scopes,
				"accounts":              cap.Accounts,
				"operations":            cap.Operations,
				"status":                status,
				"expires_at":            expires,
				"client_expires_at":     cap.ClientExpiresAt,
				"rate_limit_per_minute": cap.RateLimitPerMinute,
				"created_at":            created,
			})
		}
		if e = rows.Err(); e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("POST /api/integration-invitations", h.authenticated(func(w http.ResponseWriter, r *http.Request, admin session) {
		var in IntegrationInvitationInput
		if !integrationDecode(w, r, &in) {
			return
		}
		out, e := s.Invite(r.Context(), in, admin.Username)
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 201, out)
	}))
	h.mux.HandleFunc("POST /api/integrations/v1/registrations", func(w http.ResponseWriter, r *http.Request) {
		if e := s.registrationAttempt(r.Context(), r.RemoteAddr); e != nil {
			integrationError(w, e)
			return
		}
		if r.Host != strings.TrimPrefix(s.origin, "https://") || r.URL.IsAbs() && r.URL.Scheme != "https" || len(r.Header.Values("X-Integration-Invitation")) > 1 {
			integrationError(w, ErrIntegrationAuthentication)
			return
		}
		var in IntegrationRegistrationInput
		if !integrationDecode(w, r, &in) {
			return
		}
		out, e := s.Register(r.Context(), r.Header.Get("X-Integration-Invitation"), in)
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 201, map[string]string{"registration_id": out.ID, "status": out.Status})
	})
	h.mux.HandleFunc("GET /api/integration-registrations", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		rows, e := s.store.pool.Query(r.Context(), "SELECT application,status FROM integration_registrations ORDER BY created_at DESC LIMIT 100")
		if e != nil {
			integrationError(w, e)
			return
		}
		defer rows.Close()
		items := []IntegrationRegistration{}
		for rows.Next() {
			var raw []byte
			var status string
			if e = rows.Scan(&raw, &status); e != nil {
				integrationError(w, e)
				return
			}
			var out IntegrationRegistration
			if e = json.Unmarshal(raw, &out); e != nil {
				integrationError(w, e)
				return
			}
			out.Status = status
			items = append(items, out)
		}
		if e = rows.Err(); e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("POST /api/integration-registrations/{id}/approve", h.authenticated(func(w http.ResponseWriter, r *http.Request, a session) {
		var in IntegrationGrantInput
		if !integrationDecode(w, r, &in) {
			return
		}
		out, e := s.Approve(r.Context(), r.PathValue("id"), in, a.Username)
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 201, out)
	}))
	h.mux.HandleFunc("POST /api/integration-registrations/{id}/reject", h.authenticated(func(w http.ResponseWriter, r *http.Request, a session) {
		tx, e := s.store.pool.Begin(r.Context())
		if e != nil {
			integrationError(w, e)
			return
		}
		defer tx.Rollback(r.Context())
		tag, e := tx.Exec(r.Context(), "UPDATE integration_registrations SET status='rejected' WHERE id=$1 AND status='pending'", r.PathValue("id"))
		if e == nil && tag.RowsAffected() != 1 {
			e = ErrConflict
		}
		if e == nil {
			e = integrationAudit(r.Context(), tx, "", "registration_rejected", a.Username, s.store.now())
		}
		if e == nil {
			e = tx.Commit(r.Context())
		}
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "rejected"})
	}))
	h.mux.HandleFunc("GET /api/integration-clients", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		rows, e := s.store.pool.Query(r.Context(), "SELECT metadata FROM integration_clients ORDER BY created_at DESC LIMIT 100")
		if e != nil {
			integrationError(w, e)
			return
		}
		defer rows.Close()
		items := []IntegrationClient{}
		for rows.Next() {
			var raw []byte
			var c IntegrationClient
			if e = rows.Scan(&raw); e == nil {
				e = json.Unmarshal(raw, &c)
			}
			if e != nil {
				integrationError(w, e)
				return
			}
			items = append(items, c)
		}
		if e = rows.Err(); e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("GET /api/integration-clients/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		out, e := s.Client(r.Context(), r.PathValue("id"))
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("PUT /api/integration-clients/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, a session) {
		var in IntegrationGrantInput
		if !integrationDecode(w, r, &in) {
			return
		}
		out, e := s.Update(r.Context(), r.PathValue("id"), in, a.Username)
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("POST /api/integration-clients/{id}/rotate", h.authenticated(func(w http.ResponseWriter, r *http.Request, a session) {
		out, e := s.Rotate(r.Context(), r.PathValue("id"), a.Username)
		if e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 201, out)
	}))
	for _, action := range []string{"suspend", "resume", "revoke"} {
		h.mux.HandleFunc("POST /api/integration-clients/{id}/"+action, h.authenticated(func(w http.ResponseWriter, r *http.Request, a session) {
			if e := s.Transition(r.Context(), r.PathValue("id"), action, a.Username); e != nil {
				integrationError(w, e)
				return
			}
			out, _ := s.Client(r.Context(), r.PathValue("id"))
			writeJSON(w, 200, map[string]string{"status": out.Status})
		}))
	}
	h.mux.HandleFunc("POST /api/integrations/v1/clients/self/activate", func(w http.ResponseWriter, r *http.Request) {
		body, ok := integrationReadBody(w, r)
		if !ok {
			return
		}
		if e := s.Activate(r, body); e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "active"})
	})
	h.mux.HandleFunc("GET /api/integration-audit", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		rows, e := s.store.pool.Query(r.Context(), "SELECT id,client_id,action,actor,created_at FROM integration_audit WHERE ($1='' OR client_id=$1) ORDER BY id DESC LIMIT 100", r.URL.Query().Get("client_id"))
		if e != nil {
			integrationError(w, e)
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id int64
			var client, action, actor string
			var created time.Time
			if e = rows.Scan(&id, &client, &action, &actor, &created); e != nil {
				integrationError(w, e)
				return
			}
			items = append(items, map[string]any{"id": id, "client_id": client, "action": action, "actor": actor, "created_at": created})
		}
		if e = rows.Err(); e != nil {
			integrationError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
}

func integrationDecode(w http.ResponseWriter, r *http.Request, out any) bool {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(w, 400, "invalid_request", "请求需要 JSON 格式")
		return false
	}
	body, ok := integrationReadBody(w, r)
	if !ok {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(out); e != nil {
		fail(w, 400, "invalid_request", "请求字段或格式不符合限制")
		return false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		fail(w, 400, "invalid_request", "请求只允许一个 JSON 对象")
		return false
	}
	return true
}
func (s *IntegrationService) registrationAttempt(ctx context.Context, remote string) error {
	return s.gatewayAttempt(ctx, remote, "registration", 120, 10)
}
