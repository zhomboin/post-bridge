package bridge

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type FormattingConfig struct {
	Enabled            bool
	LocalEnabled       bool
	APIKey             string
	Model              string
	BaseURL            string
	FormatterURL       string
	FormatterToken     string
	Timeout            time.Duration
	MaxInputCharacters int
	MaxOutputTokens    int
	DailyTokens        int64
	MaxInFlight        int
	Client             *http.Client
}

func defaultFormattingConfig() FormattingConfig {
	return FormattingConfig{Model: "deepseek-flash", BaseURL: "https://api.deepseek.com", Timeout: 180 * time.Second, MaxInputCharacters: 30000, MaxOutputTokens: 16384, DailyTokens: 300000, MaxInFlight: 2}
}
func loadFormattingConfig() (FormattingConfig, error) {
	c := defaultFormattingConfig()
	local := os.Getenv("CONTENT_FORMATTING_ENABLED")
	if local != "" && local != "true" && local != "false" {
		return c, fmt.Errorf("本地格式化开关无效")
	}
	c.LocalEnabled = local == "true"
	raw := os.Getenv("AI_FORMATTING_ENABLED")
	if (raw == "" || raw == "false") && !c.LocalEnabled {
		return c, nil
	}
	if raw != "" && raw != "false" && raw != "true" {
		return c, fmt.Errorf("AI 格式化开关无效")
	}
	c.Enabled = raw == "true"
	c.LocalEnabled = true
	c.FormatterURL = os.Getenv("FORMATTER_URL")
	var err error
	c.FormatterToken, err = privateSecret(os.Getenv("FORMATTER_TOKEN_FILE"))
	if err != nil || len(c.FormatterToken) < 32 {
		return c, fmt.Errorf("缺少有效的格式化服务凭据")
	}
	if file := os.Getenv("AI_PROVIDER_CONFIG_FILE"); c.Enabled && file != "" {
		raw, e := privateSecret(file)
		if e != nil {
			return c, fmt.Errorf("模型配置文件必须为私有普通文件")
		}
		var v struct {
			Model              string `json:"model"`
			APIKeyFile         string `json:"api_key_file"`
			MaxInputCharacters int    `json:"max_input_characters"`
			MaxOutputTokens    int    `json:"max_output_tokens"`
			DailyTokens        int64  `json:"daily_tokens"`
			MaxInFlight        int    `json:"max_in_flight"`
			TimeoutSeconds     int    `json:"timeout_seconds"`
		}
		if strictJSON([]byte(raw), &v) != nil {
			return c, fmt.Errorf("模型配置无效")
		}
		if v.Model != "" {
			c.Model = v.Model
		}
		if v.APIKeyFile != "" {
			c.APIKey, err = privateSecret(v.APIKeyFile)
			if err != nil {
				return c, fmt.Errorf("模型密钥文件无效")
			}
		}
		if v.MaxInputCharacters != 0 {
			c.MaxInputCharacters = v.MaxInputCharacters
		}
		if v.MaxOutputTokens != 0 {
			c.MaxOutputTokens = v.MaxOutputTokens
		}
		if v.DailyTokens != 0 {
			c.DailyTokens = v.DailyTokens
		}
		if v.MaxInFlight != 0 {
			c.MaxInFlight = v.MaxInFlight
		}
		if v.TimeoutSeconds != 0 {
			c.Timeout = time.Duration(v.TimeoutSeconds) * time.Second
		}
	}
	if c.Enabled && c.APIKey == "" {
		c.APIKey = os.Getenv("DEEPSEEK_API")
	}
	if c.Enabled && c.APIKey == "" {
		c.APIKey = os.Getenv("DEEPSEEK_API_KEY")
	}
	if err = c.validate(); err != nil {
		return c, err
	}
	return c, nil
}
func (c FormattingConfig) validate() error {
	u, err := url.Parse(c.FormatterURL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return fmt.Errorf("格式化服务地址必须为本机回环 HTTP 地址")
	}
	port, e := strconv.Atoi(u.Port())
	if e != nil || port < 1 || port > 65535 || net.ParseIP(u.Hostname()) == nil {
		return fmt.Errorf("格式化服务端口无效")
	}
	if c.Enabled && (strings.TrimSpace(c.APIKey) == "" || strings.ContainsAny(c.APIKey, "\r\n\x00") || len(c.APIKey) > 4096 || strings.TrimSpace(c.Model) == "" || len(c.Model) > 100) ||
		c.MaxInputCharacters < 100 || c.MaxInputCharacters > 100000 || c.MaxOutputTokens < 256 || c.MaxOutputTokens > 32768 ||
		c.DailyTokens < int64(c.MaxOutputTokens) || c.DailyTokens > 10000000 || c.MaxInFlight < 1 || c.MaxInFlight > 4 || c.Timeout < time.Second || c.Timeout > 5*time.Minute {
		return fmt.Errorf("DeepSeek 格式化配置无效")
	}
	return nil
}
func (c FormattingConfig) httpClient() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: c.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
