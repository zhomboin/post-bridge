package bridge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrIntegrationExpired = errors.New("integration_expired")
var ErrIntegrationUnsupported = errors.New("integration_unsupported")
var ErrIntegrationSourceChanged = errors.New("integration_source_changed")

type IntegrationAsset struct {
	ID       string `json:"id"`
	Checksum string `json:"checksum"`
}
type IntegrationSnapshot struct {
	Title         string             `json:"title"`
	Summary       string             `json:"summary"`
	Body          string             `json:"body"`
	BodyFormat    string             `json:"body_format"`
	Tags          []string           `json:"tags"`
	CoverImageURL string             `json:"cover_image_url"`
	Assets        []IntegrationAsset `json:"assets"`
	OriginalURL   string             `json:"original_url,omitempty"`
}
type IntegrationTarget struct {
	Platform  string `json:"platform"`
	AccountID string `json:"account_id"`
	Operation string `json:"operation"`
}
type IntegrationDraft struct {
	ID        string `json:"id"`
	Platform  string `json:"platform"`
	AccountID string `json:"account_id"`
	Operation string `json:"operation"`
	Title     string `json:"title"`
	Markdown  string `json:"markdown"`
	Revision  int64  `json:"revision"`
}
type IntegrationPreparation struct {
	ID                      string              `json:"id"`
	ClientID                string              `json:"client_id"`
	SourceID                string              `json:"source_id"`
	RequestID               string              `json:"request_id"`
	ArticleID               string              `json:"article_id"`
	SourceVersion           int64               `json:"source_version"`
	StateSeq                int64               `json:"state_seq"`
	AuthorizationID         string              `json:"authorization_id"`
	AuthorizationExpiresAt  time.Time           `json:"authorization_expires_at"`
	ContentFingerprint      string              `json:"content_fingerprint"`
	Snapshot                IntegrationSnapshot `json:"snapshot"`
	Targets                 []IntegrationTarget `json:"targets"`
	Drafts                  []IntegrationDraft  `json:"drafts"`
	Revision                int64               `json:"revision"`
	DraftRevisionIDs        []string            `json:"draft_revision_ids"`
	ConfirmationFingerprint string              `json:"confirmation_fingerprint"`
	Confirmed               bool                `json:"confirmed"`
	Status                  string              `json:"status"`
	GrantVersion            int64               `json:"grant_version"`
	ExpiresAt               time.Time           `json:"expires_at"`
	CreatedAt               time.Time           `json:"created_at"`
}
type IntegrationPrepareInput struct {
	RequestID              string              `json:"request_id"`
	SourceID               string              `json:"source_id"`
	ArticleID              string              `json:"article_id"`
	SourceVersion          int64               `json:"source_version"`
	StateSeq               int64               `json:"state_seq"`
	AuthorizationID        string              `json:"authorization_id"`
	AuthorizationExpiresAt time.Time           `json:"authorization_expires_at"`
	ContentFingerprint     string              `json:"content_fingerprint"`
	Snapshot               IntegrationSnapshot `json:"snapshot"`
	Targets                []IntegrationTarget `json:"targets"`
}
type IntegrationSubmitInput struct {
	RequestID               string              `json:"request_id"`
	SourceID                string              `json:"source_id"`
	ArticleID               string              `json:"article_id"`
	SourceVersion           int64               `json:"source_version"`
	StateSeq                int64               `json:"state_seq"`
	ContentFingerprint      string              `json:"content_fingerprint"`
	PreparationID           string              `json:"preparation_id"`
	DraftRevisionIDs        []string            `json:"draft_revision_ids"`
	ConfirmationFingerprint string              `json:"confirmation_fingerprint"`
	Targets                 []IntegrationTarget `json:"targets"`
}
type IntegrationDistribution struct {
	ID                      string              `json:"id"`
	ClientID                string              `json:"client_id"`
	SourceID                string              `json:"source_id"`
	ArticleID               string              `json:"article_id"`
	RequestID               string              `json:"request_id"`
	PreparationID           string              `json:"preparation_id"`
	SourceVersion           int64               `json:"source_version"`
	StateSeq                int64               `json:"state_seq"`
	ContentFingerprint      string              `json:"content_fingerprint"`
	ConfirmationFingerprint string              `json:"confirmation_fingerprint"`
	GrantVersion            int64               `json:"grant_version"`
	Targets                 []IntegrationTarget `json:"targets"`
	JobIDs                  []string            `json:"job_ids"`
	CreatedAt               time.Time           `json:"created_at"`
}
type IntegrationSourceEvent struct {
	EventID            string `json:"event_id"`
	SourceID           string `json:"source_id"`
	ArticleID          string `json:"article_id"`
	StateSeq           int64  `json:"state_seq"`
	SourceVersion      int64  `json:"source_version"`
	Type               string `json:"type"`
	Status             string `json:"status"`
	AuthorizationID    string `json:"authorization_id,omitempty"`
	AuthorizationValid bool   `json:"authorization_valid"`
	ContentFingerprint string `json:"content_fingerprint,omitempty"`
}

func integrationNormalizeSnapshot(s IntegrationSnapshot) IntegrationSnapshot {
	s.Title = strings.TrimSpace(s.Title)
	s.Body = strings.ReplaceAll(strings.ReplaceAll(s.Body, "\r\n", "\n"), "\r", "\n")
	if s.Tags == nil {
		s.Tags = []string{}
	}
	if s.Assets == nil {
		s.Assets = []IntegrationAsset{}
	}
	return s
}
func integrationDigest(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	sum := sha256.Sum256(bytes.TrimSuffix(buf.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(sum[:])
}
func IntegrationContentFingerprint(s IntegrationSnapshot) (string, error) {
	s = integrationNormalizeSnapshot(s)
	if !utf8.ValidString(s.Title + s.Summary + s.Body) {
		return "", ErrInvalid
	}
	return integrationDigest([]any{"postbridge-content-v1", s.Title, s.Summary, s.Body, s.BodyFormat, s.Tags, s.CoverImageURL, s.Assets}), nil
}
func validateIntegrationSnapshot(s IntegrationSnapshot) error {
	if s.BodyFormat != "markdown" || len(s.Assets) > 0 || s.CoverImageURL != "" {
		return ErrIntegrationUnsupported
	}
	if utf8.RuneCountInString(s.Summary) > 2000 || len(s.Tags) > 20 || !utf8.ValidString(s.Summary) || strings.ContainsRune(s.Summary, 0) {
		return ErrInvalid
	}
	for _, tag := range s.Tags {
		if strings.TrimSpace(tag) == "" || utf8.RuneCountInString(tag) > 64 || !utf8.ValidString(tag) || strings.ContainsRune(tag, 0) {
			return ErrInvalid
		}
	}
	if strings.ContainsRune(s.Body, 0) || strings.ContainsRune(s.Title, 0) {
		return ErrInvalid
	}
	if s.OriginalURL != "" {
		u, err := url.Parse(s.OriginalURL)
		if err != nil || u.User != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
			return ErrInvalid
		}
	}
	if err := ValidateCreate(CreateInput{RequestID: "validate", Kind: "save_draft", Platform: "csdn", Title: s.Title, Markdown: s.Body}); err != nil {
		return ErrIntegrationUnsupported
	}
	return nil
}
func validateIntegrationTargets(targets []IntegrationTarget) error {
	if len(targets) != 1 {
		return ErrIntegrationUnsupported
	}
	for _, target := range targets {
		if target.Platform != "csdn" || target.AccountID != "csdn-main" || target.Operation != "save_draft" {
			return ErrIntegrationUnsupported
		}
	}
	return nil
}
func integrationConfirmation(p IntegrationPreparation) string {
	return integrationDigest([]any{"postbridge-confirmation-v1", p.ID, p.Revision, p.ContentFingerprint, p.Targets, p.Drafts, p.GrantVersion})
}
func integrationEventValid(e IntegrationSourceEvent) bool {
	if !validKey(e.EventID) || !validKey(e.SourceID) || !validKey(e.ArticleID) || e.StateSeq < 1 || e.SourceVersion < 1 {
		return false
	}
	switch e.Type {
	case "published":
		return e.Status == "published" && e.AuthorizationValid && len(e.ContentFingerprint) == 64
	case "updated":
		return (e.Status == "draft" || e.Status == "published") && len(e.ContentFingerprint) == 64
	case "unpublished":
		return e.Status == "draft" && !e.AuthorizationValid
	case "private":
		return e.Status == "private" && !e.AuthorizationValid
	case "deleted":
		return e.Status == "deleted" && !e.AuthorizationValid
	case "authorization_revoked":
		return !e.AuthorizationValid
	}
	return false
}
