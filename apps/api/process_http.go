package bridge

import (
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func (h *handler) processRoutes() {
	h.mux.HandleFunc("GET /api/processes", h.admin(h.processes))
	h.mux.HandleFunc("GET /api/jobs/{id}/history", h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		items, total, transitions, err := h.store.History(r.Context(), r.PathValue("id"), page, size)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": size, "transitions": transitions})
	}))
	h.mux.HandleFunc("GET /api/jobs/{id}/changes", h.admin(func(w http.ResponseWriter, r *http.Request, _ session) {
		attempt := 0
		if r.URL.Query().Has("attempt") {
			var err error
			raw := r.URL.Query().Get("attempt")
			attempt, err = strconv.Atoi(raw)
			if err != nil || attempt < 1 || attempt > 1000000 {
				replyError(w, ErrInvalid)
				return
			}
		}
		changes, err := h.store.Changes(r.Context(), r.PathValue("id"), attempt)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, changes)
	}))
}
func (h *handler) processes(w http.ResponseWriter, r *http.Request, _ session) {
	page, size, ok := pagination(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	to := h.store.now()
	var err error
	if raw := q.Get("to"); raw != "" {
		to, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return
		}
	}
	from := to.Add(-24 * time.Hour)
	if raw := q.Get("from"); raw != "" {
		from, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			replyError(w, ErrInvalid)
			return
		}
	}
	f := ProcessFilter{Q: q.Get("q"), Status: q.Get("status"), Platform: q.Get("platform"), Kind: q.Get("kind"), JobID: q.Get("job_id"), Level: q.Get("level"), From: from, To: to, Page: page, Size: size}
	if to.Before(from) || to.Sub(from) > 31*24*time.Hour || !utf8.ValidString(f.Q) || strings.ContainsRune(f.Q, 0) || strings.ContainsRune(f.JobID, 0) || utf8.RuneCountInString(f.Q) > 200 || len(f.JobID) > 128 || f.Status != "" && !validStatus(f.Status) || f.Platform != "" && f.Platform != "csdn" || f.Kind != "" && f.Kind != "save_draft" && f.Kind != "check_account" || f.Level != "" && f.Level != "info" && f.Level != "warning" && f.Level != "error" {
		replyError(w, ErrInvalid)
		return
	}
	items, total, err := h.store.Processes(r.Context(), f)
	if err != nil {
		replyError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "page_size": size})
}
