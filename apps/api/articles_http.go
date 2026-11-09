package bridge

import "net/http"

func (h *handler) articleRoutes() {
	h.mux.HandleFunc("GET /api/account/articles", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		page, size, ok := pagination(w, r)
		if !ok {
			return
		}
		result, err := h.store.Articles(r.Context(), r.URL.Query().Get("q"), r.URL.Query().Get("status"), page, size)
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, result)
	}))
	h.mux.HandleFunc("POST /api/account/articles/sync", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		h.create(w, r, CreateInput{RequestID: in.RequestID, Kind: "sync_articles", Platform: "csdn"})
	}))
	h.mux.HandleFunc("GET /api/account/articles/{id}", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		result, err := h.store.Article(r.Context(), r.PathValue("id"))
		if err != nil {
			replyError(w, err)
			return
		}
		writeJSON(w, 200, result)
	}))
	h.mux.HandleFunc("POST /api/account/articles/{id}/read", h.authenticated(func(w http.ResponseWriter, r *http.Request, _ session) {
		var in struct {
			RequestID string `json:"request_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		h.create(w, r, CreateInput{RequestID: in.RequestID, Kind: "read_article", Platform: "csdn", ArticleID: r.PathValue("id")})
	}))
}
