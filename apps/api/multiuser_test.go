package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type tenantClient struct {
	cookie *http.Cookie
	csrf   string
	user   User
}

func tenantRequest(h http.Handler, method, path, body string, c tenantClient) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", "http://bridge.test")
	r.Header.Set("Content-Type", "application/json")
	if c.cookie != nil {
		r.AddCookie(c.cookie)
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func tenantLogin(t *testing.T, h http.Handler, username, password string) tenantClient {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{"username": username, "password": password})
	w := tenantRequest(h, "POST", "/api/login", string(raw), tenantClient{})
	if w.Code != 200 {
		t.Fatalf("login %s: %d %s", username, w.Code, w.Body.String())
	}
	var out struct {
		User User   `json:"user"`
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return tenantClient{cookie: w.Result().Cookies()[0], csrf: out.CSRF, user: out.User}
}
func tenantPendingAccount(t *testing.T, h http.Handler, c tenantClient, username string) Account {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{"platform": "csdn", "username": username, "display_name": username})
	w := tenantRequest(h, "POST", "/api/accounts", string(raw), c)
	if w.Code != 201 {
		t.Fatalf("bind %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Account Account `json:"account"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	return out.Account
}
func tenantVerify(t *testing.T, h http.Handler, account Account, version int64) int {
	t.Helper()
	r := httptest.NewRequest("POST", "/internal/worker/identity", strings.NewReader("{}"))
	r.Header.Set("Authorization", "Bearer "+h.(*handler).connectionToken(account.ID, version))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}
func tenantAccount(t *testing.T, h http.Handler, c tenantClient, username string) Account {
	t.Helper()
	a := tenantPendingAccount(t, h, c, username)
	var version int64
	if err := h.(*handler).store.pool.QueryRow(context.Background(), "SELECT connection_version FROM account WHERE id=$1", a.ID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if status := tenantVerify(t, h, a, version); status != 200 {
		t.Fatal("synthetic identity proof", status)
	}
	a.Verified = true
	return a
}
func tenantJob(t *testing.T, h http.Handler, c tenantClient, account, request string) Job {
	t.Helper()
	raw, _ := json.Marshal(CreateInput{AccountID: account, RequestID: request, Platform: "csdn", Kind: "save_draft", Title: "用户独立测试文章", Markdown: "独立正文"})
	w := tenantRequest(h, "POST", "/api/jobs", string(raw), c)
	if w.Code != 202 {
		t.Fatalf("create job %d %s", w.Code, w.Body.String())
	}
	var job Job
	json.Unmarshal(w.Body.Bytes(), &job)
	return job
}

func TestMultiuserOwnershipMigrationAndIsolation(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	old := createTest(t, st, "existing-data")
	if _, err := st.pool.Exec(ctx, `INSERT INTO account_articles(account_id,username,id,record) VALUES('csdn-main','tester','123','{"id":"123","title":"保留文章","status":"draft"}')`); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Store: st, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"}
	h, err := NewHandler(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	a := tenantLogin(t, h, "admin", cfg.AdminPassword)
	if _, err = NewHandler(ctx, cfg); err != nil {
		t.Fatal("repeat migration", err)
	}
	var owner, title string
	if err = st.pool.QueryRow(ctx, "SELECT owner_user_id,record->>'title' FROM jobs WHERE id=$1", old.ID).Scan(&owner, &title); err != nil || owner != a.user.ID || title != old.Title {
		t.Fatal("legacy job lost", err, owner, title)
	}
	var count int
	if err = st.pool.QueryRow(ctx, "SELECT count(*) FROM account_articles WHERE id='123'").Scan(&count); err != nil || count != 1 {
		t.Fatal("legacy article lost", err)
	}
	replay, _ := json.Marshal(CreateInput{RequestID: old.RequestID, Platform: old.Platform, Kind: old.Kind, Title: old.Title, Markdown: old.Markdown})
	replayed := tenantRequest(h, "POST", "/api/jobs", string(replay), a)
	var replayJob Job
	json.Unmarshal(replayed.Body.Bytes(), &replayJob)
	if replayed.Code != 200 || replayJob.ID != old.ID {
		t.Fatal("migration broke idempotency", replayed.Code, replayed.Body.String())
	}
	w := tenantRequest(h, "POST", "/api/users", `{"username":"second","password":"second-user-secret"}`, a)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	b := tenantLogin(t, h, "second", "second-user-secret")
	w = tenantRequest(h, "GET", "/api/accounts", "", b)
	if w.Code != 200 || strings.Contains(w.Body.String(), "csdn-main") {
		t.Fatal("account leaked", w.Code, w.Body.String())
	}
	b1 := tenantAccount(t, h, b, "second_one")
	b2 := tenantAccount(t, h, b, "second_two")
	if b1.ID == b2.ID || b1.OwnerUserID != b.user.ID || b2.OwnerUserID != b.user.ID {
		t.Fatal("same-platform account ownership")
	}
	aj := tenantJob(t, h, a, "csdn-main", "same-request")
	bj := tenantJob(t, h, b, b1.ID, "same-request")
	if aj.ID == bj.ID {
		t.Fatal("request identifiers crossed users")
	}
	for _, path := range []string{"/api/accounts/csdn-main", "/api/jobs/" + aj.ID, "/api/jobs/" + old.ID, "/api/jobs/" + aj.ID + "/history", "/api/account/articles?account_id=csdn-main", "/api/account/login?account_id=csdn-main"} {
		w = tenantRequest(h, "GET", path, "", b)
		if w.Code != 404 {
			t.Fatalf("cross-user %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/api/jobs", "/api/logs", "/api/processes", "/api/overview"} {
		w = tenantRequest(h, "GET", path, "", b)
		if w.Code != 200 || strings.Contains(w.Body.String(), aj.ID) || strings.Contains(w.Body.String(), old.ID) {
			t.Fatalf("listing leaked %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w = tenantRequest(h, "POST", "/api/jobs/"+aj.ID+"/cancel", "{}", b)
	if w.Code != 404 {
		t.Fatal("cross-user cancellation", w.Code)
	}
	w = tenantRequest(h, "GET", "/api/users", "", b)
	if w.Code != 403 {
		t.Fatal("user administration exposed", w.Code)
	}
	actor := scoped(ctx, tenantScope{UserID: b.user.ID, AccountID: b1.ID})
	if err = st.pool.QueryRow(actor, "SELECT count(*) FROM account WHERE id='csdn-main'").Scan(&count); err != nil || count != 0 {
		t.Fatal("database ownership bypass", err, count)
	}
	if _, err = st.pool.Exec(ctx, "UPDATE account SET owner_user_id=$2 WHERE id=$1", b1.ID, a.user.ID); err == nil {
		t.Fatal("account transfer accepted")
	}
	token := h.(*handler).connectionToken(b1.ID, 1)
	r := httptest.NewRequest("GET", "/internal/worker/accounts", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	ww := httptest.NewRecorder()
	h.ServeHTTP(ww, r)
	if ww.Code != 401 {
		t.Fatal("account worker obtained scheduler credentials", ww.Code)
	}
	w = tenantRequest(h, "DELETE", "/api/accounts/"+b1.ID, "", b)
	if w.Code != 200 {
		t.Fatal("unbind", w.Code, w.Body.String())
	}
	r = httptest.NewRequest("POST", "/internal/worker/claim", strings.NewReader(`{"worker_id":"revoked"}`))
	r.Header.Set("Authorization", "Bearer "+token)
	ww = httptest.NewRecorder()
	h.ServeHTTP(ww, r)
	if ww.Code != 401 {
		t.Fatal("revoked executor accepted", ww.Code)
	}
	rebound := tenantAccount(t, h, b, b1.Username)
	if rebound.ID != b1.ID || rebound.OwnerUserID != b.user.ID {
		t.Fatal("rebind changed identity or owner")
	}
	r = httptest.NewRequest("POST", "/internal/worker/claim", strings.NewReader(`{"worker_id":"old-connection"}`))
	r.Header.Set("Authorization", "Bearer "+token)
	ww = httptest.NewRecorder()
	h.ServeHTTP(ww, r)
	if ww.Code != 401 {
		t.Fatal("rebind revived old executor", ww.Code)
	}
	w = tenantRequest(h, "PATCH", "/api/users/"+b.user.ID, `{"enabled":false}`, a)
	if w.Code != 200 {
		t.Fatal("disable user", w.Code, w.Body.String())
	}
	w = tenantRequest(h, "GET", "/api/session", "", b)
	if w.Code != 401 {
		t.Fatal("disabled user retained session", w.Code)
	}
}

func TestMultiuserIdentityProofPreventsSquattingAndTransfer(t *testing.T) {
	store := testStore(t)
	h, err := NewHandler(context.Background(), Config{Store: store, AdminUsername: "admin", AdminPassword: "administrator-secret", WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	a := tenantLogin(t, h, "admin", "administrator-secret")
	response := tenantRequest(h, "POST", "/api/users", `{"username":"second","password":"second-user-secret"}`, a)
	if response.Code != 201 {
		t.Fatal(response.Code)
	}
	b := tenantLogin(t, h, "second", "second-user-secret")
	pending := tenantPendingAccount(t, h, a, "same_identity")
	owned := tenantPendingAccount(t, h, b, "same_identity")
	response = tenantRequest(h, "POST", "/api/accounts/"+pending.ID+"/check", `{"request_id":"pending-check"}`, a)
	if response.Code != 409 {
		t.Fatal("unverified check accepted", response.Code, response.Body.String())
	}
	data := fmt.Sprintf(`{"account_id":%q,"request_id":"blocked","platform":"csdn","kind":"save_draft","title":"测试文章标题","markdown":"测试正文"}`, pending.ID)
	if response = tenantRequest(h, "POST", "/api/jobs", data, a); response.Code != 409 {
		t.Fatal("unverified account executed", response.Code, response.Body.String())
	}
	if status := tenantVerify(t, h, owned, 1); status != 200 {
		t.Fatal("verified owner rejected", status)
	}
	if status := tenantVerify(t, h, pending, 1); status != 409 {
		t.Fatal("identity claimed twice", status)
	}
	if response = tenantRequest(h, "DELETE", "/api/accounts/"+owned.ID, "", b); response.Code != 200 {
		t.Fatal(response.Code)
	}
	if status := tenantVerify(t, h, pending, 1); status != 409 {
		t.Fatal("unbinding transferred identity", status)
	}
}

func TestMultiuserMigrationKeepsPersistedRecordsAndSessions(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	for _, schema := range []string{schemaSQL, integrationSchemaSQL, integrationContentSchemaSQL} {
		if _, err := pool.Exec(ctx, schema); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, "CREATE UNIQUE INDEX account_platform_idx ON account(platform)"); err != nil {
		t.Fatal(err)
	}
	password := "administrator-secret"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO admins(username,password_hash) VALUES('admin',$1)", string(hash)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO account(id,username,display_name) VALUES('csdn-main','tester','已有账号')"); err != nil {
		t.Fatal(err)
	}
	input := CreateInput{RequestID: "persisted-request", Platform: "csdn", Kind: "save_draft", Title: "已有文章标题", Markdown: "已有正文"}
	record := newRecord(input, time.Now().UTC())
	raw, _ := json.Marshal(record)
	if _, err = pool.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)", record.ID, input.RequestID, fingerprint(input), raw, record.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO article_read_requests(request_id,fingerprint,job_id) VALUES('persisted-alias',$1,$2)", fingerprint(input), record.ID); err != nil {
		t.Fatal(err)
	}
	token := randomToken()
	if _, err = pool.Exec(ctx, "INSERT INTO sessions(token_hash,username,csrf_token,expires_at) VALUES($1,'admin','persisted-csrf',$2)", hashToken(token), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(ctx, pool, "tester", "已有账号")
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(ctx, Config{Store: store, AdminUsername: "admin", AdminPassword: password, WorkerToken: strings.Repeat("w", 32), Origin: "http://bridge.test"})
	if err != nil {
		t.Fatal(err)
	}
	user := tenantLogin(t, h, "admin", password)
	response := tenantRequest(h, "GET", "/api/session", "", tenantClient{cookie: &http.Cookie{Name: "post_bridge_session", Value: token}})
	if response.Code != 200 {
		t.Fatal("persisted session lost", response.Code, response.Body.String())
	}
	data, _ := json.Marshal(input)
	response = tenantRequest(h, "POST", "/api/jobs", string(data), user)
	var replay Job
	json.Unmarshal(response.Body.Bytes(), &replay)
	if response.Code != 200 || replay.ID != record.ID || replay.Markdown != input.Markdown || replay.OwnerUserID != user.user.ID {
		t.Fatal("persisted request replay changed", response.Code, response.Body.String())
	}
	var owner, namespace string
	if err = pool.QueryRow(ctx, "SELECT owner_user_id,request_namespace FROM article_read_requests WHERE request_id='persisted-alias'").Scan(&owner, &namespace); err != nil || owner != user.user.ID || namespace != "user:"+user.user.ID {
		t.Fatal("read alias lost ownership", err)
	}
	tenantAccount(t, h, user, "second_persisted_account")
	if _, err = NewStore(ctx, pool, "tester", "已有账号"); err != nil {
		t.Fatal("repeat schema migration", err)
	}
}
