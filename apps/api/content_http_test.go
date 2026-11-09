package bridge

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestContentHTTPAuthenticationOwnershipAndAliases(t *testing.T) {
	s := syntheticContentStore(t)
	ctx := context.Background()
	h, err := NewHandler(ctx, Config{Store: s, AdminUsername: "admin", AdminPassword: "synthetic-password", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	admin := tenantLogin(t, h, "admin", "synthetic-password")
	completeContent(t, s, "http-seed", syntheticContentSnapshot())
	base := "/api/accounts/synthetic-account/contents"
	if w := tenantRequest(h, "GET", base, "", tenantClient{}); w.Code != 401 {
		t.Fatal("anonymous", w.Code)
	}
	if w := tenantRequest(h, "POST", base+"/sync", `{"request_id":"csrf"}`, tenantClient{cookie: admin.cookie}); w.Code != 403 {
		t.Fatal("csrf", w.Code)
	}
	if w := tenantRequest(h, "GET", base+"?page_size=101", "", admin); w.Code != 400 {
		t.Fatal("pagination", w.Code)
	}
	w := tenantRequest(h, "GET", base+"?q="+url.QueryEscape("合成文档一"), "", admin)
	var page ContentPage
	if err = json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 || page.Total != 1 {
		t.Fatal("list", w.Code, w.Body.String(), err)
	}
	encoded := base + "/" + url.PathEscape("post:alpha/one")
	if w = tenantRequest(h, "GET", encoded, "", admin); w.Code != 200 {
		t.Fatal("opaque path", w.Code, w.Body.String())
	}
	if w = tenantRequest(h, "POST", encoded+"/read", `{"request_id":"read-http"}`, admin); w.Code != 202 {
		t.Fatal("read", w.Code, w.Body.String())
	}
	if w = tenantRequest(h, "POST", base+"/post:beta/read", `{"request_id":"unknown-read"}`, admin); w.Code != 409 {
		t.Fatal("unknown content", w.Code)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("synthetic-other-password"), bcrypt.MinCost)
	if _, err = s.pool.Exec(ctx, "INSERT INTO users(id,username,password_hash) VALUES('content_other','content_other',$1)", string(hash)); err != nil {
		t.Fatal(err)
	}
	other := tenantLogin(t, h, "content_other", "synthetic-other-password")
	for _, path := range []string{base, encoded, base + "/sync"} {
		method := "GET"
		body := ""
		if strings.HasSuffix(path, "/sync") {
			method = "POST"
			body = `{"request_id":"cross-owner"}`
		}
		if w = tenantRequest(h, method, path, body, other); w.Code != 404 {
			t.Fatal("cross-owner", w.Code, w.Body.String())
		}
	}
	ownerContext := scoped(ctx, tenantScope{UserID: other.user.ID, AccountID: "synthetic-account", CallerID: "user:" + other.user.ID})
	var count int
	if err = s.pool.QueryRow(ownerContext, "SELECT count(*) FROM contents WHERE account_id='synthetic-account'").Scan(&count); err != nil || count != 0 {
		t.Fatal("row isolation", count, err)
	}
	// 新旧入口对同一账号、操作与请求标识使用相同的幂等记录。
	w = tenantRequest(h, "POST", "/api/account/articles/sync", `{"request_id":"shared-route"}`, admin)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var legacy Job
	_ = json.Unmarshal(w.Body.Bytes(), &legacy)
	w = tenantRequest(h, "POST", "/api/accounts/csdn-main/contents/sync", `{"request_id":"shared-route"}`, admin)
	var unified Job
	_ = json.Unmarshal(w.Body.Bytes(), &unified)
	if w.Code != 200 || unified.ID != legacy.ID {
		t.Fatal("route idempotency", w.Code, w.Body.String())
	}
	if w = tenantRequest(h, "GET", "/api/processes?platform=synthetic&kind=sync_contents", "", admin); w.Code != 200 {
		t.Fatal("registered platform filter", w.Code, w.Body.String())
	}
	if _, err = s.pool.Exec(ctx, "UPDATE account SET enabled=false WHERE id='synthetic-account'"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{base, encoded} {
		if w = tenantRequest(h, "GET", path, "", admin); w.Code != 404 {
			t.Fatal("disabled account content visible", w.Code)
		}
	}
}
