package bridge

import (
	"encoding/json"
	"net/http"
)

func (h *handler) formattingAssetRoutes() {
	h.mux.HandleFunc("PUT /api/formatting-jobs/{id}/wechat", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		if !h.formattingEnabled(w) {
			return
		}
		var in wechatEditInput
		if !decodeLimit(w, r, &in, 6<<20) {
			return
		}
		out, err := h.editWechat(r.Context(), r.PathValue("id"), in)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 202, out)
	}))
	h.mux.HandleFunc("GET /api/formatting-assets/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var body []byte
		var hash, jobID string
		var revision int64
		err := h.store.pool.QueryRow(r.Context(), "SELECT body,sha256,job_id,revision FROM formatting_assets WHERE id=$1 AND expires_at>$2", r.PathValue("id"), h.store.now()).Scan(&body, &hash, &jobID, &revision)
		if err != nil {
			replyError(w, ErrNotFound)
			return
		}
		if _, err = h.getFormattingJob(r.Context(), jobID); err != nil {
			formattingHTTPError(w, err)
			return
		}
		var raw []byte
		var out FormattingOutput
		err = h.store.pool.QueryRow(r.Context(), "SELECT record FROM formatting_revisions WHERE job_id=$1 AND revision=$2", jobID, revision).Scan(&raw)
		if err != nil || json.Unmarshal(raw, &out) != nil {
			replyError(w, ErrNotFound)
			return
		}
		found := false
		for _, asset := range out.Assets {
			if asset.ID == r.PathValue("id") && asset.Sha256 == hash {
				found = true
			}
		}
		if !found {
			replyError(w, ErrNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "private, no-store")
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", `attachment; filename="post-bridge-card.png"`)
		}
		w.WriteHeader(200)
		_, _ = w.Write(body)
	}))
	h.mux.HandleFunc("PUT /api/formatting-jobs/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		if !h.formattingConfig.Enabled {
			fail(w, 503, "formatting_disabled", "AI 格式化尚未启用。")
			return
		}
		var in struct {
			Revision  int64            `json:"revision"`
			RequestID string           `json:"request_id"`
			Template  string           `json:"template"`
			Output    FormattingOutput `json:"output"`
		}
		if !decode(w, r, &in) {
			return
		}
		out, err := h.editFormattingJob(r.Context(), r.PathValue("id"), in.Revision, in.RequestID, in.Template, in.Output)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 202, out)
	}))
	h.mux.HandleFunc("POST /api/formatting-jobs/{id}/confirm", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision int64 `json:"revision"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		out, err := h.confirmFormatting(r.Context(), r.PathValue("id"), in.Revision)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
}
