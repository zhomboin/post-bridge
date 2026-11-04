package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var ErrSourceUnavailable = errors.New("source_check_unavailable")
var ErrSourceDenied = errors.New("source_check_denied")

const integrationSourceTimeout = 3 * time.Second
const integrationSourceBodyLimit = 64 << 10

type IntegrationSourceCheck struct {
	ArticleID          string
	AuthorizationID    string
	PreparationID      string
	AccountID          string
	Operation          string
	ContentFingerprint string
	MinStateSeq        int64
}

type IntegrationSourceState struct {
	ArticleID          string   `json:"article_id"`
	SourceVersion      int64    `json:"source_version"`
	StateSeq           int64    `json:"state_seq"`
	Status             string   `json:"status"`
	ContentFingerprint string   `json:"content_fingerprint"`
	AuthorizationValid bool     `json:"authorization_valid"`
	Allowed            bool     `json:"allowed"`
	Accounts           []string `json:"accounts"`
	Operations         []string `json:"operations"`
}

func (s *IntegrationService) CheckSource(ctx context.Context, clientID string, check IntegrationSourceCheck) (IntegrationSourceState, error) {
	ctx, cancel := context.WithTimeout(ctx, integrationSourceTimeout)
	defer cancel()
	credentials, err := s.SourceCredentials(ctx, clientID)
	if err != nil {
		return IntegrationSourceState{}, ErrSourceUnavailable
	}
	return s.checkSource(ctx, credentials, check)
}

func (s *IntegrationService) checkSource(ctx context.Context, credentials IntegrationSourceCredentials, check IntegrationSourceCheck) (IntegrationSourceState, error) {
	var empty IntegrationSourceState
	if check.Operation != "save_draft" || check.ArticleID == "" || check.ArticleID == "." || check.ArticleID == ".." || len(check.ArticleID) > 256 || check.AuthorizationID == "" || check.PreparationID == "" || check.AccountID == "" || check.ContentFingerprint == "" || check.MinStateSeq < 1 {
		return empty, ErrSourceDenied
	}
	if validateIntegrationURL(credentials.URL) != nil || strings.ContainsAny(credentials.URL, "?#") {
		return empty, ErrSourceUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, integrationSourceTimeout)
	defer cancel()
	target := strings.TrimSuffix(credentials.URL, "/") + "/api/v1/integrations/postbridge/articles/" + url.PathEscape(check.ArticleID) + "/distribution-state"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return empty, ErrSourceUnavailable
	}
	query := url.Values{"authorization_id": {check.AuthorizationID}, "preparation_id": {check.PreparationID}, "account_id": {check.AccountID}, "operation": {check.Operation}}
	req.URL.RawQuery = query.Encode()
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	nonce := make([]byte, 24)
	if _, err = rand.Read(nonce); err != nil {
		return empty, ErrSourceUnavailable
	}
	if err = SignIntegrationRequest(req, nil, credentials.Identity, credentials.Secret, s.store.now(), hex.EncodeToString(nonce)); err != nil {
		return empty, ErrSourceUnavailable
	}
	transport := http.RoundTripper(newIntegrationSourceTransport())
	if s.SourceHTTPClient != nil && s.SourceHTTPClient.Transport != nil {
		transport = s.SourceHTTPClient.Transport
	}
	client := &http.Client{Transport: transport, Timeout: integrationSourceTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return empty, ErrSourceUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return empty, ErrSourceUnavailable
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return empty, ErrSourceUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, integrationSourceBodyLimit+1))
	if err != nil || len(body) > integrationSourceBodyLimit {
		return empty, ErrSourceUnavailable
	}
	state, err := decodeIntegrationSourceState(body)
	if err != nil {
		return empty, ErrSourceUnavailable
	}
	if state.ArticleID != check.ArticleID || state.StateSeq < check.MinStateSeq || state.Status != "published" || state.ContentFingerprint != check.ContentFingerprint || !state.AuthorizationValid || !state.Allowed || !integrationHas(state.Accounts, check.AccountID) || !integrationHas(state.Operations, check.Operation) {
		return empty, ErrSourceDenied
	}
	return state, nil
}

func decodeIntegrationSourceState(body []byte) (IntegrationSourceState, error) {
	var state IntegrationSourceState
	decoder := json.NewDecoder(bytes.NewReader(body))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return state, ErrSourceUnavailable
	}
	required := map[string]bool{"article_id": false, "source_version": false, "state_seq": false, "status": false, "content_fingerprint": false, "authorization_valid": false, "allowed": false, "accounts": false, "operations": false}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return state, ErrSourceUnavailable
		}
		key, ok := token.(string)
		if !ok {
			return state, ErrSourceUnavailable
		}
		seen, known := required[key]
		if !known || seen {
			return state, ErrSourceUnavailable
		}
		required[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return state, ErrSourceUnavailable
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return state, ErrSourceUnavailable
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return state, ErrSourceUnavailable
	}
	for _, seen := range required {
		if !seen {
			return state, ErrSourceUnavailable
		}
	}
	if json.Unmarshal(body, &state) != nil || !integrationHas([]string{"draft", "published", "private", "deleted"}, state.Status) || state.ArticleID == "" || state.SourceVersion < 1 || state.StateSeq < 1 || state.Status == "" || state.ContentFingerprint == "" || state.Accounts == nil || state.Operations == nil {
		return IntegrationSourceState{}, ErrSourceUnavailable
	}
	return state, nil
}

func newIntegrationSourceTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: integrationSourceTimeout, KeepAlive: -1}
	return &http.Transport{
		Proxy: nil,
		DialContext: integrationSourceDialer(func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}, dialer.DialContext),
		DisableKeepAlives:      true,
		DisableCompression:     true,
		TLSHandshakeTimeout:    integrationSourceTimeout,
		ResponseHeaderTimeout:  integrationSourceTimeout,
		MaxResponseHeaderBytes: 16 << 10,
	}
}

func integrationSourceDialer(lookup func(context.Context, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" {
			return nil, ErrSourceUnavailable
		}
		addresses, err := lookup(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, ErrSourceUnavailable
		}
		for _, address := range addresses {
			if !integrationSourcePublicIP(address) {
				return nil, ErrSourceUnavailable
			}
		}
		for _, address := range addresses {
			conn, err := dial(ctx, network, net.JoinHostPort(address.String(), port))
			if err == nil {
				return conn, nil
			}
			if ctx.Err() != nil {
				break
			}
		}
		return nil, ErrSourceUnavailable
	}
}

var integrationSourceBlockedRanges = []netip.Prefix{
	netip.MustParsePrefix("168.63.129.16/32"), netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}

func integrationSourcePublicIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || address.Zone() != "" || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, blocked := range integrationSourceBlockedRanges {
		if blocked.Contains(address) {
			return false
		}
	}
	return true
}
