package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIntegrationRegistryLifecycleReplayAndGrant(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	if _, err := st.pool.Exec(ctx, integrationSchemaSQL); err != nil {
		t.Fatal(err)
	}
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	now := st.now()
	inv, e := s.Invite(ctx, IntegrationInvitationInput{SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, ExpiresAt: now.Add(time.Hour), ClientExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 20}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	registration := IntegrationRegistrationInput{Name: "CMS", SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}}
	reg, e := s.Register(ctx, inv.Token, registration)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Register(ctx, inv.Token, registration); e == nil {
		t.Fatal("invitation replay")
	}
	grant := IntegrationGrantInput{Scopes: registration.Scopes, Accounts: registration.Accounts, Operations: registration.Operations, ExpiresAt: now.Add(12 * time.Hour), RateLimitPerMinute: 20}
	issue, e := s.Approve(ctx, reg.ID, grant, "admin")
	if e != nil {
		t.Fatal(e)
	}
	secret, e := base64.StdEncoding.DecodeString(issue.Secret)
	if e != nil {
		t.Fatal(e)
	}
	id := IntegrationSigningIdentity{ClientID: issue.ClientID, KeyID: issue.KeyID, Environment: "test", ServiceID: "bridge-test"}
	req := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
	SignIntegrationRequest(req, nil, id, secret, now, "nonce-inactive-012345")
	if _, e = s.Authenticate(req, nil, "targets:read"); e == nil {
		t.Fatal("inactive client accepted")
	}
	activation := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/clients/self/activate", nil)
	SignIntegrationRequest(activation, nil, id, secret, now, "nonce-activate-012345")
	if e = s.Activate(activation, nil); e != nil {
		t.Fatal(e)
	}
	SignIntegrationRequest(req, nil, id, secret, now, "nonce-business-012345")
	p, e := s.Authenticate(req, nil, "targets:read")
	if e != nil || p.SourceID != "cms" {
		t.Fatal(e)
	}
	s2, _ := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if _, e = s2.Authenticate(req, nil, "targets:read"); e == nil {
		t.Fatal("cross-instance replay")
	}
	if e = s.CheckPermission(ctx, p.ID, "targets:read", "csdn-main", "publish"); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	grant.Operations = []string{}
	if _, e = s.Update(ctx, p.ID, grant, "admin"); e != nil {
		t.Fatal(e)
	}
	c, _ := s.Client(ctx, p.ID)
	if c.GrantVersion != 2 {
		t.Fatal(c.GrantVersion)
	}
	if e = s.CheckPermission(ctx, p.ID, "targets:read", "csdn-main", "save_draft"); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	issue2, e := s.Rotate(ctx, p.ID, "admin")
	if e != nil {
		t.Fatal(e)
	}
	c, _ = s.Client(ctx, p.ID)
	if c.GrantVersion != 2 {
		t.Fatal("rotation changed grants")
	}
	if e = s.Transition(ctx, p.ID, "suspend", "admin"); e != nil {
		t.Fatal(e)
	}
	secret2, _ := base64.StdEncoding.DecodeString(issue2.Secret)
	id.KeyID = issue2.KeyID
	SignIntegrationRequest(activation, nil, id, secret2, now, "nonce-suspended-012345")
	if e = s.Activate(activation, nil); e == nil {
		t.Fatal("activation resumed suspended client")
	}
	raw, _ := json.Marshal(c)
	if strings.Contains(string(raw), issue.Secret) || strings.Contains(string(raw), "source_secret") {
		t.Fatal("secret in JSON")
	}
	var ciphertext []byte
	if e = st.pool.QueryRow(ctx, "SELECT encrypted_secret FROM integration_keys WHERE id=$1", issue.KeyID).Scan(&ciphertext); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(ciphertext), string(secret)) {
		t.Fatal("plaintext key")
	}
}
func seedIntegrationClient(ctx context.Context, s *IntegrationService, c IntegrationClient) error {
	tx, e := s.store.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	now := s.store.now()
	inv := "seed-inv-" + c.ID
	reg := "seed-reg-" + c.ID
	_, e = tx.Exec(ctx, "INSERT INTO integration_invitations(id,token_hash,settings,expires_at,created_at) VALUES($1,$2,'{}',$3,$4)", inv, hashToken(inv), now.Add(time.Hour), now)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO integration_registrations(id,invitation_id,application,status,created_at) VALUES($1,$2,'{}','approved',$3)", reg, inv, now)
	if e != nil {
		return e
	}
	if c.RateLimitPerMinute == 0 {
		c.RateLimitPerMinute = 60
	}
	raw, _ := json.Marshal(c)
	_, e = tx.Exec(ctx, "INSERT INTO integration_clients(id,registration_id,metadata,created_at) VALUES($1,$2,$3,$4)", c.ID, reg, raw, now)
	if e != nil {
		return e
	}
	issued, e := s.issue(ctx, tx, c)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE integration_keys SET status='active' WHERE id=$1", issued.KeyID)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func TestIntegrationInvitationBoundsAndApprovalCeiling(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	now := st.now()
	input := IntegrationInvitationInput{SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, ExpiresAt: now.Add(time.Hour), ClientExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 3}
	inv, e := s.Invite(ctx, input, "admin")
	if e != nil {
		t.Fatal(e)
	}
	registration := IntegrationRegistrationInput{Name: "CMS", SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}}
	bad := registration
	bad.SourceID = "other"
	if _, e = s.Register(ctx, inv.Token, bad); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	bad = registration
	bad.Operations = []string{"publish"}
	if _, e = s.Register(ctx, inv.Token, bad); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	reg, e := s.Register(ctx, inv.Token, registration)
	if e != nil {
		t.Fatal(e)
	}
	grant := IntegrationGrantInput{Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"publish"}, ExpiresAt: now.Add(12 * time.Hour), RateLimitPerMinute: 3}
	if _, e = s.Approve(ctx, reg.ID, grant, "admin"); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	grant.Operations = []string{"save_draft"}
	grant.ExpiresAt = now.Add(25 * time.Hour)
	if _, e = s.Approve(ctx, reg.ID, grant, "admin"); e != ErrIntegrationPermission {
		t.Fatal(e)
	}
	grant.ExpiresAt = now.Add(12 * time.Hour)
	issue, e := s.Approve(ctx, reg.ID, grant, "admin")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Approve(ctx, reg.ID, grant, "admin"); e != ErrConflict {
		t.Fatal(e)
	}
	secret, _ := base64.StdEncoding.DecodeString(issue.Secret)
	id := IntegrationSigningIdentity{ClientID: issue.ClientID, KeyID: issue.KeyID, Environment: "test", ServiceID: "bridge-test"}
	a := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/clients/self/activate", nil)
	SignIntegrationRequest(a, nil, id, secret, now, "nonce-bounds-activation")
	if e = s.Activate(a, nil); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
		SignIntegrationRequest(req, nil, id, secret, now, fmt.Sprintf("nonce-rate-%016d", i))
		if _, e = s.Authenticate(req, nil, "targets:read"); e != nil {
			t.Fatal(e)
		}
	}
	req := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
	SignIntegrationRequest(req, nil, id, secret, now, "nonce-rate-limit-0001")
	if _, e = s.Authenticate(req, nil, "targets:read"); e != ErrIntegrationRateLimited {
		t.Fatalf("missing rate limit: %v", e)
	}
	st.now = func() time.Time { return now.Add(13 * time.Hour) }
	if e = s.CheckPermission(ctx, issue.ClientID, "targets:read", "csdn-main", "save_draft"); e == nil {
		t.Fatal("expired client authorized")
	}
}

func TestIntegrationAdminRoutesRequireSessionAndCSRF(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	h0, e := NewHandler(ctx, Config{Store: st, AdminUsername: "admin", AdminPassword: "private-test-password", WorkerToken: strings.Repeat("w", 32), Origin: "https://bridge.example", IntegrationMasterKey: strings.Repeat("ab", 32), IntegrationEnvironment: "test", IntegrationServiceID: "bridge-test"})
	if e != nil {
		t.Fatal(e)
	}
	h := h0.(*handler)
	token := strings.Repeat("a", 64)
	csrf := "private-test-csrf"
	_, e = st.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin',$2,$3)", hashToken(token), csrf, st.now().Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"/api/integration-invitations", "/api/integration-registrations/missing/approve", "/api/integration-registrations/missing/reject", "/api/integration-clients/missing/rotate", "/api/integration-clients/missing/suspend", "/api/integration-clients/missing/resume", "/api/integration-clients/missing/revoke"} {
		req := httptest.NewRequest("POST", "https://bridge.example"+path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("%s without session: %d", path, w.Code)
		}
		req.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
		w = httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("%s without csrf: %d", path, w.Code)
		}
	}
	req := httptest.NewRequest("PUT", "https://bridge.example/api/integration-clients/missing", strings.NewReader("{}"))
	req.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	for _, path := range []string{"/api/integration-clients", "/api/integration-clients/missing", "/api/integration-registrations", "/api/integration-audit"} {
		req := httptest.NewRequest("GET", "https://bridge.example"+path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
}
func TestIntegrationInvitationListNeverReturnsToken(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	h0, e := NewHandler(ctx, Config{Store: st, AdminUsername: "admin", AdminPassword: "private-test-password", WorkerToken: strings.Repeat("w", 32), Origin: "https://bridge.example", IntegrationMasterKey: strings.Repeat("ab", 32), IntegrationEnvironment: "test", IntegrationServiceID: "bridge-test"})
	if e != nil {
		t.Fatal(e)
	}
	h := h0.(*handler)
	now := st.now()
	invitation, e := h.integrations.Invite(ctx, IntegrationInvitationInput{SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, ExpiresAt: now.Add(time.Hour), ClientExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 3}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	token := strings.Repeat("b", 64)
	_, e = st.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin','test-csrf',$2)", hashToken(token), now.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", "https://bridge.example/api/integration-invitations", nil)
	r.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), invitation.ID) || strings.Contains(w.Body.String(), invitation.Token) || strings.Contains(w.Body.String(), hashToken(invitation.Token)) {
		t.Fatalf("unsafe list: %d %s", w.Code, w.Body.String())
	}
}
func TestIntegrationRotationHandoverAndClockBoundary(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	now := time.Unix(1800000000, 0).UTC()
	st.now = func() time.Time { return now }
	c := IntegrationClient{ID: "clock-client", Name: "Clock", SourceID: "cms", Environment: "test", ServiceID: "bridge-test", Status: "active", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, GrantVersion: 1, ExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 100}
	if e = seedIntegrationClient(ctx, s, c); e != nil {
		t.Fatal(e)
	}
	var oldKey string
	if e = st.pool.QueryRow(ctx, "SELECT id FROM integration_keys WHERE client_id=$1", c.ID).Scan(&oldKey); e != nil {
		t.Fatal(e)
	}
	secret, e := s.Secret(ctx, oldKey)
	if e != nil {
		t.Fatal(e)
	}
	oldID := IntegrationSigningIdentity{ClientID: c.ID, KeyID: oldKey, Environment: "test", ServiceID: "bridge-test"}
	request := func(id IntegrationSigningIdentity, secret []byte, at time.Time, nonce string) *http.Request {
		r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
		if e = SignIntegrationRequest(r, nil, id, secret, at, nonce); e != nil {
			t.Fatal(e)
		}
		return r
	}
	future := request(oldID, secret, now.Add(300*time.Second), "nonce-future-boundary-1")
	if _, e = s.Authenticate(future, nil, "targets:read"); e != nil {
		t.Fatal(e)
	}
	now = now.Add(600 * time.Second)
	if _, e = s.Authenticate(future, nil, "targets:read"); e == nil {
		t.Fatal("nonce replay at inclusive time boundary")
	}
	for _, offset := range []int{-301, 301} {
		r := request(oldID, secret, now.Add(time.Duration(offset)*time.Second), fmt.Sprintf("nonce-skew-%016d", offset+1000))
		if _, e = s.Authenticate(r, nil, "targets:read"); e == nil {
			t.Fatal("out-of-window signature")
		}
	}
	next, e := s.Rotate(ctx, c.ID, "admin")
	if e != nil {
		t.Fatal(e)
	}
	nextSecret, _ := base64.StdEncoding.DecodeString(next.Secret)
	nextID := oldID
	nextID.KeyID = next.KeyID
	if _, e = s.Authenticate(request(nextID, nextSecret, now, "nonce-rotation-pending-1"), nil, "targets:read"); e == nil {
		t.Fatal("unproven rotated key")
	}
	a := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/clients/self/activate", nil)
	SignIntegrationRequest(a, nil, nextID, nextSecret, now, "nonce-rotation-activate-1")
	if e = s.Activate(a, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Authenticate(request(oldID, secret, now, "nonce-old-handover-00001"), nil, "targets:read"); e != nil {
		t.Fatal(e)
	}
	now = now.Add(10 * time.Minute)
	if _, e = s.Authenticate(request(oldID, secret, now, "nonce-old-expired-000001"), nil, "targets:read"); e == nil {
		t.Fatal("expired handover key")
	}
	if _, e = s.Authenticate(request(nextID, nextSecret, now, "nonce-new-active-000001"), nil, "targets:read"); e != nil {
		t.Fatal(e)
	}
	if e = s.Transition(ctx, c.ID, "revoke", "admin"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Authenticate(request(nextID, nextSecret, now, "nonce-after-revoke-00001"), nil, "targets:read"); e == nil {
		t.Fatal("revoked client")
	}
	if e = s.Transition(ctx, c.ID, "resume", "admin"); e != ErrConflict {
		t.Fatal("revoked client restored", e)
	}
}

func TestIntegrationRegistrationMissingInvitationAndOversizedBody(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	h0, e := NewHandler(ctx, Config{Store: st, AdminUsername: "admin", AdminPassword: "private-test-password", WorkerToken: strings.Repeat("w", 32), Origin: "https://bridge.example", IntegrationMasterKey: strings.Repeat("ab", 32), IntegrationEnvironment: "test", IntegrationServiceID: "bridge-test"})
	if e != nil {
		t.Fatal(e)
	}
	h := h0.(*handler)
	input := IntegrationRegistrationInput{Name: "CMS", SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}}
	raw, _ := json.Marshal(input)
	r := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/registrations", strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("missing invitation: %d", w.Code)
	}
	r = httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/registrations", strings.NewReader(strings.Repeat(" ", IntegrationBodyLimit+1)))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("oversized body: %d", w.Code)
	}
}

func TestIntegrationMissingClientManagementReturnsNotFound(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Update(ctx, "missing", IntegrationGrantInput{}, "admin"); e != ErrNotFound {
		t.Fatalf("update: %v", e)
	}
	if _, e = s.Rotate(ctx, "missing", "admin"); e != ErrNotFound {
		t.Fatalf("rotate: %v", e)
	}
	if e = s.Transition(ctx, "missing", "suspend", "admin"); e != ErrNotFound {
		t.Fatalf("suspend: %v", e)
	}
}
func TestIntegrationConcurrentInvitationAndNonceSingleConsumption(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	now := st.now()
	inv, e := s.Invite(ctx, IntegrationInvitationInput{SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, ExpiresAt: now.Add(time.Hour), ClientExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 60}, "admin")
	if e != nil {
		t.Fatal(e)
	}
	registration := IntegrationRegistrationInput{Name: "CMS", SourceID: "cms", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}}
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, e := s.Register(ctx, inv.Token, registration); results <- e }()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("invitation consumed %d times", success)
	}
	c := IntegrationClient{ID: "concurrent-client", Name: "Concurrent", SourceID: "cms", Environment: "test", ServiceID: "bridge-test", Status: "active", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, GrantVersion: 1, ExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 100}
	if e = seedIntegrationClient(ctx, s, c); e != nil {
		t.Fatal(e)
	}
	var key string
	if e = st.pool.QueryRow(ctx, "SELECT id FROM integration_keys WHERE client_id=$1", c.ID).Scan(&key); e != nil {
		t.Fatal(e)
	}
	secret, e := s.Secret(ctx, key)
	if e != nil {
		t.Fatal(e)
	}
	id := IntegrationSigningIdentity{ClientID: c.ID, KeyID: key, Environment: "test", ServiceID: "bridge-test"}
	req := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
	SignIntegrationRequest(req, nil, id, secret, now, "nonce-concurrent-012345")
	s2, _ := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	results = make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			service := s
			if n%2 == 1 {
				service = s2
			}
			_, e := service.Authenticate(req.Clone(ctx), nil, "targets:read")
			results <- e
		}(i)
	}
	wg.Wait()
	close(results)
	success = 0
	for e := range results {
		if e == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("nonce consumed %d times", success)
	}
}

func TestIntegrationPreauthenticationBoundsAuditAndSubjects(t *testing.T) {
	for _, kind := range []string{"missing", "bad_signature", "activation"} {
		t.Run(kind, func(t *testing.T) {
			st := testStore(t)
			ctx := context.Background()
			service, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
			if e != nil {
				t.Fatal(e)
			}
			clock := time.Unix(1800000000, 0).UTC()
			st.now = func() time.Time { return clock }
			if _, e = st.pool.Exec(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES('preauth-global',$1,2395)", clock.Unix()/60); e != nil {
				t.Fatal(e)
			}
			identity := IntegrationSigningIdentity{ClientID: "unknown-client", KeyID: "unknown-key", Environment: "test", ServiceID: "bridge-test"}
			if kind == "bad_signature" {
				client := IntegrationClient{ID: "bad-signature-client", Name: "坏签名压测", SourceID: "cms", Environment: "test", ServiceID: "bridge-test", Status: "active", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, GrantVersion: 1, ExpiresAt: clock.Add(time.Hour), RateLimitPerMinute: 60}
				if e = seedIntegrationClient(ctx, service, client); e != nil {
					t.Fatal(e)
				}
				identity.ClientID = client.ID
				if e = st.pool.QueryRow(ctx, "SELECT id FROM integration_keys WHERE client_id=$1", client.ID).Scan(&identity.KeyID); e != nil {
					t.Fatal(e)
				}
			}
			for i := 0; i < 20; i++ {
				r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
				r.RemoteAddr = fmt.Sprintf("198.51.100.%d:1234", i+1)
				if kind == "bad_signature" {
					SignIntegrationRequest(r, nil, identity, []byte(strings.Repeat("x", 32)), clock, "nonce-invalid-signature-1")
					r.Header.Set("Signature", "sig1=:invalid:")
				}
				var got error
				if kind == "activation" {
					r.Method = "POST"
					r.URL.Path = "/api/integrations/v1/clients/self/activate"
					got = service.Activate(r, nil)
				} else {
					_, got = service.Authenticate(r, nil, "targets:read")
				}
				expected := ErrIntegrationAuthentication
				if i >= 5 {
					expected = ErrIntegrationRateLimited
				}
				if got != expected {
					t.Fatalf("request %d: got %v want %v", i, got, expected)
				}
			}
			var audits, subjects, maxCount int
			if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_audit WHERE action='request_denied'").Scan(&audits); e != nil {
				t.Fatal(e)
			}
			if e = st.pool.QueryRow(ctx, "SELECT count(*),max(count) FROM integration_rate_windows WHERE subject LIKE 'preauth-%'").Scan(&subjects, &maxCount); e != nil {
				t.Fatal(e)
			}
			if audits != 5 || subjects != 6 || maxCount != 2401 {
				t.Fatalf("unbounded storage: audits=%d subjects=%d max=%d", audits, subjects, maxCount)
			}
			clock = clock.Add(time.Minute)
			r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
			r.RemoteAddr = "198.51.100.99:1234"
			if _, e = service.Authenticate(r, nil, "targets:read"); e != ErrIntegrationAuthentication {
				t.Fatalf("window did not recover: %v", e)
			}
			if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_audit WHERE action='request_denied'").Scan(&audits); e != nil || audits != 6 {
				t.Fatalf("missing resumed-window audit: %d %v", audits, e)
			}
		})
	}
}
func TestIntegrationPreauthenticationSharesIPBudgetAndRejectsForwardedSpoofing(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	s2, _ := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	now := time.Unix(1800000000, 0).UTC()
	st.now = func() time.Time { return now }
	subject := "preauth-ip:" + hashToken("198.51.100.5")
	if _, e = st.pool.Exec(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES($1,$2,599)", subject, now.Unix()/60); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
	r.RemoteAddr = "198.51.100.5:9001"
	if _, e = s.Authenticate(r, nil, "targets:read"); e != ErrIntegrationAuthentication {
		t.Fatal(e)
	}
	for i := 0; i < 20; i++ {
		r := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/clients/self/activate", nil)
		r.RemoteAddr = fmt.Sprintf("198.51.100.5:%d", 9100+i)
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i+1))
		if e = s2.Activate(r, nil); e != ErrIntegrationRateLimited {
			t.Fatalf("activation bypass: %v", e)
		}
	}
	var audits, count int
	if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_audit WHERE action='request_denied'").Scan(&audits); e != nil {
		t.Fatal(e)
	}
	if e = st.pool.QueryRow(ctx, "SELECT count FROM integration_rate_windows WHERE subject=$1 AND window_start=$2", subject, now.Unix()/60).Scan(&count); e != nil {
		t.Fatal(e)
	}
	if audits != 1 || count != 601 {
		t.Fatalf("unbounded IP denials: audits=%d count=%d", audits, count)
	}
	var leaked bool
	if e = st.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM integration_rate_windows WHERE subject LIKE '%198.51.100.5%' OR subject LIKE '%203.0.113%')").Scan(&leaked); e != nil || leaked {
		t.Fatal("raw address persisted", e)
	}
}
func TestIntegrationPreauthenticationConcurrentGlobalBudgetCapsNewSubjects(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	now := time.Unix(1800000000, 0).UTC()
	st.now = func() time.Time { return now }
	if _, e = st.pool.Exec(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES('preauth-global',$1,2399)", now.Unix()/60); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
			r.RemoteAddr = fmt.Sprintf("198.51.100.%d:1234", n+1)
			_, e := s.Authenticate(r, nil, "targets:read")
			results <- e
		}(i)
	}
	wg.Wait()
	close(results)
	admitted := 0
	for e := range results {
		if e == ErrIntegrationAuthentication {
			admitted++
		} else if e != ErrIntegrationRateLimited {
			t.Fatal(e)
		}
	}
	if admitted != 1 {
		t.Fatalf("global admitted %d", admitted)
	}
	var subjects int
	if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_rate_windows WHERE subject LIKE 'preauth-%'").Scan(&subjects); e != nil || subjects != 2 {
		t.Fatalf("new subject flood: %d %v", subjects, e)
	}
}
func TestIntegrationPreauthenticationDatabaseUnavailableFailsClosed(t *testing.T) {
	st := testStore(t)
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	st.pool.Close()
	r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
	if _, e = s.Authenticate(r, nil, "targets:read"); e != ErrIntegrationAuthentication {
		t.Fatalf("DB failure not denied: %v", e)
	}
}

func TestIntegrationPreauthenticationSaturatedWindowDoesNotRewriteCounter(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, e := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if e != nil {
		t.Fatal(e)
	}
	clock := time.Unix(1800000000, 0)
	st.now = func() time.Time { return clock }
	if _, e = st.pool.Exec(ctx, "INSERT INTO integration_rate_windows(subject,window_start,count) VALUES('preauth-global',$1,2401)", clock.Unix()/60); e != nil {
		t.Fatal(e)
	}
	var before, after string
	if e = st.pool.QueryRow(ctx, "SELECT xmin::text FROM integration_rate_windows WHERE subject='preauth-global'").Scan(&before); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 100; i++ {
		r := httptest.NewRequest("GET", "https://bridge.example/api/integrations/v1/targets", nil)
		r.RemoteAddr = fmt.Sprintf("198.51.100.%d:1234", i+1)
		if _, e = s.Authenticate(r, nil, "targets:read"); e != ErrIntegrationRateLimited {
			t.Fatal(e)
		}
	}
	if e = st.pool.QueryRow(ctx, "SELECT xmin::text FROM integration_rate_windows WHERE subject='preauth-global'").Scan(&after); e != nil {
		t.Fatal(e)
	}
	if before != after {
		t.Fatal("saturated anonymous requests still rewrite the persistent counter")
	}
	var subjects, audits int
	if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_rate_windows").Scan(&subjects); e != nil {
		t.Fatal(e)
	}
	if e = st.pool.QueryRow(ctx, "SELECT count(*) FROM integration_audit").Scan(&audits); e != nil {
		t.Fatal(e)
	}
	if subjects != 1 || audits != 0 {
		t.Fatalf("saturated traffic expanded storage: rows=%d audits=%d", subjects, audits)
	}
}
