package bridge

import (
	"context"
	_ "embed"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed content_platforms.json
var contentPlatformsJSON []byte

// 平台只提供差异；权限、事务、任务与存储由公共服务处理。
type contentAdapter struct {
	ContentPlatform
	idRule           *regexp.Regexp
	usernameRule     *regexp.Regexp
	userIDRule       *regexp.Regexp
	ValidateItem     func(ContentItem) error
	ValidateBody     func(ContentBody) error
	ValidateSnapshot func(ContentSnapshot) error
	MediaAllowed     func(string) bool
	AcceptLegacy     func(context.Context, pgx.Tx, *record, CompleteInput, time.Time) error
	ProjectLegacy    func(context.Context, pgx.Tx, *record, CompleteInput, time.Time) error
	Backfill         func(context.Context, pgx.Tx, string) error
}

type contentRegistry struct{ adapters map[string]contentAdapter }

func newContentRegistry(adapters ...contentAdapter) *contentRegistry {
	r := &contentRegistry{adapters: map[string]contentAdapter{}}
	for _, a := range adapters {
		if !validKey(a.ID) || r.adapters[a.ID].ID != "" || a.SyncJob == "" || a.ReadJob == "" {
			panic("内容平台注册无效或重复")
		}
		for _, pattern := range []string{a.IDPattern, a.UsernamePattern, a.UserIDPattern} {
			if !strings.HasPrefix(pattern, "^") || !strings.HasSuffix(pattern, "$") {
				panic("平台标识规则必须完整匹配")
			}
			regexp.MustCompile(pattern)
		}
		a.idRule = regexp.MustCompile(a.IDPattern)
		a.usernameRule = regexp.MustCompile(a.UsernamePattern)
		a.userIDRule = regexp.MustCompile(a.UserIDPattern)
		if a.BodyTTLSeconds < 0 {
			panic("正文缓存时效不可为负")
		}
		if a.SyncJob != "sync_contents" && a.SyncJob != "sync_articles" && a.SyncJob != "sync_notes" {
			panic("同步任务类型无效")
		}
		if a.ReadJob != "read_content" && a.ReadJob != "read_article" && a.ReadJob != "read_note" {
			panic("正文任务类型无效")
		}
		r.adapters[a.ID] = a
	}
	return r
}

func contentDefinitions() []ContentPlatform {
	var definitions []ContentPlatform
	if err := json.Unmarshal(contentPlatformsJSON, &definitions); err != nil {
		panic(err)
	}
	return definitions
}

func (s *Store) contentRegistry() *contentRegistry {
	if s.contents != nil {
		return s.contents
	}
	return builtinContentRegistry(s)
}

func builtinContentRegistry(s *Store) *contentRegistry {
	definitions := contentDefinitions()
	adapters := []contentAdapter{}
	for _, d := range definitions {
		a := contentAdapter{ContentPlatform: d}
		switch d.ID {
		case "csdn":
			a.MediaAllowed = safeArticleImageURL
			if s != nil {
				a.AcceptLegacy = s.acceptArticleResult
				a.ProjectLegacy = s.projectArticles
				a.Backfill = s.backfillArticles
			}
		case "xiaohongshu":
			a.MediaAllowed = safeNoteImage
			if s != nil {
				a.AcceptLegacy = s.acceptNotesResult
				a.ProjectLegacy = s.projectNotes
				a.Backfill = s.backfillNotes
			}
		}
		adapters = append(adapters, a)
	}
	return newContentRegistry(adapters...)
}

func (r *contentRegistry) get(platform string) (contentAdapter, error) {
	a, ok := r.adapters[platform]
	if !ok {
		return a, ErrInvalid
	}
	return a, nil
}

func (a contentAdapter) supports(operation string) bool { return a.Capabilities[operation].Enabled }
func (a contentAdapter) validID(id string) bool {
	return boundedText(id, 512) && contentPatternMatches(a.idRule, a.IDPattern, id)
}
func contentPatternMatches(rule *regexp.Regexp, pattern, value string) bool {
	if rule == nil {
		rule = regexp.MustCompile(pattern)
	}
	return rule.MatchString(value)
}
func (a contentAdapter) validUsername(username string) bool {
	return boundedText(username, 400) && contentPatternMatches(a.usernameRule, a.UsernamePattern, username)
}
func (a contentAdapter) identity(username, userID string) bool {
	return a.validUsername(username) && boundedText(userID, 512) && contentPatternMatches(a.userIDRule, a.UserIDPattern, userID)
}
func (a contentAdapter) canRead(status string) bool {
	return len(a.ReadStatuses) == 0 || slices.Contains(a.ReadStatuses, status)
}

func registeredIdentity(platform, username, userID string) bool {
	a, err := registeredContentPlatforms.get(platform)
	return err == nil && a.identity(username, userID)
}

var registeredContentPlatforms = builtinContentRegistry(nil)
