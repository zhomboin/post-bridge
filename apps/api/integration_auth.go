package bridge

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed integration_schema.sql
var integrationSchemaSQL string

type IntegrationClient struct {
	OwnerUserID         string    `json:"owner_user_id,omitempty"`
	AIProcessingAllowed bool      `json:"ai_processing_allowed,omitempty"`
	FormattingPlatforms []string  `json:"formatting_platforms,omitempty"`
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	SourceID            string    `json:"source_id"`
	Environment         string    `json:"environment"`
	ServiceID           string    `json:"service_id"`
	Status              string    `json:"status"`
	Scopes              []string  `json:"scopes"`
	Accounts            []string  `json:"accounts"`
	Operations          []string  `json:"operations"`
	GrantVersion        int64     `json:"grant_version"`
	ExpiresAt           time.Time `json:"expires_at"`
	RateLimitPerMinute  int       `json:"rate_limit_per_minute"`
}
type IntegrationPrincipal struct {
	IntegrationClient
	KeyID string `json:"key_id"`
}
type IntegrationService struct {
	store                          *Store
	aead                           cipher.AEAD
	environment, serviceID, origin string
}

func NewIntegrationService(store *Store, masterKeyHex, environment, serviceID, publicOrigin string) (*IntegrationService, error) {
	key, e := hex.DecodeString(masterKeyHex)
	if e != nil || len(key) != 32 || store == nil || !integrationIdentifier.MatchString(environment) || !integrationIdentifier.MatchString(serviceID) || validateIntegrationURL(publicOrigin) != nil {
		return nil, ErrInvalid
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	return &IntegrationService{
		store:       store,
		aead:        aead,
		environment: environment,
		serviceID:   serviceID,
		origin:      strings.TrimSuffix(publicOrigin, "/"),
	}, nil
}
func (s *IntegrationService) seal(raw []byte, identity string) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return nil, e
	}
	return s.aead.Seal(nonce, nonce, raw, []byte(identity)), nil
}
func (s *IntegrationService) open(raw []byte, identity string) ([]byte, error) {
	n := s.aead.NonceSize()
	if len(raw) < n {
		return nil, ErrIntegrationAuthentication
	}
	return s.aead.Open(nil, raw[:n], raw[n:], []byte(identity))
}
func integrationAudit(ctx context.Context, tx pgx.Tx, client, action, actor string, now time.Time) error {
	_, e := tx.Exec(ctx, "INSERT INTO integration_audit(client_id,action,actor,created_at) VALUES($1,$2,$3,$4)", client, action, actor, now)
	return e
}
func (s *IntegrationService) Client(ctx context.Context, id string) (IntegrationClient, error) {
	var c IntegrationClient
	var raw []byte
	e := s.store.pool.QueryRow(ctx, "SELECT metadata || jsonb_build_object('owner_user_id',owner_user_id) FROM integration_clients WHERE id=$1", id).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(raw, &c)
	return c, e
}
func integrationLoadClient(ctx context.Context, tx pgx.Tx, id string) (IntegrationClient, error) {
	var c IntegrationClient
	var raw []byte
	e := tx.QueryRow(ctx, "SELECT metadata || jsonb_build_object('owner_user_id',owner_user_id) FROM integration_clients WHERE id=$1 FOR UPDATE", id).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(raw, &c)
	return c, e
}
func integrationSaveClient(ctx context.Context, tx pgx.Tx, c IntegrationClient) error {
	owner, err := integrationOwner(ctx, tx)
	if err != nil {
		return err
	}
	if err = integrationOwnedAccounts(ctx, tx, owner, c.Accounts); err != nil && c.Status != "revoked" && c.Status != "suspended" {
		return err
	}
	raw, e := json.Marshal(c)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE integration_clients SET metadata=$2 WHERE id=$1", c.ID, raw)
	return e
}
func (s *IntegrationService) Secret(ctx context.Context, keyID string) ([]byte, error) {
	var raw []byte
	e := s.store.pool.QueryRow(ctx, "SELECT encrypted_secret FROM integration_keys WHERE id=$1 AND status IN ('active','handover','pending_activation') AND expires_at>$2", keyID, s.store.now()).Scan(&raw)
	if e != nil {
		return nil, ErrIntegrationAuthentication
	}
	return s.open(raw, keyID)
}
func integrationHas(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
func (s *IntegrationService) CheckPermission(ctx context.Context, id, scope, account, operation string) error {
	c, e := s.Client(ctx, id)
	if e != nil {
		return ErrIntegrationAuthentication
	}
	if c.Status != "active" || !c.ExpiresAt.After(s.store.now()) {
		return ErrIntegrationAuthentication
	}
	var valid bool
	e = s.store.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM integration_keys WHERE client_id=$1 AND status IN ('active','handover') AND expires_at>$2)", id, s.store.now()).Scan(&valid)
	if e != nil || !valid {
		return ErrIntegrationAuthentication
	}
	if scope != "" && !integrationHas(c.Scopes, scope) || account != "" && !integrationHas(c.Accounts, account) || operation != "" && !integrationHas(c.Operations, operation) {
		return ErrIntegrationPermission
	}
	return nil
}
func integrationRate(ctx context.Context, tx pgx.Tx, subject string, limit int, now time.Time) error {
	var count int
	e := tx.QueryRow(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES($1,$2,1) ON CONFLICT(subject,window_start) DO UPDATE SET count=integration_rate_windows.count+1 WHERE integration_rate_windows.count<=$3 RETURNING count", subject, now.Unix()/60, limit).Scan(&count)
	if errors.Is(e, pgx.ErrNoRows) {
		return ErrIntegrationRateLimited
	}
	if e != nil {
		return e
	}
	if count > limit {
		return ErrIntegrationRateLimited
	}
	return nil
}
func (s *IntegrationService) Authenticate(r *http.Request, body []byte, scope string) (IntegrationPrincipal, error) {
	p, e := s.authenticate(r, body, false)
	if e != nil {
		return p, e
	}
	if !integrationHas(p.Scopes, scope) {
		_, _ = s.store.pool.Exec(r.Context(), "INSERT INTO integration_audit(client_id,action,actor,created_at) VALUES($1,'request_denied','integration',$2)", p.ID, s.store.now())
		return IntegrationPrincipal{}, ErrIntegrationPermission
	}
	return p, nil
}
func (s *IntegrationService) authenticate(r *http.Request, body []byte, activate bool) (IntegrationPrincipal, error) {
	var result IntegrationPrincipal
	// 共享持久网关先限制匿名流量，再查询身份或写入逐条拒绝审计。
	if e := s.gatewayAttempt(r.Context(), r.RemoteAddr, "preauth", integrationPreauthGlobalLimit, integrationPreauthIPLimit); e != nil {
		if errors.Is(e, ErrIntegrationRateLimited) {
			return result, e
		}
		return result, ErrIntegrationAuthentication
	}
	var tx pgx.Tx
	deny := func(e error) (IntegrationPrincipal, error) {
		if tx != nil {
			_ = tx.Rollback(r.Context())
		}
		_, _ = s.store.pool.Exec(r.Context(), "INSERT INTO integration_audit(action,actor,created_at) VALUES('request_denied','integration', $1)", s.store.now())
		return result, e
	}
	if len(body) > IntegrationBodyLimit {
		return deny(ErrIntegrationAuthentication)
	}
	m := integrationInput.FindStringSubmatch(r.Header.Get("Signature-Input"))
	if m == nil {
		return deny(ErrIntegrationAuthentication)
	}
	ctx := r.Context()
	var e error
	tx, e = s.store.pool.Begin(ctx)
	if e != nil {
		return deny(ErrIntegrationAuthentication)
	}
	defer tx.Rollback(ctx)
	c, e := integrationLoadClient(ctx, tx, r.Header.Get("X-Integration-Client"))
	now := s.store.now()
	if e == nil {
		var active bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND enabled) OR ($1='' AND NOT EXISTS(SELECT 1 FROM users))", c.OwnerUserID).Scan(&active)
		if e != nil || !active {
			return deny(ErrIntegrationAuthentication)
		}
	}
	if e != nil || c.Environment != s.environment || c.ServiceID != s.serviceID || r.Header.Get("X-Integration-Environment") != s.environment || r.Header.Get("X-Integration-Service") != s.serviceID || !c.ExpiresAt.After(now) {
		return deny(ErrIntegrationAuthentication)
	}
	if activate {
		if c.Status != "pending_activation" && c.Status != "active" {
			return deny(ErrIntegrationAuthentication)
		}
	} else if c.Status != "active" {
		return deny(ErrIntegrationAuthentication)
	}
	var encrypted []byte
	var status string
	var expires time.Time
	e = tx.QueryRow(ctx, "SELECT encrypted_secret,status,expires_at FROM integration_keys WHERE id=$1 AND client_id=$2 FOR UPDATE", m[2], c.ID).Scan(&encrypted, &status, &expires)
	if e != nil || !expires.After(now) || activate && status != "pending_activation" || !activate && status != "active" && status != "handover" {
		return deny(ErrIntegrationAuthentication)
	}
	secret, e := s.open(encrypted, m[2])
	if e != nil || VerifyIntegrationRequest(r, body, s.origin, secret, now) != nil {
		return deny(ErrIntegrationAuthentication)
	}
	if e = integrationRate(ctx, tx, c.ID, c.RateLimitPerMinute, now); e != nil {
		if errors.Is(e, ErrIntegrationRateLimited) {
			if commit := tx.Commit(ctx); commit != nil {
				return result, ErrIntegrationAuthentication
			}
			return result, e
		}
		return deny(ErrIntegrationAuthentication)
	}
	_, e = tx.Exec(ctx, "DELETE FROM integration_nonces WHERE expires_at<=$1", now)
	if e != nil {
		return deny(ErrIntegrationAuthentication)
	}
	_, e = tx.Exec(ctx, "INSERT INTO integration_nonces(client_id,key_id,nonce_hash,expires_at) VALUES($1,$2,$3,$4)", c.ID, m[2], hashToken(m[3]), now.Add(601*time.Second))
	if e != nil {
		return deny(ErrIntegrationAuthentication)
	}
	if activate {
		_, e = tx.Exec(ctx, "UPDATE integration_keys SET status='handover',expires_at=LEAST(expires_at,$2) WHERE client_id=$1 AND status='active'", c.ID, now.Add(10*time.Minute))
		if e != nil {
			return deny(ErrIntegrationAuthentication)
		}
		_, e = tx.Exec(ctx, "UPDATE integration_keys SET status='active' WHERE id=$1", m[2])
		if e != nil {
			return deny(ErrIntegrationAuthentication)
		}
		c.Status = "active"
		if e = integrationSaveClient(ctx, tx, c); e != nil {
			return deny(ErrIntegrationAuthentication)
		}
		if e = integrationAudit(ctx, tx, c.ID, "activated", "integration", now); e != nil {
			return deny(ErrIntegrationAuthentication)
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return deny(ErrIntegrationAuthentication)
	}
	return IntegrationPrincipal{IntegrationClient: c, KeyID: m[2]}, nil
}
func (s *IntegrationService) Activate(r *http.Request, body []byte) error {
	_, e := s.authenticate(r, body, true)
	return e
}
func integrationReadBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, IntegrationBodyLimit))
	if e != nil {
		fail(w, 413, "request_too_large", "请求超出大小限制")
		return nil, false
	}
	return b, true
}

const integrationPreauthGlobalLimit = 2400
const integrationPreauthIPLimit = 600

func integrationRemoteSubject(remote string) string {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	// 不采信转发头；无法解析的连接地址共用一份匿名配额。
	address := net.ParseIP(host)
	if address == nil {
		return hashToken("unknown")
	}
	return hashToken(address.String())
}
func (s *IntegrationService) gatewayAttempt(ctx context.Context, remote, prefix string, globalLimit, ipLimit int) error {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	now := s.store.now()
	// 全局计数先占用名额，拒绝后不再为任意新地址创建记录。
	e = integrationRate(ctx, tx, prefix+"-global", globalLimit, now)
	if e == nil {
		e = integrationRate(ctx, tx, prefix+"-ip:"+integrationRemoteSubject(remote), ipLimit, now)
	}
	if e != nil && !errors.Is(e, ErrIntegrationRateLimited) {
		return e
	}
	if commit := tx.Commit(ctx); commit != nil {
		return commit
	}
	return e
}
