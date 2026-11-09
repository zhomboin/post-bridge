package bridge

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMultiuserSourceOwnershipAndConnectionReuse(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	httpHandler, err := NewHandler(ctx, Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "https://bridge.example.test", IntegrationMasterKey: strings.Repeat("ab", 32), IntegrationEnvironment: "test", IntegrationServiceID: "bridge"})
	if err != nil {
		t.Fatal(err)
	}
	h := httpHandler.(*handler)
	var a, b string
	if err = store.pool.QueryRow(ctx, "SELECT id FROM users WHERE username='admin'").Scan(&a); err != nil {
		t.Fatal(err)
	}
	b = "usr_second"
	if _, err = store.pool.Exec(ctx, "INSERT INTO users(id,username,password_hash) VALUES($1,'second','unused-fixture-hash')", b); err != nil {
		t.Fatal(err)
	}
	if _, err = store.pool.Exec(ctx, "INSERT INTO account(id,platform,username,display_name,owner_user_id) VALUES('second-account','csdn','second','第二个用户',$1)", b); err != nil {
		t.Fatal(err)
	}
	aCtx := scoped(ctx, tenantScope{UserID: a, AccountID: "csdn-main", CallerID: "user:" + a})
	bCtx := scoped(ctx, tenantScope{UserID: b, AccountID: "second-account", CallerID: "user:" + b})
	input := IntegrationInvitationInput{SourceID: "same-source", Environment: "test", Accounts: []string{"second-account"}, Scopes: []string{"targets:read"}, Operations: []string{"save_draft"}, ExpiresAt: store.now().Add(time.Hour), ClientExpiresAt: store.now().Add(24 * time.Hour), RateLimitPerMinute: 60}
	if _, err = h.integrations.Invite(aCtx, input, "admin"); err != ErrIntegrationPermission {
		t.Fatal("cross-user source grant accepted", err)
	}
	invitation, err := h.integrations.Invite(bCtx, input, "second")
	if err != nil {
		t.Fatal(err)
	}
	registration, err := h.integrations.Register(ctx, invitation.Token, IntegrationRegistrationInput{Name: "第二个用户来源", SourceID: input.SourceID, Environment: input.Environment, Accounts: input.Accounts, Scopes: input.Scopes, Operations: input.Operations})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := h.integrations.Approve(bCtx, registration.ID, IntegrationGrantInput{SourceID: input.SourceID, Accounts: input.Accounts, Scopes: input.Scopes, Operations: input.Operations, ExpiresAt: input.ClientExpiresAt, RateLimitPerMinute: 60}, "second")
	if err != nil {
		t.Fatal(err)
	}
	client, err := h.integrations.Client(bCtx, issued.ClientID)
	if err != nil || client.OwnerUserID != b {
		t.Fatal("public registration lost invitation owner", err)
	}
	if _, err = h.integrations.Client(aCtx, issued.ClientID); err != ErrNotFound {
		t.Fatal("source application leaked", err)
	}
	for i, actor := range []context.Context{aCtx, bCtx} {
		event := IntegrationSourceEvent{SourceID: "same-source", ArticleID: "same-article", StateSeq: int64(i + 1), SourceVersion: 1, Type: "published", Status: "published", AuthorizationValid: true}
		raw, _ := json.Marshal(event)
		if _, err = store.pool.Exec(actor, "INSERT INTO integration_source_states(source_id,article_id,state_seq,record) VALUES($1,$2,$3,$4)", event.SourceID, event.ArticleID, event.StateSeq, raw); err != nil {
			t.Fatal(err)
		}
		tx, e := store.pool.Begin(actor)
		if e != nil {
			t.Fatal(e)
		}
		read, e := integrationLatestEvent(actor, tx, event.SourceID, event.ArticleID)
		_ = tx.Rollback(actor)
		if e != nil || read.StateSeq != event.StateSeq {
			t.Fatal("source states crossed users", e, read.StateSeq)
		}
	}
	var group sync.WaitGroup
	for i := 0; i < 40; i++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			actor, other := aCtx, b
			if index%2 == 1 {
				actor, other = bCtx, a
			}
			var count int
			if e := store.pool.QueryRow(actor, "SELECT count(*) FROM account WHERE owner_user_id=$1", other).Scan(&count); e != nil || count != 0 {
				t.Errorf("connection pool scope leaked: %d %v", count, e)
			}
			if e := store.pool.QueryRow(actor, "SELECT count(*) FROM users WHERE id=$1", other).Scan(&count); e != nil || count != 0 {
				t.Errorf("user credential rows leaked: %d %v", count, e)
			}
		}(i)
	}
	group.Wait()
	if _, err = store.pool.Exec(bCtx, "INSERT INTO account(id,platform,username,display_name,owner_user_id) VALUES('second-extra','csdn','second_extra','另一个账号',$1)", b); err != nil {
		t.Fatal(err)
	}
	client.Accounts = append(client.Accounts, "second-extra")
	client.Status = "active"
	tx, err := store.pool.Begin(bCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bCtx)
	if err = integrationSaveClient(bCtx, tx, client); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(bCtx, "UPDATE integration_keys SET status='active' WHERE client_id=$1", client.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(bCtx, "UPDATE account SET enabled=false WHERE id='second-account'"); err != nil {
		t.Fatal(err)
	}
	target := []IntegrationTarget{{Platform: "csdn", AccountID: "second-extra", Operation: "save_draft"}}
	if _, err = integrationClientAllowedTx(bCtx, tx, client.ID, "targets:read", target, store.now()); err != nil {
		t.Fatal("unbinding another target disabled remaining grant", err)
	}
	target[0].AccountID = "second-account"
	if _, err = integrationClientAllowedTx(bCtx, tx, client.ID, "targets:read", target, store.now()); err != ErrIntegrationPermission {
		t.Fatal("unbound target remained usable", err)
	}

}

func TestMultiuserBrowserBudgetDoesNotBlockOtherUsers(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	a := tenantLogin(t, h, "admin", "administrator-secret")
	response := tenantRequest(h, "POST", "/api/users", `{"username":"second","password":"second-user-secret"}`, a)
	if response.Code != 201 {
		t.Fatal(response.Code)
	}
	b := tenantLogin(t, h, "second", "second-user-secret")
	a2 := tenantAccount(t, h, a, "admin_second")
	a3 := tenantAccount(t, h, a, "admin_third")
	b1 := tenantAccount(t, h, b, "second_first")
	for i, id := range []string{"csdn-main", a2.ID, a3.ID} {
		actor := scoped(ctx, tenantScope{UserID: a.user.ID, AccountID: id, CallerID: "user:" + a.user.ID})
		if _, _, err = store.Create(actor, CreateInput{AccountID: id, RequestID: "check-" + id, Kind: "check_account", Platform: "csdn"}); err != nil {
			t.Fatal(err)
		}
		claim, e := store.ClaimForAccount(actor, "worker-"+id, id)
		if e != nil || (i < 2) != (claim != nil) {
			t.Fatalf("per-user budget %d: %v %+v", i, e, claim)
		}
	}
	actor := scoped(ctx, tenantScope{UserID: b.user.ID, AccountID: b1.ID, CallerID: "user:" + b.user.ID})
	if _, _, err = store.Create(actor, CreateInput{AccountID: b1.ID, RequestID: "check", Kind: "check_account", Platform: "csdn"}); err != nil {
		t.Fatal(err)
	}
	if claim, e := store.ClaimForAccount(actor, "second-worker", b1.ID); e != nil || claim == nil {
		t.Fatal("one user exhausted another user's budget", e)
	}
}

func TestMultiuserSamePlatformCacheAndWorkerIsolation(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	user := tenantLogin(t, h, "admin", "administrator-secret")
	one := tenantAccount(t, h, user, "same_platform_one")
	two := tenantAccount(t, h, user, "same_platform_two")
	for _, a := range []Account{one, two} {
		raw, _ := json.Marshal(map[string]string{"id": "123", "title": a.Username, "status": "draft"})
		if _, err = store.pool.Exec(ctx, "INSERT INTO account_articles(account_id,username,id,record) VALUES($1,$2,'123',$3)", a.ID, a.Username, raw); err != nil {
			t.Fatal(err)
		}
	}
	for _, a := range []Account{one, two} {
		response := tenantRequest(h, "GET", "/api/account/articles?account_id="+a.ID, "", user)
		if response.Code != 200 || !strings.Contains(response.Body.String(), a.Username) {
			t.Fatal("same-platform cache scope", response.Code, response.Body.String())
		}
		other := one.Username
		if a.ID == one.ID {
			other = two.Username
		}
		if strings.Contains(response.Body.String(), other) {
			t.Fatal("cache crossed accounts")
		}
	}
	job := tenantJob(t, h, user, two.ID, "scope-worker")
	r := httptest.NewRequest("POST", "/internal/worker/jobs/"+job.ID+"/progress", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+h.(*handler).connectionToken(one.ID, 1))
	r.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 403 {
		t.Fatal("worker crossed same-owner accounts", response.Code, response.Body.String())
	}
}

func TestMultiuserCannotUnbindUnresolvedPlatformResult(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	user := tenantLogin(t, h, "admin", "administrator-secret")
	account := tenantAccount(t, h, user, "unresolved_account")
	job := tenantJob(t, h, user, account.ID, "unresolved-request")
	if _, err = store.pool.Exec(ctx, `UPDATE jobs SET record=record||'{"external_started":true,"status":"reconciling","outcome":"unknown","run_mode":"reconcile"}'::jsonb WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	response := tenantRequest(h, "DELETE", "/api/accounts/"+account.ID, "", user)
	if response.Code != 409 || !strings.Contains(response.Body.String(), "account_unresolved") {
		t.Fatal("unresolved result orphaned", response.Code, response.Body.String())
	}
	var enabled bool
	var version int64
	if err = store.pool.QueryRow(ctx, "SELECT enabled,connection_version FROM account WHERE id=$1", account.ID).Scan(&enabled, &version); err != nil || !enabled || version != 1 {
		t.Fatal("failed unbind revoked active connection", err)
	}
}

func TestMultiuserRemovingImportedConfigDoesNotRevokeCredentials(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()
	cfg := Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test", PlatformAccounts: []PlatformAccountConfig{{ID: "imported-second", Platform: "csdn", Username: "configured_second", DisplayName: "导入账号", WorkerToken: strings.Repeat("x", 32)}}}
	if _, err := NewHandler(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	cfg.PlatformAccounts = nil
	h, err := NewHandler(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/internal/worker/accounts", nil)
	request.Header.Set("Authorization", "Bearer "+cfg.WorkerToken)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	var out struct {
		Items []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
			Revoked bool   `json:"credentials_revoked"`
		}
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &out) != nil {
		t.Fatal("scheduler metadata", response.Code)
	}
	found := false
	for _, item := range out.Items {
		if item.ID == "imported-second" {
			found = true
			if item.Enabled || item.Revoked {
				t.Fatal("removing config requested destructive credential cleanup")
			}
		}
	}
	if !found {
		t.Fatal("retained imported account lost")
	}
}
