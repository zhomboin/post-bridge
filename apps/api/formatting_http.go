package bridge

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func formattingHTTPError(w http.ResponseWriter, err error) {
	var e formattingError
	if errors.As(err, &e) {
		status := 422
		message := "格式化处理未完成，请检查稿件或稍后重试。"
		if e == "input_too_large" {
			message = "原稿超过模型处理范围，请缩小本次内容。"
		}
		if e == "formatting_quota" {
			status = 429
			message = "格式化任务或用量达到上限，请稍后重试。"
		}
		fail(w, status, e.Error(), message)
		return
	}
	if errors.Is(err, ErrFormattingContent) {
		fail(w, 422, "content_invalid", "格式化结果未通过内容校验，请调整后重新生成。")
		return
	}
	integrationContentError(w, err)
}
func (h *handler) formattingEnabled(w http.ResponseWriter) bool {
	if !h.formattingConfig.Enabled {
		fail(w, 503, "formatting_disabled", "AI 格式化尚未启用。")
		return false
	}
	return true
}
func (h *handler) formattingRoutes() {
	h.formattingAssetRoutes()
	h.mux.HandleFunc("GET /api/formatting-jobs", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		rows, err := h.store.pool.Query(r.Context(), "SELECT j.record FROM formatting_jobs j JOIN formatting_sessions s ON s.id=j.session_id WHERE ($3='' OR s.record->>'preparation_id'=$3) AND ($4='' OR j.record->>'platform'=$4) ORDER BY j.created_at DESC,j.id DESC LIMIT $1 OFFSET $2", size, (page-1)*size, r.URL.Query().Get("preparation_id"), r.URL.Query().Get("platform"))
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		defer rows.Close()
		items := []FormattingJob{}
		for rows.Next() {
			var raw []byte
			var j FormattingJob
			if err = rows.Scan(&raw); err != nil {
				break
			}
			if err = json.Unmarshal(raw, &j); err != nil {
				break
			}
			j.Result = nil
			items = append(items, j)
		}
		if err == nil {
			err = rows.Err()
		}
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "page": page, "page_size": size})
	}))
	h.mux.HandleFunc("GET /api/formatting-capabilities", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		writeJSON(w, 200, map[string]any{"enabled": h.formattingConfig.Enabled, "provider": "deepseek", "platforms": []string{"csdn", "xiaohongshu"}, "templates": []string{"technical", "checklist"}, "max_input_characters": h.formattingConfig.MaxInputCharacters})
	}))
	h.mux.HandleFunc("POST /api/formatting-sessions", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		if !h.formattingEnabled(w) {
			return
		}
		var in formattingSessionInput
		if !decode(w, r, &in) {
			return
		}
		out, err := h.createFormattingSession(r.Context(), in)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 201, out)
	}))
	h.mux.HandleFunc("GET /api/formatting-sessions/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var out FormattingSession
		err := h.store.locked(r.Context(), func(tx pgx.Tx, _ time.Time) error {
			var err error
			out, err = h.readFormattingSession(r.Context(), tx, r.PathValue("id"), false)
			return err
		})
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("GET /api/formatting-sessions/{id}/jobs", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		items, err := h.listFormattingJobs(r.Context(), r.PathValue("id"))
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}))
	h.mux.HandleFunc("POST /api/formatting-sessions/{id}/jobs", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		if !h.formattingEnabled(w) {
			return
		}
		var in formattingJobInput
		if !decode(w, r, &in) {
			return
		}
		out, created, err := h.createFormattingJob(r.Context(), r.PathValue("id"), in)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		writeJSON(w, status, out)
	}))
	h.mux.HandleFunc("GET /api/formatting-jobs/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		out, err := h.getFormattingJob(r.Context(), r.PathValue("id"))
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("POST /api/formatting-jobs/{id}/cancel", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		out, err := h.cancelFormattingJob(r.Context(), r.PathValue("id"))
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("POST /api/formatting-jobs/{id}/adopt", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision int64 `json:"revision"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		out, prep, err := h.adoptFormatting(r.Context(), r.PathValue("id"), in.Revision)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"job": out, "preparation": prep})
	}))
	h.mux.HandleFunc("POST /api/formatting-jobs/{id}/csdn-draft", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			Revision int64 `json:"revision"`
		}
		if !decodeLimit(w, r, &in, 4096) {
			return
		}
		out, created, err := h.createFormattedCSDNDraft(r.Context(), r.PathValue("id"), in.Revision)
		if err != nil {
			formattingHTTPError(w, err)
			return
		}
		status := 200
		if created {
			status = 202
		}
		writeJSON(w, status, out)
	}))
}
