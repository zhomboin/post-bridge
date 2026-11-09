package bridge

import (
	"net/url"
	"strings"
	"time"
)

type NoteProfile struct {
	Nickname          string `json:"nickname"`
	AvatarURL         string `json:"avatar_url"`
	Description       string `json:"description"`
	Following         *int64 `json:"following"`
	Followers         *int64 `json:"followers"`
	LikedAndCollected *int64 `json:"liked_and_collected"`
}
type NoteStats struct {
	BeginAt      string `json:"begin_at"`
	EndAt        string `json:"end_at"`
	Published    *int64 `json:"published"`
	Views        *int64 `json:"views"`
	Likes        *int64 `json:"likes"`
	Comments     *int64 `json:"comments"`
	Favorites    *int64 `json:"favorites"`
	Shares       *int64 `json:"shares"`
	Exposures    *int64 `json:"exposures"`
	NetFollowers *int64 `json:"net_followers"`
}
type NoteTrend struct {
	Date      string `json:"date"`
	Views     *int64 `json:"views"`
	Likes     *int64 `json:"likes"`
	Comments  *int64 `json:"comments"`
	Favorites *int64 `json:"favorites"`
	Exposures *int64 `json:"exposures"`
	Followers *int64 `json:"followers"`
}

func safeNoteImage(value string) bool {
	if value == "" {
		return true
	}
	u, err := url.Parse(value)
	return err == nil && len(value) <= 4096 && !strings.ContainsAny(value, "\\\r\n\t ") && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" && (u.Hostname() == "img.xiaohongshu.com" || strings.HasSuffix(u.Hostname(), ".xhscdn.com"))
}
func validNoteMedia(n Note) bool {
	if n.Type != "" && n.Type != "image" && n.Type != "video" && n.Type != "unknown" {
		return false
	}
	if n.NoteURL != "" && (n.Status != "published" || n.NoteURL != "https://www.xiaohongshu.com/explore/"+n.ID) {
		return false
	}
	if len(n.CoverURLs) > 50 {
		return false
	}
	for _, v := range n.CoverURLs {
		if !safeNoteImage(v) || v == "" {
			return false
		}
	}
	return true
}
func validateNoteInsights(v *NotesSnapshot) error {
	if p := v.Profile; p != nil {
		if !boundedText(p.Nickname, 1600) || !boundedText(p.Description, 16000) || !safeNoteImage(p.AvatarURL) || !nullableMetrics(p.Following, p.Followers, p.LikedAndCollected) {
			return ErrInvalid
		}
	}
	if s := v.Stats; s != nil {
		begin, e := time.Parse(time.RFC3339, s.BeginAt)
		end, e2 := time.Parse(time.RFC3339, s.EndAt)
		if e != nil || e2 != nil || end.Before(begin) || end.Sub(begin) > 7*24*time.Hour || !nullableMetrics(s.Published, s.Views, s.Likes, s.Comments, s.Favorites, s.Shares, s.Exposures) || !nullableSignedMetrics(s.NetFollowers) {
			return ErrInvalid
		}
	}
	if len(v.Trend) > 31 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, d := range v.Trend {
		if _, e := time.Parse("2006-01-02", d.Date); e != nil || seen[d.Date] || !nullableMetrics(d.Views, d.Likes, d.Comments, d.Favorites, d.Exposures) || !nullableSignedMetrics(d.Followers) {
			return ErrInvalid
		}
		seen[d.Date] = true
	}
	return nil
}
