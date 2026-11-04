package bridge

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIntegrationSignatureGoldenAndTampering(t *testing.T) {
	req := httptest.NewRequest("POST", "https://bridge.example/api/integrations/v1/preparations?z=2&a=1", nil)
	body := []byte(`{"title":"测试"}`)
	id := IntegrationSigningIdentity{ClientID: "client-test", KeyID: "key-test", Environment: "test", ServiceID: "bridge-test"}
	now := time.Unix(1700000000, 0)
	if err := SignIntegrationRequest(req, body, id, []byte(strings.Repeat("s", 32)), now, "nonce-0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("Signature") != "sig1=:PnOxIUmNh48OKODhZyf8IADxXtqYEhaDYwdmPQuCLRk=:" {
		t.Fatal(req.Header.Get("Signature"))
	}
	expected := `sig1=("@method" "@target-uri" "content-digest" "x-integration-client" "x-integration-environment" "x-integration-service");created=1700000000;keyid="key-test";nonce="nonce-0123456789abcdef";alg="hmac-sha256"`
	if req.Header.Get("Signature-Input") != expected {
		t.Fatal(req.Header.Get("Signature-Input"))
	}
	if err := VerifyIntegrationRequest(req, body, "https://bridge.example", []byte(strings.Repeat("s", 32)), now); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"body", "method", "query", "client", "environment", "service", "host", "timestamp", "duplicate", "algorithm"} {
		t.Run(change, func(t *testing.T) {
			r := req.Clone(req.Context())
			r.Header = req.Header.Clone()
			b := append([]byte(nil), body...)
			switch change {
			case "body":
				b = []byte("changed")
			case "method":
				r.Method = "GET"
			case "query":
				r.URL.RawQuery = "a=1&z=2"
			case "client":
				r.Header.Set("X-Integration-Client", "other")
			case "environment":
				r.Header.Set("X-Integration-Environment", "prod")
			case "service":
				r.Header.Set("X-Integration-Service", "other")
			case "host":
				r.Host = "evil.example"
			case "timestamp":
				r.Header.Set("Signature-Input", strings.ReplaceAll(expected, "1700000000", "1699999699"))
			case "duplicate":
				r.Header.Add("Signature", r.Header.Get("Signature"))
			case "algorithm":
				r.Header.Set("Signature-Input", strings.ReplaceAll(expected, "hmac-sha256", "none"))
			}
			if err := VerifyIntegrationRequest(r, b, "https://bridge.example", []byte(strings.Repeat("s", 32)), now); err == nil {
				t.Fatal("accepted tampered request")
			}
		})
	}
}
func TestIntegrationURLRestriction(t *testing.T) {
	for _, v := range []string{"http://cms.example", "https://user@cms.example", "https://cms.example?q=1", "https://cms.example?", "https://cms.example#", "https://cms.example/#x", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://localhost", "https://cms.local"} {
		if validateIntegrationURL(v) == nil {
			t.Errorf("accepted %s", v)
		}
	}
	if err := validateIntegrationURL("https://cms.example"); err != nil {
		t.Fatal(err)
	}
}
