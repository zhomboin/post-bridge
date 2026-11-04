package bridge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var ErrIntegrationAuthentication = errors.New("integration authentication failed")
var ErrIntegrationPermission = errors.New("integration permission denied")
var ErrIntegrationRateLimited = errors.New("integration rate limited")

const IntegrationBodyLimit = 1 << 20
const integrationComponents = `("@method" "@target-uri" "content-digest" "x-integration-client" "x-integration-environment" "x-integration-service")`

var integrationInput = regexp.MustCompile(`^sig1=\("@method" "@target-uri" "content-digest" "x-integration-client" "x-integration-environment" "x-integration-service"\);created=([0-9]{1,12});keyid="([a-zA-Z0-9_-]{1,128})";nonce="([a-zA-Z0-9_-]{16,128})";alg="hmac-sha256"$`)
var integrationIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

type IntegrationSigningIdentity struct {
	ClientID    string `json:"client_id"`
	KeyID       string `json:"key_id"`
	Environment string `json:"environment"`
	ServiceID   string `json:"service_id"`
}

func integrationBodyDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha-256=:" + base64.StdEncoding.EncodeToString(sum[:]) + ":"
}
func integrationBase(r *http.Request, target, input string) string {
	return `"@method": ` + r.Method + "\n" + `"@target-uri": ` + target + "\n" + `"content-digest": ` + r.Header.Get("Content-Digest") + "\n" + `"x-integration-client": ` + r.Header.Get("X-Integration-Client") + "\n" + `"x-integration-environment": ` + r.Header.Get("X-Integration-Environment") + "\n" + `"x-integration-service": ` + r.Header.Get("X-Integration-Service") + "\n" + `"@signature-params": ` + strings.TrimPrefix(input, "sig1=")
}
func SignIntegrationRequest(r *http.Request, body []byte, id IntegrationSigningIdentity, secret []byte, now time.Time, nonce string) error {
	if len(body) > IntegrationBodyLimit || len(secret) < 32 || !integrationIdentifier.MatchString(id.ClientID) || !integrationIdentifier.MatchString(id.KeyID) || !integrationIdentifier.MatchString(id.Environment) || !integrationIdentifier.MatchString(id.ServiceID) || len(nonce) < 16 || !integrationIdentifier.MatchString(nonce) || r.URL.Scheme != "https" || r.URL.User != nil || r.URL.Fragment != "" {
		return ErrInvalid
	}
	r.Header.Set("Content-Digest", integrationBodyDigest(body))
	r.Header.Set("X-Integration-Client", id.ClientID)
	r.Header.Set("X-Integration-Environment", id.Environment)
	r.Header.Set("X-Integration-Service", id.ServiceID)
	input := fmt.Sprintf(`sig1=%s;created=%d;keyid="%s";nonce="%s";alg="hmac-sha256"`, integrationComponents, now.Unix(), id.KeyID, nonce)
	r.Header.Set("Signature-Input", input)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(integrationBase(r, r.URL.String(), input)))
	r.Header.Set("Signature", "sig1=:"+base64.StdEncoding.EncodeToString(mac.Sum(nil))+":")
	return nil
}
func VerifyIntegrationRequest(r *http.Request, body []byte, origin string, secret []byte, now time.Time) error {
	if len(body) > IntegrationBodyLimit || len(secret) < 32 {
		return ErrIntegrationAuthentication
	}
	for _, name := range []string{"Content-Digest", "X-Integration-Client", "X-Integration-Environment", "X-Integration-Service", "Signature-Input", "Signature"} {
		if len(r.Header.Values(name)) != 1 {
			return ErrIntegrationAuthentication
		}
	}
	m := integrationInput.FindStringSubmatch(r.Header.Get("Signature-Input"))
	if m == nil {
		return ErrIntegrationAuthentication
	}
	created, e := strconv.ParseInt(m[1], 10, 64)
	if e != nil || created < now.Unix()-300 || created > now.Unix()+300 {
		return ErrIntegrationAuthentication
	}
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "https" || r.Host != u.Host || r.URL.User != nil || r.URL.Fragment != "" || strings.HasPrefix(r.URL.Path, "//") {
		return ErrIntegrationAuthentication
	}
	if r.URL.IsAbs() && (r.URL.Scheme != "https" || r.URL.Host != u.Host) {
		return ErrIntegrationAuthentication
	}
	if r.Header.Get("Content-Digest") != integrationBodyDigest(body) {
		return ErrIntegrationAuthentication
	}
	sig := r.Header.Get("Signature")
	if !strings.HasPrefix(sig, "sig1=:") || !strings.HasSuffix(sig, ":") {
		return ErrIntegrationAuthentication
	}
	raw, e := base64.StdEncoding.Strict().DecodeString(strings.TrimSuffix(strings.TrimPrefix(sig, "sig1=:"), ":"))
	if e != nil {
		return ErrIntegrationAuthentication
	}
	target := strings.TrimSuffix(origin, "/") + r.URL.RequestURI()
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(integrationBase(r, target, r.Header.Get("Signature-Input"))))
	if !hmac.Equal(raw, mac.Sum(nil)) {
		return ErrIntegrationAuthentication
	}
	return nil
}
func validateIntegrationURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || strings.ContainsAny(raw, "?#") || u.Path != "" && u.Path != "/" || u.Port() != "" && u.Port() != "443" {
		return ErrInvalid
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	ip := net.ParseIP(host)
	if ip != nil || !strings.Contains(host, ".") || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.ContainsAny(host, "%\\\r\n") {
		return ErrInvalid
	}
	return nil
}
