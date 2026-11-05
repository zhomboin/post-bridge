package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCSDNPublishOptionsDefaults(t *testing.T) {
	preset := defaultCSDNPublishOptions()
	preset.Tags = []string{"预设"}
	preset.Categories = []string{"我的专栏"}
	options := csdnOptionsFromSnapshot(preset, IntegrationSnapshot{
		Summary: strings.Repeat("文", 257), Tags: []string{"来源", "来源", " 技术 "},
		CoverImageURL: "https://example.invalid/cover.jpg",
	})
	if !reflect.DeepEqual(options.Tags, []string{"来源", "技术"}) ||
		!reflect.DeepEqual(options.Categories, preset.Categories) ||
		utf8.RuneCountInString(options.Summary) != 256 || options.CoverImageURL != "" {
		t.Fatalf("unexpected source defaults: %#v", options)
	}
	if !reflect.DeepEqual(csdnOptionsFromSnapshot(preset, IntegrationSnapshot{}).Tags, preset.Tags) {
		t.Fatal("missing source tags did not use the preset")
	}
}

func TestNormalizeCSDNPublishOptions(t *testing.T) {
	cover := "https://example.invalid/cover.jpg"
	options := defaultCSDNPublishOptions()
	options.Summary = strings.Repeat("文", 256)
	options.CoverImageURL = cover
	options.ArticleType = "translated"
	options.CreationDeclaration = "online_recreation"
	options.Visibility = "fans"
	options.Template = "moyan"
	if got, err := normalizeCSDNPublishOptions(options, cover); err != nil || !reflect.DeepEqual(options, got) {
		t.Fatalf("valid options rejected: %#v %v", got, err)
	}
	for name, edit := range map[string]func(*CSDNPublishOptions){
		"long summary":        func(o *CSDNPublishOptions) { o.Summary += "文" },
		"too many categories": func(o *CSDNPublishOptions) { o.Categories = []string{"甲", "乙", "丙", "丁"} },
		"unknown visibility":  func(o *CSDNPublishOptions) { o.Visibility = "unlisted" },
		"unknown template":    func(o *CSDNPublishOptions) { o.Template = "unsupported" },
		"arbitrary cover":     func(o *CSDNPublishOptions) { o.CoverImageURL += "?changed" },
		"invalid tag":         func(o *CSDNPublishOptions) { o.Tags = []string{"tag\x00"} },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := options
			edit(&invalid)
			if _, err := normalizeCSDNPublishOptions(invalid, cover); !errors.Is(err, ErrInvalid) {
				t.Fatalf("expected invalid request, got %v", err)
			}
		})
	}
}

func TestCSDNPublishPresetHTTP(t *testing.T) {
	h, _, call := integrationHTTPFixture(t)
	ctx := context.Background()
	if _, err := h.store.pool.Exec(ctx, `INSERT INTO account_article_bodies(account_id,username,id,record,fetched_at)
		SELECT id,username,'123','{"categories":["我的专栏"]}'::jsonb,now() FROM account WHERE id='csdn-main'`); err != nil {
		t.Fatal(err)
	}
	const path = "/api/account/csdn-publish-preset"
	if got := call(http.MethodGet, path, nil, false); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read returned %d", got.Code)
	}
	got := call(http.MethodGet, path, nil, true)
	var preset csdnPublishPreset
	if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &preset) != nil ||
		preset.Revision != 0 || !reflect.DeepEqual(preset.AvailableCategories, []string{"我的专栏"}) {
		t.Fatalf("bad initial preset: %d %s", got.Code, got.Body.String())
	}
	preset.Options.Tags = []string{"默认标签"}
	preset.Options.Categories = []string{"我的专栏"}
	in := map[string]any{"revision": preset.Revision, "options": preset.Options}
	got = call(http.MethodPut, path, in, true)
	if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &preset) != nil || preset.Revision != 1 {
		t.Fatalf("bad saved preset: %d %s", got.Code, got.Body.String())
	}
	if got := call(http.MethodPut, path, in, true); got.Code != http.StatusConflict {
		t.Fatalf("stale preset write returned %d", got.Code)
	}
	preset.Options.Categories = []string{"不存在"}
	if got := call(http.MethodPut, path, map[string]any{"revision": preset.Revision, "options": preset.Options}, true); got.Code != http.StatusBadRequest {
		t.Fatalf("unrecognized category write returned %d", got.Code)
	}
	snapshot := IntegrationSnapshot{Tags: []string{"单篇标签"}}
	options, err := h.store.csdnDraftPublishOptions(ctx, h.store.pool, "csdn-main", snapshot)
	if err != nil || !reflect.DeepEqual(options.Tags, snapshot.Tags) || !reflect.DeepEqual(options.Categories, []string{"我的专栏"}) {
		t.Fatalf("bad draft defaults: %#v %v", options, err)
	}
}
