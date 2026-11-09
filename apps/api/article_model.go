package bridge

import (
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Article struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Status         string   `json:"status"`
	PlatformStatus string   `json:"platform_status"`
	PostedAt       string   `json:"posted_at"`
	Type           string   `json:"type"`
	Views          int64    `json:"views"`
	Likes          int64    `json:"likes"`
	Comments       int64    `json:"comments"`
	Favorites      int64    `json:"favorites"`
	Exposures      int64    `json:"exposures"`
	GainedFans     *int64   `json:"gained_fans"`
	QualityScore   *float64 `json:"quality_score"`
	IsTop          bool     `json:"is_top"`
	FansOnly       bool     `json:"fans_only"`
	VIPOnly        bool     `json:"vip_only"`
	EditorType     int      `json:"editor_type"`
	CoverURLs      []string `json:"cover_urls"`
	BlogURL        string   `json:"blog_url,omitempty"`
	EditorURL      string   `json:"editor_url,omitempty"`
}
type ArticleProfile struct {
	Nickname         string `json:"nickname"`
	AvatarURL        string `json:"avatar_url"`
	Level            *int64 `json:"level"`
	Points           *int64 `json:"points"`
	OriginalArticles *int64 `json:"original_articles"`
	Followers        *int64 `json:"followers"`
}
type ArticleCounts struct {
	Total     int `json:"total"`
	Published int `json:"published"`
	Draft     int `json:"draft"`
	Rejected  int `json:"rejected"`
	Recycled  int `json:"recycled"`
	Unknown   int `json:"unknown"`
}
type ArticleStats struct {
	Articles           *int64 `json:"articles"`
	Views              *int64 `json:"views"`
	Likes              *int64 `json:"likes"`
	Comments           *int64 `json:"comments"`
	Favorites          *int64 `json:"favorites"`
	Exposures          *int64 `json:"exposures"`
	Followers          *int64 `json:"followers"`
	YesterdayViews     *int64 `json:"yesterday_views"`
	YesterdayFollowers *int64 `json:"yesterday_followers"`
	YesterdayFavorites *int64 `json:"yesterday_favorites"`
}
type ArticleTrend struct {
	Date            string `json:"date"`
	Views           *int64 `json:"views"`
	Comments        *int64 `json:"comments"`
	Favorites       *int64 `json:"favorites"`
	Followers       *int64 `json:"followers"`
	PromotionClicks *int64 `json:"promotion_clicks"`
	OutlinkClicks   *int64 `json:"outlink_clicks"`
}
type ArticleSnapshot struct {
	Username string         `json:"username"`
	Profile  ArticleProfile `json:"profile"`
	Counts   ArticleCounts  `json:"counts"`
	Stats    ArticleStats   `json:"stats"`
	Trend    []ArticleTrend `json:"trend"`
	Items    []Article      `json:"items"`
}
type ArticleSnapshotInfo struct {
	Username string         `json:"username"`
	Profile  ArticleProfile `json:"profile"`
	Counts   ArticleCounts  `json:"counts"`
	Stats    ArticleStats   `json:"stats"`
	Trend    []ArticleTrend `json:"trend"`
	SyncedAt time.Time      `json:"synced_at"`
}
type ArticleBody struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Markdown       string   `json:"markdown"`
	HTML           string   `json:"html"`
	Description    string   `json:"description"`
	Tags           []string `json:"tags"`
	Categories     []string `json:"categories"`
	Type           string   `json:"type"`
	Visibility     string   `json:"visibility"`
	PlatformStatus string   `json:"platform_status"`
	Reason         string   `json:"reason"`
}
type ArticlePage struct {
	Items    []Article            `json:"items"`
	Total    int                  `json:"total"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"page_size"`
	Snapshot *ArticleSnapshotInfo `json:"snapshot"`
	SyncJob  *Job                 `json:"sync_job"`
}
type ArticleDetail struct {
	Article   Article      `json:"article"`
	Body      *ArticleBody `json:"body"`
	FetchedAt *time.Time   `json:"fetched_at"`
	ReadJob   *Job         `json:"read_job"`
}

func readKind(kind string) bool {
	return kind == "sync_articles" || kind == "read_article" || kind == "sync_notes" || kind == "read_note"
}
func articleStatus(raw string) string {
	switch raw {
	case "1":
		return "published"
	case "2":
		return "draft"
	case "6":
		return "rejected"
	case "32":
		return "recycled"
	}
	return "unknown"
}
func validArticleStatus(value string) bool {
	return value == "published" || value == "draft" || value == "rejected" || value == "recycled" || value == "unknown"
}

var rawArticleStatus = regexp.MustCompile(`^[0-9]{1,10}$`)
var csdnUsername = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func boundedText(value string, max int) bool {
	return utf8.ValidString(value) && len(value) <= max && !strings.ContainsRune(value, 0)
}
func validMetric(value int64) bool { return value >= 0 && value <= 9007199254740991 }
func nullableMetrics(values ...*int64) bool {
	for _, v := range values {
		if v != nil && !validMetric(*v) {
			return false
		}
	}
	return true
}
func nullableSignedMetrics(values ...*int64) bool {
	for _, v := range values {
		if v != nil && (*v < -9007199254740991 || *v > 9007199254740991) {
			return false
		}
	}
	return true
}
func safeArticleImageURL(value string) bool {
	if value == "" {
		return true
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || len(value) > 4096 {
		return false
	}
	host := u.Hostname()
	return host == "csdnimg.cn" || strings.HasSuffix(host, ".csdnimg.cn") || host == "csdnimg.com" || strings.HasSuffix(host, ".csdnimg.com")
}
func validateArticles(v *ArticleSnapshot, username string) error {
	if v == nil || v.Username != username || !csdnUsername.MatchString(username) || v.Items == nil || len(v.Items) > 2000 || len(v.Trend) > 366 || !boundedText(v.Profile.Nickname, 800) || !safeArticleImageURL(v.Profile.AvatarURL) || !nullableMetrics(v.Profile.Level, v.Profile.Points, v.Profile.OriginalArticles, v.Profile.Followers) {
		return ErrInvalid
	}
	counts := ArticleCounts{Total: len(v.Items)}
	seen := map[string]bool{}
	for _, a := range v.Items {
		if !numericID.MatchString(a.ID) || seen[a.ID] || strings.TrimSpace(a.Title) == "" || !boundedText(a.Title, 2000) || !rawArticleStatus.MatchString(a.PlatformStatus) || a.Status != articleStatus(a.PlatformStatus) || !validMetric(a.Views) || !validMetric(a.Likes) || !validMetric(a.Comments) || !validMetric(a.Favorites) || !validMetric(a.Exposures) || !nullableMetrics(a.GainedFans) || (a.QualityScore != nil && (math.IsNaN(*a.QualityScore) || math.IsInf(*a.QualityScore, 0) || *a.QualityScore < 0 || *a.QualityScore > 100)) || a.EditorType < 0 || a.EditorType > 100 || len(a.CoverURLs) > 20 || a.BlogURL != "" || a.EditorURL != "" {
			return ErrInvalid
		}
		if a.Type != "original" && a.Type != "repost" && a.Type != "translated" && a.Type != "unknown" {
			return ErrInvalid
		}
		if a.PostedAt != "" {
			if _, err := time.Parse(time.RFC3339, a.PostedAt); err != nil {
				return ErrInvalid
			}
		}
		for _, image := range a.CoverURLs {
			if image == "" || !safeArticleImageURL(image) {
				return ErrInvalid
			}
		}
		seen[a.ID] = true
		switch a.Status {
		case "published":
			counts.Published++
		case "draft":
			counts.Draft++
		case "rejected":
			counts.Rejected++
		case "recycled":
			counts.Recycled++
		default:
			counts.Unknown++
		}
	}
	if counts != v.Counts || !nullableMetrics(v.Stats.Articles, v.Stats.Views, v.Stats.Likes, v.Stats.Comments, v.Stats.Favorites, v.Stats.Exposures, v.Stats.Followers, v.Stats.YesterdayViews) || !nullableSignedMetrics(v.Stats.YesterdayFollowers, v.Stats.YesterdayFavorites) {
		return ErrInvalid
	}
	dates := map[string]bool{}
	for _, d := range v.Trend {
		if _, err := time.Parse("2006-01-02", d.Date); err != nil || dates[d.Date] || !nullableMetrics(d.Views, d.Comments, d.Favorites, d.PromotionClicks, d.OutlinkClicks) || !nullableSignedMetrics(d.Followers) {
			return ErrInvalid
		}
		dates[d.Date] = true
	}
	data, err := json.Marshal(v)
	if err != nil || len(data) > 6<<20 {
		return ErrInvalid
	}
	return nil
}
func validateArticleBody(v *ArticleBody, id string) error {
	if v == nil || v.ID != id || !numericID.MatchString(id) || strings.TrimSpace(v.Title) == "" || !boundedText(v.Title, 2000) || !rawArticleStatus.MatchString(v.PlatformStatus) || !boundedText(v.Markdown, 2<<20) || !boundedText(v.HTML, 2<<20) || !boundedText(v.Description, 20000) || !boundedText(v.Type, 100) || !boundedText(v.Visibility, 100) || !boundedText(v.Reason, 8000) || len(v.Tags) > 100 || len(v.Categories) > 100 {
		return ErrInvalid
	}
	for _, xs := range [][]string{v.Tags, v.Categories} {
		for _, x := range xs {
			if !boundedText(x, 1000) {
				return ErrInvalid
			}
		}
	}
	data, err := json.Marshal(v)
	if err != nil || len(data) > 2<<20 {
		return ErrInvalid
	}
	return nil
}
func articleLinks(a *Article, username string) {
	a.EditorURL = "https://editor.csdn.net/md/?articleId=" + a.ID
	a.BlogURL = ""
	if a.Status == "published" {
		a.BlogURL = "https://blog.csdn.net/" + url.PathEscape(username) + "/article/details/" + a.ID
	}
	if a.CoverURLs == nil {
		a.CoverURLs = []string{}
	}
}
