package bridge

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type RuntimeConfig struct {
	Formatting                                                                                                                 FormattingConfig
	PlatformAccounts                                                                                                           []PlatformAccountConfig
	DatabaseURL, Address, Origin, Username, Password, WorkerToken, CSDNUsername, CSDNDisplayName, AdminDistDir, RemoteLoginURL string
	IntegrationMasterKey, IntegrationEnvironment, IntegrationServiceID                                                         string
}

func privateSecret(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("缺少私有凭据文件")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("无法读取私有凭据文件")
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 4096 {
		return "", fmt.Errorf("凭据文件必须为私有普通文件")
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		return "", fmt.Errorf("无法读取私有凭据文件")
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}
func LoadRuntimeConfig() (RuntimeConfig, error) {
	c := RuntimeConfig{
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		Address:         os.Getenv("API_ADDR"),
		Origin:          os.Getenv("API_BASE_URL"),
		Username:        os.Getenv("ADMIN_USERNAME"),
		CSDNUsername:    os.Getenv("CSDN_USERNAME"),
		CSDNDisplayName: os.Getenv("CSDN_DISPLAY_NAME"),
		AdminDistDir:    os.Getenv("ADMIN_DIST_DIR"),
	}
	c.RemoteLoginURL = os.Getenv("REMOTE_LOGIN_URL")
	if public := os.Getenv("PUBLIC_ORIGIN"); public != "" {
		c.Origin = public
	}
	if c.Address == "" {
		c.Address = "127.0.0.1:8080"
	}
	if c.Origin == "" {
		c.Origin = "http://" + c.Address
	}
	if c.DatabaseURL == "" || !validKey(c.Username) || strings.TrimSpace(c.CSDNUsername) == "" || strings.TrimSpace(c.CSDNDisplayName) == "" {
		return c, fmt.Errorf("缺少必要服务配置")
	}
	if _, _, err := net.SplitHostPort(c.Address); err != nil {
		return c, fmt.Errorf("API 监听地址无效")
	}
	u, err := url.Parse(c.Origin)
	if err != nil || u.Host == "" || u.User != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.RawQuery != "" || u.Fragment != "" || !(u.Path == "" || u.Path == "/") {
		return c, fmt.Errorf("管理站点来源无效")
	}
	if err = validateRemoteLoginURL(c.RemoteLoginURL); err != nil {
		return c, fmt.Errorf("远程登录控制地址无效")
	}
	if c.Password, err = privateSecret(os.Getenv("ADMIN_PASSWORD_FILE")); err != nil {
		return c, err
	}
	if c.WorkerToken, err = privateSecret(os.Getenv("WORKER_TOKEN_FILE")); err != nil {
		return c, err
	}
	if len(c.Password) < 12 || len(c.Password) > 72 || len(c.WorkerToken) < 32 || strings.ContainsAny(c.WorkerToken, " \t\n\r") {
		return c, fmt.Errorf("私有凭据强度或格式不符合要求")
	}
	if c.PlatformAccounts, err = loadPlatformAccounts(os.Getenv("PLATFORM_ACCOUNTS_FILE"), c.WorkerToken); err != nil {
		return c, fmt.Errorf("平台账号私有配置无效")
	}
	if path := os.Getenv("INTEGRATION_MASTER_KEY_FILE"); path != "" {
		if c.IntegrationMasterKey, err = privateSecret(path); err != nil {
			return c, err
		}
		c.IntegrationEnvironment = os.Getenv("INTEGRATION_ENVIRONMENT")
		c.IntegrationServiceID = os.Getenv("INTEGRATION_SERVICE_ID")
		keyBytes, keyErr := hex.DecodeString(c.IntegrationMasterKey)
		if keyErr != nil || len(keyBytes) != 32 || u.Scheme != "https" || !validKey(c.IntegrationEnvironment) || !validKey(c.IntegrationServiceID) {
			return c, fmt.Errorf("外部平台认证配置无效")
		}
	}
	if c.Formatting, err = loadFormattingConfig(); err != nil {
		return c, err
	}
	return c, nil
}
func Run(ctx context.Context, c RuntimeConfig) error {
	poolConfig, err := pgxpool.ParseConfig(c.DatabaseURL)
	if err != nil {
		return fmt.Errorf("数据库配置无效")
	}
	poolConfig.MaxConns = 8
	poolConfig.ConnConfig.ConnectTimeout = 10 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("无法连接数据库")
	}
	defer pool.Close()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	store, err := NewStore(startup, pool, c.CSDNUsername, c.CSDNDisplayName)
	if err != nil {
		cancel()
		return fmt.Errorf("数据库初始化失败")
	}
	h, err := NewHandler(startup, Config{
		Formatting:             c.Formatting,
		PlatformAccounts:       c.PlatformAccounts,
		Store:                  store,
		AdminUsername:          c.Username,
		AdminPassword:          c.Password,
		WorkerToken:            c.WorkerToken,
		Origin:                 c.Origin,
		AdminDistDir:           c.AdminDistDir,
		RemoteLoginURL:         c.RemoteLoginURL,
		IntegrationMasterKey:   c.IntegrationMasterKey,
		IntegrationEnvironment: c.IntegrationEnvironment,
		IntegrationServiceID:   c.IntegrationServiceID,
	})
	cancel()
	if err != nil {
		return fmt.Errorf("管理接口初始化失败")
	}
	remoteHandler := h.(*handler)
	formattingCtx, stopFormatting := context.WithCancel(ctx)
	formattingDone := make(chan struct{})
	if c.Formatting.Enabled {
		go func() {
			defer close(formattingDone)
			remoteHandler.runFormattingScheduler(formattingCtx)
		}()
	} else {
		close(formattingDone)
	}
	defer func() {
		stopFormatting()
		<-formattingDone
	}()
	defer func() {
		remoteHandler.closeRemoteLogin(context.Background(), "")
		if remoteHandler.remoteLoginProxy != nil {
			remoteHandler.remoteLoginProxy.client.CloseIdleConnections()
		}
	}()
	listener, err := net.Listen("tcp", c.Address)
	if err != nil {
		return fmt.Errorf("无法监听 API 地址")
	}
	server := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	shutdown := func() {
		if remoteHandler.remoteLoginProxy != nil {
			remoteHandler.remoteLoginProxy.disabled.Store(true)
		}
		stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if server.Shutdown(stop) != nil {
			server.Close()
		}
	}
	for {
		select {
		case <-ctx.Done():
			shutdown()
			<-done
			return nil
		case err := <-done:
			shutdown()
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return fmt.Errorf("API 服务中断")
		case <-ticker.C:
			maintenance, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = store.Maintain(maintenance)
			cancel()
			if err != nil && ctx.Err() == nil {
				shutdown()
				<-done
				return fmt.Errorf("数据库维护失败，服务已安全停止")
			}
			_ = remoteHandler.maintainRemoteLogin(ctx)
		}
	}
}
