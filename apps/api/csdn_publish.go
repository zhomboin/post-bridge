package bridge

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
)

var (
	errCSDNPublishTags    = errors.New("CSDN publication requires one to seven tags")
	errCSDNPublishOptions = errors.New("CSDN publication options are unsupported")
)

type csdnPublishPreview struct {
	Title             string             `json:"title"`
	AccountUsername   string             `json:"account_username"`
	Options           CSDNPublishOptions `json:"options"`
	ConfirmationToken string             `json:"confirmation_token"`
	Job               *Job               `json:"job,omitempty"`
}

func (s *Store) csdnPublishSource(ctx context.Context, tx pgx.Tx, parent *record, now time.Time) (csdnPublishPreview, string, error) {
	if parent.Kind != "save_draft" || parent.Platform != "csdn" || parent.AccountID != "csdn-main" ||
		!csdnUsername.MatchString(parent.AccountUsername) || parent.Status != "succeeded" || parent.Outcome != "draft_saved" ||
		!parent.ExternalStarted || parent.CancelRequested || parent.ManualResolved || !numericID.MatchString(parent.RemoteID) ||
		parent.IntegrationDistributionID == "" {
		return csdnPublishPreview{}, "", ErrConflict
	}
	if err := s.integrationGuardAllowed(ctx, tx, parent, now); err != nil {
		return csdnPublishPreview{}, "", ErrConflict
	}
	d, err := integrationReadDistribution(ctx, tx, parent.IntegrationDistributionID)
	if err != nil {
		return csdnPublishPreview{}, "", err
	}
	p, err := integrationReadPreparation(ctx, tx, d.PreparationID, false)
	if err != nil {
		return csdnPublishPreview{}, "", err
	}
	index := slices.Index(d.JobIDs, parent.ID)
	if index < 0 || index >= len(p.Drafts) || !p.Confirmed ||
		d.ConfirmationFingerprint == "" || p.ConfirmationFingerprint != d.ConfirmationFingerprint ||
		integrationConfirmation(p) != d.ConfirmationFingerprint {
		return csdnPublishPreview{}, "", ErrConflict
	}
	draft := p.Drafts[index]
	if draft.PublishOptions == nil || draft.Title != parent.Title || draft.Markdown != parent.Markdown ||
		draft.Platform != parent.Platform || draft.AccountID != parent.AccountID || draft.Operation != parent.Kind {
		return csdnPublishPreview{}, "", ErrConflict
	}
	options, err := normalizeCSDNPublishOptions(*draft.PublishOptions, "")
	if err != nil || integrationDigest(options) != integrationDigest(draft.PublishOptions) ||
		len(utf16.Encode([]rune(options.Summary))) > csdnSummaryLimit ||
		(options.ArticleType != "original" && (!options.RightsConfirmed || options.OriginalURL == "")) ||
		(options.ArticleType == "repost" && options.Visibility == "vip") {
		return csdnPublishPreview{}, "", errCSDNPublishOptions
	}
	if len(options.Tags) == 0 || len(options.Tags) > csdnTagLimit {
		return csdnPublishPreview{}, "", errCSDNPublishTags
	}
	markdown := parent.Markdown
	if len(parent.ImageURLs) > 0 {
		if parent.PlatformMarkdown == "" || !convertedImageMarkdown(parent.Markdown, parent.PlatformMarkdown, parent.ImageURLs) {
			return csdnPublishPreview{}, "", ErrConflict
		}
		markdown = parent.PlatformMarkdown
	}
	if strings.TrimSpace(markdown) == "" {
		return csdnPublishPreview{}, "", ErrConflict
	}
	token := integrationDigest([]any{"postbridge-csdn-publish-v1", parent.ID, parent.RemoteID, parent.AccountID,
		parent.AccountUsername, p.ConfirmationFingerprint, draft.ID, draft.Revision, parent.Title, markdown, options})
	return csdnPublishPreview{
		Title:             parent.Title,
		AccountUsername:   parent.AccountUsername,
		Options:           options,
		ConfirmationToken: token,
	}, markdown, nil
}

func (s *Store) csdnPublish(ctx context.Context, id string, token *string) (csdnPublishPreview, error) {
	if !validKey(id) {
		return csdnPublishPreview{}, ErrNotFound
	}
	if token != nil && len(*token) != 64 {
		return csdnPublishPreview{}, ErrInvalid
	}
	var out csdnPublishPreview
	err := s.locked(ctx, func(tx pgx.Tx, now time.Time) error {
		parent, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		requestID := "publish:" + id
		var raw []byte
		err = tx.QueryRow(ctx, "SELECT record FROM jobs WHERE request_id=$1", requestID).Scan(&raw)
		if err == nil {
			var existing record
			if err := json.Unmarshal(raw, &existing); err != nil {
				return err
			}
			if existing.Kind != "publish" || existing.PublishFromJobID != id || existing.PublishOptions == nil || existing.PublishConfirmation == "" {
				return ErrConflict
			}
			if token != nil && !samePublishConfirmation(*token, existing.PublishConfirmation) {
				return ErrConflict
			}
			out = csdnPublishPreview{Title: existing.Title, AccountUsername: existing.AccountUsername, Options: *existing.PublishOptions,
				ConfirmationToken: existing.PublishConfirmation, Job: &existing.Job}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var markdown string
		out, markdown, err = s.csdnPublishSource(ctx, tx, parent, now)
		if err != nil {
			return err
		}
		if token != nil {
			if !samePublishConfirmation(*token, out.ConfirmationToken) {
				return ErrConflict
			}
			job := newRecord(CreateInput{RequestID: requestID, Platform: "csdn", Kind: "publish", Title: out.Title, Markdown: markdown}, now)
			job.AccountUsername = parent.AccountUsername
			job.RemoteID, job.RemoteURL = parent.RemoteID, parent.RemoteURL
			job.PublishFromJobID, job.PublishOptions = parent.ID, &out.Options
			job.PublishConfirmation = out.ConfirmationToken
			exists, err := remoteIDInUse(ctx, tx, job, job.RemoteID)
			if err != nil {
				return err
			}
			if exists {
				return ErrConflict
			}
			raw, err = json.Marshal(job)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO jobs(id,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5)",
				job.ID, job.RequestID, job.PublishConfirmation, raw, now); err != nil {
				return err
			}
			if err = appendLog(ctx, tx, job, "info", "管理员已确认正式发布", now); err != nil {
				return err
			}
			out.Job = &job.Job
		}
		return nil
	})
	return out, err
}

func samePublishConfirmation(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (h *handler) csdnPublishRoutes() {
	const path = "/api/jobs/{id}/publish"
	h.mux.HandleFunc("GET "+path, h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		preview, err := h.store.csdnPublish(r.Context(), r.PathValue("id"), nil)
		if err != nil {
			replyCSDNPublishError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preview)
	}))
	h.mux.HandleFunc("POST "+path, h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			ConfirmationToken string `json:"confirmation_token"`
		}
		if !decodeLimit(w, r, &in, 1024) {
			return
		}
		preview, err := h.store.csdnPublish(r.Context(), r.PathValue("id"), &in.ConfirmationToken)
		if err != nil {
			replyCSDNPublishError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, preview.Job)
	}))
}

func replyCSDNPublishError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCSDNPublishTags):
		fail(w, http.StatusUnprocessableEntity, "publish_tags_invalid", "正式发布需要 1 至 7 个标签")
	case errors.Is(err, errCSDNPublishOptions):
		fail(w, http.StatusUnprocessableEntity, "publish_options_invalid", "请检查文章类型、原文授权、摘要长度和可见范围")
	default:
		replyError(w, err)
	}
}

func (r *record) publishProgress(in ProgressInput, now time.Time, rank int) error {
	if rank < stages[r.Stage] || !numericID.MatchString(r.RemoteID) ||
		(in.RemoteID != "" && in.RemoteID != r.RemoteID) || in.PlatformMarkdown != "" || in.Observation != nil {
		return ErrConflict
	}
	if in.Stage == "saving" {
		if !in.ExternalStarted || r.ExternalStarted || in.RemoteID != r.RemoteID || !publishHTMLSHA256.MatchString(in.PublishedHTMLSHA256) {
			return ErrConflict
		}
		r.ExternalStarted = true
		r.PublishedHTMLSHA256 = in.PublishedHTMLSHA256
		r.Outcome = "unknown"
	} else if in.ExternalStarted || in.PublishedHTMLSHA256 != "" || rank > stages["saving"] && !r.ExternalStarted {
		return ErrConflict
	}
	r.Stage, r.UpdatedAt = in.Stage, now
	return nil
}

func (r *record) unresolvedResult() bool {
	return r.Outcome == "unknown" || r.Outcome == "submitted"
}

func remoteIDInUse(ctx context.Context, tx pgx.Tx, r *record, remoteID string) (bool, error) {
	var exists bool
	var parentID string
	if r.Kind == "publish" {
		parentID = r.PublishFromJobID
	}
	err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE id<>$1 AND id<>$2 AND record->>'remote_id'=$3)",
		r.ID, parentID, remoteID).Scan(&exists)
	return exists, err
}

func sourceGuardedJob(r *record) bool {
	return r.IntegrationDistributionID != "" || r.Kind == "publish"
}

func (s *Store) jobSourceGuardAllowed(ctx context.Context, tx pgx.Tx, r *record, now time.Time) error {
	if r.Kind != "publish" {
		return s.integrationGuardAllowed(ctx, tx, r, now)
	}
	if r.SourceGuardBlocked || r.PublishFromJobID == "" || r.PublishOptions == nil {
		return ErrIntegrationPermission
	}
	parent, err := load(ctx, tx, r.PublishFromJobID)
	if err != nil {
		return err
	}
	preview, markdown, err := s.csdnPublishSource(ctx, tx, parent, now)
	if err != nil {
		return err
	}
	if !samePublishConfirmation(r.PublishConfirmation, preview.ConfirmationToken) ||
		r.RemoteID != parent.RemoteID || r.AccountID != parent.AccountID || r.AccountUsername != parent.AccountUsername ||
		r.Platform != parent.Platform || r.Title != preview.Title || r.Markdown != markdown ||
		integrationDigest(r.PublishOptions) != integrationDigest(preview.Options) {
		return ErrIntegrationPermission
	}
	return nil
}
