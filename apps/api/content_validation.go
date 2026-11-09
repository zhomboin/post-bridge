package bridge

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"time"
)

var contentStatuses = []string{"published", "draft", "reviewing", "rejected", "recycled", "unknown"}

func validContentExtension(raw json.RawMessage) bool {
	var object map[string]json.RawMessage
	return len(raw) <= 256<<10 && json.Unmarshal(raw, &object) == nil && object != nil
}

func emptyContentExtension(raw json.RawMessage) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(raw, &object) == nil && object != nil && len(object) == 0
}

func (a contentAdapter) validateItem(item ContentItem) error {
	if !a.validID(item.ID) || strings.TrimSpace(item.Title) == "" || !boundedText(item.Title, 8000) || !slices.Contains(contentStatuses, item.Status) || !boundedText(item.PlatformStatus, 100) || !slices.Contains(a.Capabilities["list"].Kinds, item.Kind) || len(item.CoverURLs) > 50 || len(item.Metrics) > 100 || !validContentExtension(item.Extensions) {
		return ErrInvalid
	}
	if item.PostedAt != "" {
		if _, err := time.Parse(time.RFC3339, item.PostedAt); err != nil {
			return ErrInvalid
		}
	}
	for _, image := range item.CoverURLs {
		if a.MediaAllowed == nil || image == "" || !a.MediaAllowed(image) {
			return ErrInvalid
		}
	}
	for name, m := range item.Metrics {
		if !validKey(name) || !boundedText(m.Unit, 100) || m.Value != nil && (math.IsNaN(*m.Value) || math.IsInf(*m.Value, 0) || math.Abs(*m.Value) > 9007199254740991) {
			return ErrInvalid
		}
		if (m.BeginAt == "") != (m.EndAt == "") {
			return ErrInvalid
		}
		if m.BeginAt != "" {
			begin, err := time.Parse(time.RFC3339, m.BeginAt)
			if err != nil {
				return ErrInvalid
			}
			end, err := time.Parse(time.RFC3339, m.EndAt)
			if err != nil || end.Before(begin) {
				return ErrInvalid
			}
		}
	}
	if a.ValidateItem != nil {
		return a.ValidateItem(item)
	}
	if !emptyContentExtension(item.Extensions) || item.Status != "unknown" {
		return ErrInvalid
	}
	return nil
}

func (a contentAdapter) validateSnapshot(v *ContentSnapshot, identity ContentIdentity) error {
	if v == nil || v.Identity != identity || !a.identity(identity.Username, identity.UserID) || v.Scope != "all" || v.Items == nil || len(v.Items) > 2000 || !validContentExtension(v.Extensions) {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, item := range v.Items {
		if seen[item.ID] || a.validateItem(item) != nil {
			return ErrInvalid
		}
		seen[item.ID] = true
	}
	raw, err := json.Marshal(v)
	if err != nil || len(raw) > 6<<20 {
		return ErrInvalid
	}
	// 快照扩展必须由平台实现明确校验；通用平台仅接受空对象。
	if a.ValidateSnapshot != nil {
		return a.ValidateSnapshot(*v)
	}
	if !emptyContentExtension(v.Extensions) {
		return ErrInvalid
	}
	return nil
}

func (a contentAdapter) validateContentBody(v *ContentBody, id string) error {
	if v == nil || v.ID != id || !a.validID(id) || !slices.Contains(a.Capabilities["body"].Formats, v.Format) || !boundedText(v.Text, 2<<20) || !boundedText(v.HTML, 2<<20) || len(v.Images) > 50 || len(v.Tags) > 100 || !validContentExtension(v.Extensions) {
		return ErrInvalid
	}
	for _, image := range v.Images {
		if a.MediaAllowed == nil || image == "" || !a.MediaAllowed(image) {
			return ErrInvalid
		}
	}
	for _, tag := range v.Tags {
		if !boundedText(tag, 1000) {
			return ErrInvalid
		}
	}
	raw, err := json.Marshal(v)
	if err != nil || len(raw) > 2<<20 {
		return ErrInvalid
	}
	if a.ValidateBody != nil {
		return a.ValidateBody(*v)
	}
	if !emptyContentExtension(v.Extensions) {
		return ErrInvalid
	}
	return nil
}
