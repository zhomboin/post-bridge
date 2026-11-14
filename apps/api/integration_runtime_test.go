package bridge

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRuntimeIntegrationConfigurationIsIndependentAndHTTPS(t *testing.T) {
	dir := t.TempDir()
	password, worker, key := filepath.Join(dir, "admin"), filepath.Join(dir, "worker"), filepath.Join(dir, "integration")
	for path, value := range map[string]string{
		password: "long-test-admin-password",
		worker:   "worker-at-least-thirty-two-characters",
		key:      strings.Repeat("ab", 32),
	} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for name, value := range map[string]string{
		"DATABASE_URL":                "postgres://project/db",
		"ADMIN_USERNAME":              "admin",
		"ADMIN_PASSWORD_FILE":         password,
		"WORKER_TOKEN_FILE":           worker,
		"CSDN_USERNAME":               "tester",
		"CSDN_DISPLAY_NAME":           "测试账号",
		"API_ADDR":                    "127.0.0.1:18080",
		"API_BASE_URL":                "http://127.0.0.1:18080",
		"PUBLIC_ORIGIN":               "https://bridge.example.test",
		"INTEGRATION_MASTER_KEY_FILE": key,
		"INTEGRATION_ENVIRONMENT":     "test",
		"INTEGRATION_SERVICE_ID":      "bridge",
	} {
		t.Setenv(name, value)
	}
	cfg, err := LoadRuntimeConfig()
	if err != nil || cfg.IntegrationMasterKey != strings.Repeat("ab", 32) {
		t.Fatal("private integration config not loaded", err)
	}
	t.Setenv("PUBLIC_ORIGIN", "http://bridge.example.test")
	if _, err = LoadRuntimeConfig(); err == nil {
		t.Fatal("integration enabled without HTTPS")
	}
	t.Setenv("PUBLIC_ORIGIN", "https://bridge.example.test")
	if err = os.WriteFile(key, []byte(strings.Repeat("x", 64)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LoadRuntimeConfig(); err == nil {
		t.Fatal("non-hex encryption key accepted")
	}
}

func TestIntegrationRuntimeStartsAndStopsWithoutWorker(t *testing.T) {
	store := testStore(t)
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	_ = probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	cfg := RuntimeConfig{
		DatabaseURL:            isolatedRuntimeDatabaseURL(t, store.pool.Config()),
		Address:                address,
		Origin:                 "https://bridge.example.test",
		Username:               "admin",
		Password:               "long-test-admin-password",
		WorkerToken:            "worker-at-least-thirty-two-characters",
		CSDNUsername:           "runtime_fixture",
		CSDNDisplayName:        "运行验证账号",
		IntegrationMasterKey:   strings.Repeat("ab", 32),
		IntegrationEnvironment: "test",
		IntegrationServiceID:   "bridge",
	}
	go func() { done <- Run(ctx, cfg) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("临时API未停止")
		}
	})
	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(5 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		response, e := client.Get("http://" + address + "/healthz")
		if e == nil {
			_ = response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	var schemaAccount string
	if err = store.pool.QueryRow(context.Background(), "SELECT username FROM account WHERE id='csdn-main'").Scan(&schemaAccount); err != nil || schemaAccount != "tester" {
		t.Fatal("运行验证未写入指定隔离schema")
	}
	if !ready {
		t.Fatal("接入API未正常启动")
	}
	response, err := client.Get("http://" + address + "/api/integration-clients")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("管理接入接口未受保护", response.StatusCode)
	}
}

func isolatedRuntimeDatabaseURL(t *testing.T, config *pgxpool.Config) string {
	t.Helper()
	schemaName := config.ConnConfig.RuntimeParams["search_path"]
	if !strings.HasPrefix(schemaName, "test_") || !validKey(schemaName) {
		t.Fatal("运行验证必须显式绑定隔离 schema")
	}
	connectionURL, err := url.Parse(config.ConnConfig.ConnString())
	if err != nil {
		t.Fatal("隔离运行库连接无法解析")
	}
	params := connectionURL.Query()
	params.Set("search_path", schemaName)
	connectionURL.RawQuery = params.Encode()
	parsed, err := pgxpool.ParseConfig(connectionURL.String())
	if err != nil || parsed.ConnConfig.RuntimeParams["search_path"] != schemaName {
		t.Fatal("隔离 schema 未随连接串传递")
	}
	return connectionURL.String()
}
