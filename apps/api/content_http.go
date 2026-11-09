package bridge

import "net/http"

func (h *handler) contentRoutes() {
	h.mux.HandleFunc("GET /api/content-platforms", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		definitions := []ContentPlatform{}
		for _, a := range h.store.contentRegistry().adapters {
			definitions = append(definitions, a.ContentPlatform)
		}
		writeJSON(w, 200, map[string]any{"items": definitions})
	}))
	h.mux.HandleFunc("GET /api/accounts/{account}/contents", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		out, err := h.store.Contents(r.Context(), r.PathValue("account"), r.URL.Query().Get("q"), r.URL.Query().Get("status"), page, size)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	h.mux.HandleFunc("GET /api/accounts/{account}/contents/{id}", h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
		out, err := h.store.Content(r.Context(), r.PathValue("account"), r.PathValue("id"))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	register := func(path, operation string) {
		h.mux.HandleFunc(path, h.platformAccountAdmin(func(w http.ResponseWriter, r *http.Request, _ session) {
			var in struct {
				RequestID string `json:"request_id"`
			}
			if !decodeLimit(w, r, &in, 4096) {
				return
			}
			out, created, err := h.store.CreateContentJob(r.Context(), r.PathValue("account"), operation, r.PathValue("id"), in.RequestID)
			if err != nil {
				replyError(w, err)
				return
			}
			status := 200
			if created {
				status = 202
			}
			writeJSON(w, status, out)
		}))
	}
	register("POST /api/accounts/{account}/contents/sync", "list")
	register("POST /api/accounts/{account}/contents/{id}/read", "body")
}
