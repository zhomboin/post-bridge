package bridge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNoteDetailHTTPRequiresOwnerAndCSRF(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: s, AdminUsername: "admin", AdminPassword: "synthetic-password-long", WorkerToken: strings.Repeat("w", 32), Origin: "http://localhost", PlatformAccounts: []PlatformAccountConfig{syntheticXHS()}})
	if err != nil {
		t.Fatal(err)
	}
	c := claimNotes(t, s, "http-note")
	n := publishedNoteSnapshot()
	if err = s.Complete(ctx, c.Job.ID, notesResult(c, n)); err != nil {
		t.Fatal(err)
	}
	_, err = s.pool.Exec(ctx, "INSERT INTO users(id,username,password_hash) SELECT 'usr_other','other',password_hash FROM users WHERE username='admin'")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ username, token string }{{"admin", strings.Repeat("a", 64)}, {"other", strings.Repeat("b", 64)}} {
		_, err = s.pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,$2,'csrf',$3)", hashToken(entry.token), entry.username, time.Now().Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, path, token string, csrf bool) int {
		r := httptest.NewRequest(method, path, strings.NewReader(`{"request_id":"read-http"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", "http://localhost")
		r.AddCookie(&http.Cookie{Name: "post_bridge_session", Value: token})
		if csrf {
			r.Header.Set("X-CSRF-Token", "csrf")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	path := "/api/accounts/xhs-main/notes/" + n.Items[0].ID
	if code := request("GET", path, strings.Repeat("b", 64), false); code != 404 {
		t.Fatal("cross user note read", code)
	}
	if code := request("POST", path+"/read", strings.Repeat("b", 64), true); code != 404 {
		t.Fatal("cross user read task", code)
	}
	if code := request("POST", path+"/read", strings.Repeat("a", 64), false); code != 403 {
		t.Fatal("missing csrf", code)
	}
	if code := request("GET", path, strings.Repeat("a", 64), false); code != 200 {
		t.Fatal("owner detail", code)
	}
	if code := request("POST", path+"/read", strings.Repeat("a", 64), true); code != 202 {
		t.Fatal("owner read task", code)
	}
}
