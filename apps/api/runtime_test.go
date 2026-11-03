package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeConfigRequiresPrivateSecretFiles(t *testing.T) {
	dir := t.TempDir()
	password := filepath.Join(dir, "password")
	token := filepath.Join(dir, "token")
	os.WriteFile(password, []byte("long-test-admin-password\n"), 0600)
	os.WriteFile(token, []byte("worker-secret-at-least-thirty-two-chars\n"), 0600)
	t.Setenv("DATABASE_URL", "postgres://project/db")
	t.Setenv("ADMIN_USERNAME", "admin")
	t.Setenv("ADMIN_PASSWORD_FILE", password)
	t.Setenv("WORKER_TOKEN_FILE", token)
	t.Setenv("CSDN_USERNAME", "tester")
	t.Setenv("CSDN_DISPLAY_NAME", "测试账号")
	t.Setenv("API_ADDR", "127.0.0.1:18080")
	t.Setenv("API_BASE_URL", "http://127.0.0.1:18080")
	cfg, err := LoadRuntimeConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "long-test-admin-password" || cfg.WorkerToken != "worker-secret-at-least-thirty-two-chars" || cfg.Address != "127.0.0.1:18080" {
		t.Fatal("configuration did not preserve secrets")
	}
	os.Chmod(password, 0644)
	if _, err = LoadRuntimeConfig(); err == nil {
		t.Fatal("public password file accepted")
	}
	os.Chmod(password, 0600)
	os.WriteFile(token, []byte("short"), 0600)
	if _, err = LoadRuntimeConfig(); err == nil {
		t.Fatal("weak worker credential accepted")
	}
}
