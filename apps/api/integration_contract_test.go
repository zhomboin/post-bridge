package bridge

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestIntegrationSharedContractVectors(t *testing.T) {
	var fixture struct {
		Synthetic bool `json:"synthetic"`
		Signature struct {
			Method      string `json:"method"`
			URL         string `json:"url"`
			Body        string `json:"body"`
			ClientID    string `json:"client_id"`
			KeyID       string `json:"key_id"`
			Environment string `json:"environment"`
			ServiceID   string `json:"service_id"`
			Secret      string `json:"fixture_secret_base64"`
			Timestamp   int64  `json:"timestamp"`
			Nonce       string `json:"nonce"`
			Digest      string `json:"content_digest"`
			Input       string `json:"signature_input"`
			Signature   string `json:"signature"`
		} `json:"signature"`
		Content struct {
			Snapshot    IntegrationSnapshot `json:"snapshot"`
			Fingerprint string              `json:"fingerprint"`
		} `json:"content"`
	}
	raw, err := os.ReadFile("../../tests/fixtures/integration-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil || !fixture.Synthetic {
		t.Fatal("invalid synthetic vector", err)
	}
	sig := fixture.Signature
	secret, err := base64.StdEncoding.DecodeString(sig.Secret)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(sig.Method, sig.URL, nil)
	err = SignIntegrationRequest(req, []byte(sig.Body), IntegrationSigningIdentity{ClientID: sig.ClientID, KeyID: sig.KeyID, Environment: sig.Environment, ServiceID: sig.ServiceID}, secret, time.Unix(sig.Timestamp, 0), sig.Nonce)
	if err != nil || req.Header.Get("Signature") != sig.Signature || req.Header.Get("Signature-Input") != sig.Input || req.Header.Get("Content-Digest") != sig.Digest {
		t.Fatal("signature contract differs from independent fixture", err)
	}
	fp, err := IntegrationContentFingerprint(fixture.Content.Snapshot)
	if err != nil || fp != fixture.Content.Fingerprint {
		t.Fatal("content fingerprint contract differs", fp, err)
	}
}
func TestIntegrationOpenAPIReferencesAndProtectedOperations(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/cms.openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if document["openapi"] != "3.1.0" {
		t.Fatal("unexpected OpenAPI version")
	}
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			if ref, ok := v["$ref"].(string); ok {
				if !strings.HasPrefix(ref, "#/") {
					t.Fatalf("external contract reference %s", ref)
				}
				var target any = document
				for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
					m, ok := target.(map[string]any)
					if !ok {
						t.Fatalf("bad reference %s", ref)
					}
					target, ok = m[part]
					if !ok {
						t.Fatalf("missing reference %s", ref)
					}
				}
			}
			for _, child := range v {
				visit(child)
			}
		case []any:
			for _, child := range v {
				visit(child)
			}
		}
	}
	visit(document)
	paths, ok := document["paths"].(map[string]any)
	if !ok {
		t.Fatal("missing paths")
	}
	for _, path := range []string{"/api/integrations/v1/targets", "/api/integrations/v1/preparations", "/api/integrations/v1/distributions", "/api/integrations/v1/source-events", "/api/integrations/v1/registrations", "/api/integration-preparations/{id}/confirm"} {
		methods, ok := paths[path].(map[string]any)
		if !ok {
			t.Fatalf("missing actual API %s", path)
		}
		for method, value := range methods {
			if method != "get" && method != "post" && method != "put" {
				continue
			}
			operation := value.(map[string]any)
			if security, ok := operation["security"].([]any); !ok || len(security) == 0 {
				t.Fatalf("unprotected contract %s %s", method, path)
			}
		}
	}
}

func TestIntegrationIndependentProviderContract(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/cms.openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if _, exists := doc["x-caller-contract"]; exists {
		t.Fatal("provider contract must not require caller-hosted APIs")
	}
	schemas := doc["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"RegistrationInput", "GrantInput", "Client"} {
		schema := schemas[name].(map[string]any)
		properties := schema["properties"].(map[string]any)
		for _, field := range []string{"source_url", "source_client_id", "source_key_id", "source_service_id", "source_environment", "source_secret"} {
			if _, exists := properties[field]; exists {
				t.Fatalf("%s exposes reverse field %s", name, field)
			}
		}
	}
	paths := doc["paths"].(map[string]any)
	cancel, exists := paths["/api/integrations/v1/distributions/{id}/cancel"]
	if !exists {
		t.Fatal("missing standard external cancellation operation")
	}
	operation, exists := cancel.(map[string]any)["post"].(map[string]any)
	if !exists || operation["x-required-scope"] != "distributions:write" {
		t.Fatal("cancellation must require write permission")
	}
	for path, item := range paths {
		if !strings.HasPrefix(path, "/api/integrations/v1/") || path == "/api/integrations/v1/registrations" {
			continue
		}
		for method, value := range item.(map[string]any) {
			if method != "get" && method != "post" && method != "put" {
				continue
			}
			security := value.(map[string]any)["security"].([]any)
			if len(security) != 1 {
				t.Fatalf("signature requirements must be combined: %s %s", method, path)
			}
			required := security[0].(map[string]any)
			for _, header := range []string{"SignatureInput", "Signature", "ContentDigest", "IntegrationClient", "IntegrationEnvironment", "IntegrationService"} {
				if _, ok := required[header]; !ok {
					t.Fatalf("%s %s missing %s", method, path, header)
				}
			}
		}
	}
}
