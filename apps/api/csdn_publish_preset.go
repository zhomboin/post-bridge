package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	csdnSummaryLimit  = 256
	csdnCategoryLimit = 3
)

type CSDNPublishOptions struct {
	Tags                []string `json:"tags"`
	Summary             string   `json:"summary"`
	Categories          []string `json:"categories"`
	ArticleType         string   `json:"article_type"`
	CreationDeclaration string   `json:"creation_declaration"`
	Visibility          string   `json:"visibility"`
	Template            string   `json:"template"`
	CoverImageURL       string   `json:"cover_image_url"`
}

type csdnPublishPreset struct {
	Revision            int64              `json:"revision"`
	Options             CSDNPublishOptions `json:"options"`
	AvailableCategories []string           `json:"available_categories"`
}

type csdnPresetQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func defaultCSDNPublishOptions() CSDNPublishOptions {
	return CSDNPublishOptions{
		Tags: []string{}, Categories: []string{}, ArticleType: "original",
		CreationDeclaration: "none", Visibility: "public", Template: "default",
	}
}

func normalizeCSDNOptionLabels(values []string, maxLength int) ([]string, error) {
	if len(values) > 20 {
		return nil, ErrInvalid
	}
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if !utf8.ValidString(value) || strings.ContainsRune(value, 0) || utf8.RuneCountInString(value) > maxLength {
			return nil, ErrInvalid
		}
		if value != "" && !slices.Contains(normalized, value) {
			normalized = append(normalized, value)
		}
	}
	return normalized, nil
}

func normalizeCSDNPublishOptions(options CSDNPublishOptions, coverCandidate string) (CSDNPublishOptions, error) {
	options.Summary = strings.TrimSpace(options.Summary)
	if !utf8.ValidString(options.Summary) || strings.ContainsRune(options.Summary, 0) ||
		utf8.RuneCountInString(options.Summary) > csdnSummaryLimit ||
		(options.CoverImageURL != "" && options.CoverImageURL != coverCandidate) ||
		!slices.Contains([]string{"original", "repost", "translated"}, options.ArticleType) ||
		!slices.Contains([]string{"none", "ai_assisted", "online_recreation", "personal_opinion"}, options.CreationDeclaration) ||
		!slices.Contains([]string{"public", "private", "fans", "vip"}, options.Visibility) ||
		!slices.Contains([]string{"default", "simple", "moyan"}, options.Template) {
		return CSDNPublishOptions{}, ErrInvalid
	}
	var err error
	options.Tags, err = normalizeCSDNOptionLabels(options.Tags, 64)
	if err != nil {
		return CSDNPublishOptions{}, err
	}
	options.Categories, err = normalizeCSDNOptionLabels(options.Categories, 1000)
	if err != nil || len(options.Categories) > csdnCategoryLimit {
		return CSDNPublishOptions{}, ErrInvalid
	}
	return options, nil
}

func csdnOptionsFromSnapshot(options CSDNPublishOptions, snapshot IntegrationSnapshot) CSDNPublishOptions {
	// Snapshot tags have already passed the source contract checks.
	if len(snapshot.Tags) > 0 {
		options.Tags, _ = normalizeCSDNOptionLabels(snapshot.Tags, 64)
	}
	summary := []rune(strings.TrimSpace(snapshot.Summary))
	if len(summary) > csdnSummaryLimit {
		summary = summary[:csdnSummaryLimit]
	}
	options.Summary = string(summary)
	return options
}

func readCSDNPublishPreset(ctx context.Context, db csdnPresetQuery, accountID string) (csdnPublishPreset, error) {
	preset := csdnPublishPreset{Options: defaultCSDNPublishOptions()}
	var record []byte
	err := db.QueryRow(ctx, `SELECT COALESCE(p.revision, 0), p.options FROM account a
		LEFT JOIN csdn_publish_presets p ON p.account_id=a.id AND p.account_username=a.username WHERE a.id=$1`,
		accountID).Scan(&preset.Revision, &record)
	if errors.Is(err, pgx.ErrNoRows) {
		return preset, ErrNotFound
	}
	if err == nil && record != nil {
		err = json.Unmarshal(record, &preset.Options)
	}
	return preset, err
}

func availableCSDNCategories(ctx context.Context, db csdnPresetQuery, accountID string, saved []string) ([]string, error) {
	var known []string
	err := db.QueryRow(ctx, `SELECT ARRAY(
		SELECT DISTINCT btrim(category) FROM account_article_bodies b
		JOIN account a ON b.account_id=a.id AND b.username=a.username
		CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(b.record->'categories', '[]'::jsonb)) AS category
		WHERE a.id=$1 AND btrim(category) <> '' ORDER BY 1 LIMIT 200)`, accountID).Scan(&known)
	if err != nil {
		return nil, err
	}
	// Account sync replaces the article body cache. Retain previously selected names.
	for _, name := range saved {
		if !slices.Contains(known, name) {
			known = append(known, name)
		}
	}
	slices.Sort(known)
	return known, nil
}

func validateCSDNCategorySelection(selected, available []string) error {
	for _, name := range selected {
		if !slices.Contains(available, name) {
			return ErrInvalid
		}
	}
	return nil
}

func (s *Store) csdnDraftPublishOptions(ctx context.Context, db csdnPresetQuery, accountID string, snapshot IntegrationSnapshot) (CSDNPublishOptions, error) {
	preset, err := readCSDNPublishPreset(ctx, db, accountID)
	if err != nil {
		return CSDNPublishOptions{}, err
	}
	return csdnOptionsFromSnapshot(preset.Options, snapshot), nil
}

func (s *Store) validateCSDNDraftCategories(ctx context.Context, db csdnPresetQuery, accountID string, previous, selected []string) error {
	if len(selected) == 0 || validateCSDNCategorySelection(selected, previous) == nil {
		return nil
	}
	preset, err := readCSDNPublishPreset(ctx, db, accountID)
	if err != nil {
		return err
	}
	available, err := availableCSDNCategories(ctx, db, accountID, append(slices.Clone(previous), preset.Options.Categories...))
	if err != nil {
		return err
	}
	return validateCSDNCategorySelection(selected, available)
}

func (s *Store) saveCSDNPublishPreset(ctx context.Context, revision int64, options CSDNPublishOptions) (csdnPublishPreset, error) {
	options, err := normalizeCSDNPublishOptions(options, "")
	if err != nil || options.Summary != "" {
		return csdnPublishPreset{}, ErrInvalid
	}
	const accountID = "csdn-main"
	var result csdnPublishPreset
	err = s.locked(ctx, func(tx pgx.Tx, _ time.Time) error {
		current, err := readCSDNPublishPreset(ctx, tx, accountID)
		if err != nil {
			return err
		}
		if current.Revision != revision {
			return ErrConflict
		}
		available, err := availableCSDNCategories(ctx, tx, accountID, current.Options.Categories)
		if err != nil {
			return err
		}
		if err := validateCSDNCategorySelection(options.Categories, available); err != nil {
			return err
		}
		result = csdnPublishPreset{Revision: revision + 1, Options: options, AvailableCategories: available}
		_, err = tx.Exec(ctx, `INSERT INTO csdn_publish_presets(account_id,account_username,revision,options)
			SELECT id,username,$2,$3 FROM account WHERE id=$1
			ON CONFLICT (account_id) DO UPDATE SET account_username=EXCLUDED.account_username,
				revision=EXCLUDED.revision, options=EXCLUDED.options`, accountID, result.Revision, options)
		return err
	})
	return result, err
}

func (h *handler) csdnPublishPresetRoutes() {
	const path = "/api/account/csdn-publish-preset"
	h.mux.HandleFunc("GET "+path, h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		const accountID = "csdn-main"
		ctx := r.Context()
		preset, err := readCSDNPublishPreset(ctx, h.store.pool, accountID)
		if err == nil {
			preset.AvailableCategories, err = availableCSDNCategories(ctx, h.store.pool, accountID, preset.Options.Categories)
		}
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preset)
	}))
	h.mux.HandleFunc("PUT "+path, h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision *int64              `json:"revision"`
			Options  *CSDNPublishOptions `json:"options"`
		}
		if !decodeLimit(w, r, &in, 32<<10) {
			return
		}
		if in.Revision == nil || *in.Revision < 0 || in.Options == nil {
			replyError(w, ErrInvalid)
			return
		}
		preset, err := h.store.saveCSDNPublishPreset(r.Context(), *in.Revision, *in.Options)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, preset)
	}))
}
