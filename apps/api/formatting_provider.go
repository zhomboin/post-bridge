package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

var ErrFormattingContent = errors.New("formatting_content_invalid")

type FormattingModelResult struct {
	Title         string            `json:"title"`
	Summary       string            `json:"summary"`
	Tags          []string          `json:"tags"`
	Edits         []FormattingEdit  `json:"edits"`
	Body          string            `json:"body"`
	Topics        []string          `json:"topics"`
	CoverTitle    string            `json:"cover_title"`
	CoverSubtitle string            `json:"cover_subtitle"`
	Cards         []FormattingCard  `json:"cards"`
	Omissions     []string          `json:"omissions"`
	Issues        []FormattingIssue `json:"issues"`
}
type FormattingEdit struct {
	ID       string `json:"id"`
	Markdown string `json:"markdown"`
}
type FormattingUsage struct {
	Input  int64
	Output int64
}
type formattingError string

func (e formattingError) Error() string { return string(e) }
func strictJSON(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return ErrFormattingContent
	}
	if d.Decode(new(any)) != io.EOF {
		return ErrFormattingContent
	}
	return nil
}
func (c FormattingConfig) generate(ctx context.Context, platform string, snapshot FormattingSnapshot, blocks []FormattingBlock) (FormattingModelResult, FormattingUsage, error) {
	var result FormattingModelResult
	var usage FormattingUsage
	prompt, err := formattingPrompt(platform)
	if err != nil {
		return result, usage, err
	}
	input, _ := json.Marshal(map[string]any{"title": snapshot.Title, "summary": snapshot.Summary, "tags": snapshot.Tags, "blocks": blocks})
	body, _ := json.Marshal(map[string]any{
		"model": c.Model, "stream": false, "thinking": map[string]string{"type": "disabled"},
		"response_format": map[string]string{"type": "json_object"}, "max_tokens": c.MaxOutputTokens,
		"messages": []map[string]string{{"role": "system", "content": prompt}, {"role": "user", "content": string(input)}},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return result, usage, formattingError("provider_unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient().Do(req)
	if err != nil {
		return result, usage, formattingError("provider_interrupted")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		code := "provider_unavailable"
		if response.StatusCode == 401 || response.StatusCode == 403 {
			code = "provider_credentials"
		}
		if response.StatusCode == 429 {
			code = "provider_rate_limited"
		}
		return result, usage, formattingError(code)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil || len(raw) >= 2<<20 {
		return result, usage, formattingError("provider_invalid_response")
	}
	var envelope struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &envelope) != nil || len(envelope.Choices) != 1 {
		return result, usage, formattingError("provider_invalid_response")
	}
	usage = FormattingUsage{Input: envelope.Usage.PromptTokens, Output: envelope.Usage.CompletionTokens}
	if usage.Input < 0 || usage.Output < 0 || usage.Input > 10000000 || usage.Output > 10000000 {
		return result, FormattingUsage{}, formattingError("provider_invalid_response")
	}
	choice := envelope.Choices[0]
	if choice.FinishReason != "stop" {
		return result, usage, formattingError("provider_incomplete")
	}
	if strings.TrimSpace(choice.Message.Content) == "" || strictJSON([]byte(choice.Message.Content), &result) != nil {
		return result, usage, formattingError("provider_invalid_json")
	}
	return result, usage, nil
}
func (c FormattingConfig) formatter(ctx context.Context, path string, input, out any) error {
	raw, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.FormatterURL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return formattingError("renderer_unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+c.FormatterToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient().Do(req)
	if err != nil {
		return formattingError("renderer_unavailable")
	}
	defer response.Body.Close()
	raw, err = io.ReadAll(io.LimitReader(response.Body, 24<<20))
	if err != nil || len(raw) >= 24<<20 {
		return formattingError("renderer_unavailable")
	}
	if response.StatusCode != 200 {
		var failure struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &failure)
		if integrationHas([]string{"card_overflow", "too_many_cards", "renderer_unavailable", "renderer_busy"}, failure.Code) {
			return formattingError(failure.Code)
		}
		return ErrFormattingContent
	}
	if json.Unmarshal(raw, out) != nil {
		return ErrFormattingContent
	}
	return nil
}
