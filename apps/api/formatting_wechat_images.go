package bridge

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"html"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

type wechatUpload struct {
	ImageID string `json:"image_id"`
	Data    string `json:"data"`
}

func remapWechatUploads(oldImages, newImages []WechatImage, uploads []WechatAttachment) ([]WechatAttachment, error) {
	newIDs := map[string]bool{}
	oldByID := map[string]WechatImage{}
	oldCount, newCount := map[string]int{}, map[string]int{}
	newBySource := map[string]WechatImage{}
	for _, image := range oldImages {
		oldByID[image.ID] = image
		oldCount[image.Source]++
	}
	for _, image := range newImages {
		newIDs[image.ID] = true
		newCount[image.Source]++
		newBySource[image.Source] = image
	}
	result := append([]WechatAttachment(nil), uploads...)
	assigned := map[string]bool{}
	for i := range result {
		if !newIDs[result[i].ImageID] {
			old, exists := oldByID[result[i].ImageID]
			if !exists || old.Source == "" || oldCount[old.Source] != 1 || newCount[old.Source] != 1 {
				return nil, formattingError("wechat_image_changed")
			}
			result[i].ImageID = newBySource[old.Source].ID
		}
		if assigned[result[i].ImageID] {
			return nil, formattingError("wechat_image_changed")
		}
		assigned[result[i].ImageID] = true
	}
	return result, nil
}

func validateWechatUploads(input []wechatUpload) ([]WechatAttachment, error) {
	if len(input) > 20 {
		return nil, formattingError("wechat_invalid_image")
	}
	total := 0
	seen := map[string]bool{}
	result := make([]WechatAttachment, 0, len(input))
	for _, item := range input {
		if item.ImageID == "" || len(item.ImageID) > 80 || seen[item.ImageID] || len(item.Data) > 5600000 {
			return nil, formattingError("wechat_invalid_image")
		}
		seen[item.ImageID] = true
		body, err := base64.StdEncoding.Strict().DecodeString(item.Data)
		total += len(body)
		if err != nil || len(body) == 0 || total > 4<<20 {
			return nil, formattingError("wechat_invalid_image")
		}
		config, kind, err := image.DecodeConfig(bytes.NewReader(body))
		if err != nil || (kind != "png" && kind != "jpeg") || config.Width <= 0 || config.Height <= 0 || config.Width > 4096 || config.Height > 4096 || int64(config.Width)*int64(config.Height) > 12000000 {
			return nil, formattingError("wechat_invalid_image")
		}
		if _, _, err = image.Decode(bytes.NewReader(body)); err != nil {
			return nil, formattingError("wechat_invalid_image")
		}
		digest := sha256.Sum256(body)
		media := "image/" + kind
		result = append(result, WechatAttachment{ImageID: item.ImageID, Sha256: hex.EncodeToString(digest[:]), MediaType: media, Data: base64.StdEncoding.EncodeToString(body)})
	}
	return result, nil
}

func applyWechatUploads(blocks []WechatBlock, images []WechatImage, uploads []WechatAttachment) (map[string]bool, error) {
	imageByID := map[string]WechatImage{}
	for _, image := range images {
		imageByID[image.ID] = image
	}
	replaced := map[string]bool{}
	for _, upload := range uploads {
		image, exists := imageByID[upload.ImageID]
		if !exists {
			return nil, ErrFormattingContent
		}
		for i := range blocks {
			if blocks[i].SourceBlockID != image.SourceBlockID {
				continue
			}
			prefix := `<span data-wechat-image="` + html.EscapeString(upload.ImageID) + `">`
			start := strings.Index(blocks[i].Html, prefix)
			if start < 0 {
				break
			}
			if strings.Count(blocks[i].Html, prefix) != 1 {
				return nil, ErrFormattingContent
			}
			end := strings.Index(blocks[i].Html[start:], "</span>")
			if end < 0 {
				return nil, ErrFormattingContent
			}
			end += start + len("</span>")
			tag := `<img src="data:` + upload.MediaType + `;base64,` + upload.Data + `" alt="` + html.EscapeString(image.Alt) + `">`
			blocks[i].Html = blocks[i].Html[:start] + tag + blocks[i].Html[end:]
			replaced[upload.ImageID] = true
			break
		}
	}
	return replaced, nil
}
