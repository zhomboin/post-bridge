package bridge

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStandaloneRegistryNeedsNoReverseService(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, err := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if err != nil {
		t.Fatal(err)
	}
	now := st.now()
	invite, err := s.Invite(ctx, IntegrationInvitationInput{SourceID: "caller", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, ExpiresAt: now.Add(time.Hour), ClientExpiresAt: now.Add(24 * time.Hour), RateLimitPerMinute: 20}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	reg, err := s.Register(ctx, invite.Token, IntegrationRegistrationInput{Name: "调用方", SourceID: "caller", Environment: "test", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}})
	if err != nil {
		t.Fatalf("registration without reverse endpoint: %v", err)
	}
	issued, err := s.Approve(ctx, reg.ID, IntegrationGrantInput{Scopes: reg.Scopes, Accounts: reg.Accounts, Operations: reg.Operations, ExpiresAt: now.Add(time.Hour), RateLimitPerMinute: 20}, "admin")
	if err != nil || issued.Secret == "" {
		t.Fatalf("approval without reverse credentials: %v", err)
	}
}
func TestStandaloneRegistryRejectsRemovedReverseFields(t *testing.T) {
	for _, field := range []string{"source_url", "source_client_id", "source_key_id", "source_service_id", "source_environment", "source_secret"} {
		for _, kind := range []string{"registration", "grant"} {
			t.Run(kind+"/"+field, func(t *testing.T) {
				var out any = &IntegrationGrantInput{}
				if kind == "registration" {
					out = &IntegrationRegistrationInput{}
				}
				w := httptest.NewRecorder()
				r := httptest.NewRequest("POST", "https://bridge.example", strings.NewReader(`{"`+field+`":"removed"}`))
				r.Header.Set("Content-Type", "application/json")
				if integrationDecode(w, r, out) || w.Code != 400 {
					t.Fatalf("removed field accepted: %d", w.Code)
				}
			})
		}
	}
}
func TestStandaloneMigrationRemovesReverseDataAndPreservesKeysAndJobs(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	s, err := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
	if err != nil {
		t.Fatal(err)
	}
	c := IntegrationClient{ID: "migration-client", Name: "迁移调用方", SourceID: "caller", Environment: "test", ServiceID: "bridge-test", Status: "active", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, GrantVersion: 4, ExpiresAt: st.now().Add(time.Hour), RateLimitPerMinute: 20}
	if err = seedIntegrationClient(ctx, s, c); err != nil {
		t.Fatal(err)
	}
	job := createTest(t, st, "migration-job")
	var keyID string
	if err = st.pool.QueryRow(ctx, "SELECT id FROM integration_keys WHERE client_id=$1", c.ID).Scan(&keyID); err != nil {
		t.Fatal(err)
	}
	secret, err := s.Secret(ctx, keyID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.pool.Exec(ctx, `ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS encrypted_source_secret bytea; UPDATE integration_clients SET metadata=metadata || '{"source_url":"https://removed.example","source_client_id":"removed","source_key_id":"removed","source_service_id":"removed","source_environment":"removed","source_secret":"removed"}'::jsonb,encrypted_source_secret='removed'::bytea; UPDATE integration_registrations SET application=application || '{"name":"迁移调用方","source_id":"caller","source_url":"https://removed.example","source_client_id":"removed","source_key_id":"removed","source_service_id":"removed","source_environment":"removed","source_secret":"removed"}'::jsonb;`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = st.pool.Exec(ctx, integrationSchemaSQL); err != nil {
			t.Fatal(err)
		}
	}
	var column bool
	if err = st.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='integration_clients' AND column_name='encrypted_source_secret')").Scan(&column); err != nil || column {
		t.Fatalf("reverse secret storage retained: %v %v", column, err)
	}
	for _, table := range []string{"integration_clients", "integration_registrations"} {
		field := "metadata"
		if table == "integration_registrations" {
			field = "application"
		}
		var raw []byte
		if err = st.pool.QueryRow(ctx, "SELECT "+field+" FROM "+table+" LIMIT 1").Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		json.Unmarshal(raw, &value)
		for _, field := range []string{"source_url", "source_client_id", "source_key_id", "source_service_id", "source_environment", "source_secret"} {
			if _, ok := value[field]; ok {
				t.Fatalf("%s retained %s", table, field)
			}
		}
	}
	migrated, err := s.Client(ctx, c.ID)
	if err != nil || migrated.GrantVersion != 4 || migrated.SourceID != "caller" {
		t.Fatalf("client changed: %+v %v", migrated, err)
	}
	restored, err := s.Secret(ctx, keyID)
	if err != nil || string(secret) != string(restored) {
		t.Fatal("normal key changed", err)
	}
	restoredJob, err := st.Get(ctx, job.ID)
	if err != nil || restoredJob.ID != job.ID || restoredJob.Title != job.Title || restoredJob.Markdown != job.Markdown || restoredJob.Status != job.Status {
		t.Fatalf("job changed: %+v %v", restoredJob, err)
	}
}

func TestStandalonePublicOriginRetainsHTTPSBoundary(t *testing.T) {
	for _, origin := range []string{"http://bridge.example", "https://127.0.0.1", "https://localhost", "https://bridge.internal", "https://bridge.example/path", "https://bridge.example?key=value", "https://user@bridge.example", "https://bridge.example:8443"} {
		if _, err := NewIntegrationService(&Store{}, strings.Repeat("ab", 32), "test", "bridge-test", origin); err != ErrInvalid {
			t.Fatalf("unsafe public origin accepted %q: %v", origin, err)
		}
	}
	if _, err := NewIntegrationService(&Store{}, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example"); err != nil {
		t.Fatal(err)
	}
}

func TestStandaloneGrantChangesAdvanceVersion(t *testing.T) {
	for _, kind := range []string{"source_id", "scope", "account", "operation", "expiry"} {
		t.Run(kind, func(t *testing.T) {
			st := testStore(t)
			ctx := context.Background()
			s, err := NewIntegrationService(st, strings.Repeat("ab", 32), "test", "bridge-test", "https://bridge.example")
			if err != nil {
				t.Fatal(err)
			}
			c := IntegrationClient{ID: "grant-client", Name: "调用方", SourceID: "caller", Environment: "test", ServiceID: "bridge-test", Status: "active", Scopes: []string{"targets:read"}, Accounts: []string{"csdn-main"}, Operations: []string{"save_draft"}, GrantVersion: 4, ExpiresAt: st.now().Add(time.Hour), RateLimitPerMinute: 20}
			if err = seedIntegrationClient(ctx, s, c); err != nil {
				t.Fatal(err)
			}
			in := IntegrationGrantInput{Scopes: c.Scopes, Accounts: c.Accounts, Operations: c.Operations, ExpiresAt: c.ExpiresAt, RateLimitPerMinute: c.RateLimitPerMinute}
			same, err := s.Update(ctx, c.ID, in, "admin")
			if err != nil || same.GrantVersion != c.GrantVersion {
				t.Fatalf("unchanged grant invalidated: %+v %v", same, err)
			}
			switch kind {
			case "source_id":
				in.SourceID = "other"
			case "scope":
				in.Scopes = []string{"preparations:read"}
			case "account":
				in.Accounts = []string{}
			case "operation":
				in.Operations = []string{}
			case "expiry":
				in.ExpiresAt = c.ExpiresAt.Add(-time.Minute)
			}
			updated, err := s.Update(ctx, c.ID, in, "admin")
			if err != nil || updated.GrantVersion != c.GrantVersion+1 {
				t.Fatalf("changed grant retained version: %+v %v", updated, err)
			}
		})
	}
}
