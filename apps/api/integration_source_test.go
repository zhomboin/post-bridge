package bridge

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestIntegrationSourcePublicIP(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "240.0.0.1", "192.0.2.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::"} {
		if integrationSourcePublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("accepted unsafe IP %s", raw)
		}
	}
	for _, raw := range []string{"93.184.216.34", "2606:4700:4700::1111"} {
		if !integrationSourcePublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("rejected public IP %s", raw)
		}
	}
}
func TestIntegrationSourceDialPinsValidatedAddress(t *testing.T) {
	var dialed string
	lookups := 0
	dial := integrationSourceDialer(func(context.Context, string) ([]netip.Addr, error) {
		lookups++
		if lookups > 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}, func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialed = address
		return nil, errors.New("fixture")
	})
	_, _ = dial(context.Background(), "tcp", "cms.example:443")
	if lookups != 1 || dialed != "93.184.216.34:443" {
		t.Fatalf("not pinned: lookups=%d target=%s", lookups, dialed)
	}
	dialed = ""
	dial = integrationSourceDialer(func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.1")}, nil
	}, func(context.Context, string, string) (net.Conn, error) { dialed = "called"; return nil, nil })
	if _, err := dial(context.Background(), "tcp", "cms.example:443"); err == nil || dialed != "" {
		t.Fatal("mixed public/private DNS reached dialer")
	}
}

type integrationSourceRoundTripFunc func(*http.Request) (*http.Response, error)

func (f integrationSourceRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}
func sourceFixtureService(body string, status int) *IntegrationService {
	return &IntegrationService{store: &Store{now: func() time.Time { return time.Unix(1800000000, 0).UTC() }}, SourceHTTPClient: &http.Client{Transport: integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
}
func sourceFixtureCheck() IntegrationSourceCheck {
	return IntegrationSourceCheck{ArticleID: "article-1", AuthorizationID: "authorization-1", PreparationID: "preparation-1", AccountID: "csdn-main", Operation: "save_draft", ContentFingerprint: strings.Repeat("a", 64), MinStateSeq: 7}
}
func sourceFixtureCredentials() IntegrationSourceCredentials {
	return IntegrationSourceCredentials{URL: "https://cms.example", Identity: IntegrationSigningIdentity{ClientID: "postbridge", KeyID: "key-1", Environment: "test", ServiceID: "cms"}, Secret: []byte(strings.Repeat("s", 32))}
}

const sourceValidJSON = `{"article_id":"article-1","source_version":4,"state_seq":7,"status":"published","content_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","authorization_valid":true,"allowed":true,"accounts":["csdn-main"],"operations":["save_draft"]}`

func TestIntegrationSourceChecksSignedRequest(t *testing.T) {
	s := sourceFixtureService(sourceValidJSON, 200)
	calls := 0
	s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		q := r.URL.Query()
		if r.Method != "GET" || r.URL.Path != "/api/v1/integrations/postbridge/articles/article-1/distribution-state" || q.Get("authorization_id") != "authorization-1" || q.Get("preparation_id") != "preparation-1" || q.Get("account_id") != "csdn-main" || q.Get("operation") != "save_draft" {
			t.Errorf("unexpected request %s", r.URL)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Cache-Control") != "no-store" {
			t.Error("privacy/cache policy")
		}
		if err := VerifyIntegrationRequest(r, nil, "https://cms.example", sourceFixtureCredentials().Secret, s.store.now()); err != nil {
			t.Errorf("signature: %v", err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(sourceValidJSON)), Request: r}, nil
	})
	got, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck())
	if err != nil || got.StateSeq != 7 || calls != 1 {
		t.Fatalf("valid check: %+v %v calls=%d", got, err, calls)
	}
}
func TestIntegrationSourceRejectsUnsafeURLs(t *testing.T) {
	for _, raw := range []string{"http://cms.example", "https://user:secret@cms.example", "https://cms.example#fragment", "https://cms.example?url=secret", "https://cms.example/base", "https://127.0.0.1", "https://[::1]", "https://metadata.google.internal", "https://cms.example:8443", "https://cms.example/%2f"} {
		t.Run(raw, func(t *testing.T) {
			s := sourceFixtureService(sourceValidJSON, 200)
			s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unsafe network"); return nil, nil })
			c := sourceFixtureCredentials()
			c.URL = raw
			if _, err := s.checkSource(context.Background(), c, sourceFixtureCheck()); !errors.Is(err, ErrSourceUnavailable) {
				t.Fatalf("got %v", err)
			}
		})
	}
}
func TestIntegrationSourceDeniesChangedAuthorization(t *testing.T) {
	for _, body := range []string{strings.Replace(sourceValidJSON, `"state_seq":7`, `"state_seq":6`, 1), strings.Replace(sourceValidJSON, `"status":"published"`, `"status":"private"`, 1), strings.Replace(sourceValidJSON, `"article_id":"article-1"`, `"article_id":"other"`, 1), strings.Replace(sourceValidJSON, strings.Repeat("a", 64), strings.Repeat("b", 64), 1), strings.Replace(sourceValidJSON, `"authorization_valid":true`, `"authorization_valid":false`, 1), strings.Replace(sourceValidJSON, `"allowed":true`, `"allowed":false`, 1), strings.Replace(sourceValidJSON, `["csdn-main"]`, `["other"]`, 1), strings.Replace(sourceValidJSON, `["save_draft"]`, `["publish"]`, 1)} {
		s := sourceFixtureService(body, 200)
		if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck()); !errors.Is(err, ErrSourceDenied) {
			t.Errorf("expected denied: %v", err)
		}
	}
}
func TestIntegrationSourcePausesOnUnverifiableResponse(t *testing.T) {
	for _, tc := range []struct {
		name, body, ct string
		status         int
	}{{"unauthorized", "secret raw upstream", "application/json", 401}, {"redirect", sourceValidJSON, "application/json", 302}, {"html", sourceValidJSON, "text/html", 200}, {"oversized", strings.Repeat(" ", 65536) + sourceValidJSON, "application/json", 200}, {"malformed", "{", "application/json", 200}, {"missing", `{"article_id":"article-1"}`, "application/json", 200}, {"unknown", strings.TrimSuffix(sourceValidJSON, "}") + `,"secret":"private"}`, "application/json", 200}, {"trailing", sourceValidJSON + `{}`, "application/json", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			s := sourceFixtureService(tc.body, tc.status)
			calls := 0
			s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Content-Type": []string{tc.ct}, "Location": []string{"https://evil.example/private"}}, Body: io.NopCloser(strings.NewReader(tc.body)), Request: r}, nil
			})
			_, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck())
			if !errors.Is(err, ErrSourceUnavailable) || strings.Contains(err.Error(), "secret") || calls != 1 {
				t.Fatalf("error/calls %v %d", err, calls)
			}
		})
	}
}
func TestIntegrationSourceDeadlineAndSanitizedError(t *testing.T) {
	s := sourceFixtureService("", 200)
	s.SourceHTTPClient.Timeout = time.Hour
	s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 3*time.Second {
			t.Fatal("unbounded deadline")
		}
		return nil, errors.New("secret https://cms.example/private")
	})
	_, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck())
	if !errors.Is(err, ErrSourceUnavailable) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsanitized error %v", err)
	}
}

func TestIntegrationSourceRejectsDuplicateAndNullFields(t *testing.T) {
	for _, body := range []string{strings.TrimSuffix(sourceValidJSON, "}") + `,"allowed":true}`, strings.Replace(sourceValidJSON, `"authorization_valid":true`, `"authorization_valid":null`, 1), strings.Replace(sourceValidJSON, `"source_version":4`, `"source_version":0`, 1), strings.Replace(sourceValidJSON, `"accounts":["csdn-main"]`, `"accounts":null`, 1)} {
		s := sourceFixtureService(body, 200)
		if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck()); !errors.Is(err, ErrSourceUnavailable) {
			t.Fatalf("accepted invalid fields: %v", err)
		}
	}
}

func TestIntegrationSourceRejectsOperationUpgradeBeforeNetwork(t *testing.T) {
	s := sourceFixtureService(sourceValidJSON, 200)
	s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid operation reached source")
		return nil, nil
	})
	check := sourceFixtureCheck()
	check.Operation = "publish"
	if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), check); !errors.Is(err, ErrSourceDenied) {
		t.Fatalf("accepted operation upgrade: %v", err)
	}
}

func TestIntegrationSourceCancelsTimedOutRequest(t *testing.T) {
	s := sourceFixtureService(sourceValidJSON, 200)
	s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := s.checkSource(ctx, sourceFixtureCredentials(), sourceFixtureCheck()); !errors.Is(err, ErrSourceUnavailable) || time.Since(start) > time.Second {
		t.Fatalf("timeout check failed: %v", err)
	}
}

func TestIntegrationSourceBodyBoundary(t *testing.T) {
	body := sourceValidJSON + strings.Repeat(" ", integrationSourceBodyLimit-len(sourceValidJSON))
	s := sourceFixtureService(body, 200)
	if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck()); err != nil {
		t.Fatalf("rejected exact response body limit: %v", err)
	}
}

func TestIntegrationSourceEscapesBindingsAndChangesNonce(t *testing.T) {
	s := sourceFixtureService(sourceValidJSON, 200)
	check := sourceFixtureCheck()
	check.ArticleID = "article/a?b#c"
	check.AuthorizationID = "authorization&a=other"
	previous := ""
	s.SourceHTTPClient.Transport = integrationSourceRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if !strings.Contains(r.URL.EscapedPath(), "article%2Fa%3Fb%23c") || r.URL.Query().Get("authorization_id") != check.AuthorizationID || r.URL.Query().Get("a") != "" {
			t.Error("bindings were not escaped")
		}
		signature := r.Header.Get("Signature-Input")
		if signature == previous {
			t.Error("reused nonce")
		}
		previous = signature
		body := strings.Replace(sourceValidJSON, `"article_id":"article-1"`, `"article_id":"article/a?b#c"`, 1)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	for i := 0; i < 2; i++ {
		if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), check); err != nil {
			t.Fatal(err)
		}
	}
}

func TestIntegrationSourceRejectsEmptyQueryAndFragment(t *testing.T) {
	for _, raw := range []string{"https://cms.example?", "https://cms.example#"} {
		s := sourceFixtureService(sourceValidJSON, 200)
		c := sourceFixtureCredentials()
		c.URL = raw
		if _, err := s.checkSource(context.Background(), c, sourceFixtureCheck()); !errors.Is(err, ErrSourceUnavailable) {
			t.Errorf("accepted ambiguous origin %q: %v", raw, err)
		}
	}
}

func TestIntegrationSourceUnknownStatusIsUnavailable(t *testing.T) {
	s := sourceFixtureService(strings.Replace(sourceValidJSON, `"status":"published"`, `"status":"unexpected"`, 1), 200)
	if _, err := s.checkSource(context.Background(), sourceFixtureCredentials(), sourceFixtureCheck()); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("unknown status was treated as a definitive denial: %v", err)
	}
}

func TestIntegrationSourceBlocksAzurePlatformAddress(t *testing.T) {
	if integrationSourcePublicIP(netip.MustParseAddr("168.63.129.16")) {
		t.Fatal("accepted cloud platform metadata address")
	}
}

func TestIntegrationSourceTransportDoesNotUseProxyOrSkipTLS(t *testing.T) {
	transport := newIntegrationSourceTransport()
	defer transport.CloseIdleConnections()
	if transport.Proxy != nil || transport.DialContext == nil || transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("unsafe default transport")
	}
}
