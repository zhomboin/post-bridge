package bridge

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAvatarContentSecurityPolicy(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := &handler{mux: mux}
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	expected := "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://profile-avatar.csdnimg.cn https://img.xiaohongshu.com https://*.xhscdn.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
	if got := recorder.Header().Get("Content-Security-Policy"); got != expected {
		t.Fatalf("unexpected CSP: %s", got)
	}
	for name, expected := range map[string]string{"Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"} {
		if got := recorder.Header().Get(name); got != expected {
			t.Errorf("%s = %s", name, got)
		}
	}
}
