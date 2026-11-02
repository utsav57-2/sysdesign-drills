// Package api exposes the HTTP JSON API used by the frontend.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"sysdesign-prep/backend/internal/ai"
	"sysdesign-prep/backend/internal/content"
	"sysdesign-prep/backend/internal/store"
)

type Server struct {
	bank  *content.Bank
	store *store.Store
	ai    *ai.Client
}

func New(bank *content.Bank, st *store.Store, aiClient *ai.Client) *Server {
	return &Server{bank: bank, store: st, ai: aiClient}
}

// Handler returns the API routes, plus the built frontend at staticDir if it exists.
func (s *Server) Handler(staticDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("GET /api/questions", s.questions)
	mux.HandleFunc("GET /api/questions/{id}/solution", s.solution)
	mux.HandleFunc("GET /api/concepts", s.concepts)
	mux.HandleFunc("GET /api/concepts/{id}", s.conceptPage)
	mux.HandleFunc("GET /api/feedback", s.allFeedback)
	mux.HandleFunc("GET /api/progress", s.progress)
	mux.HandleFunc("GET /api/attempts", s.listAttempts)
	mux.HandleFunc("POST /api/attempts", s.createAttempt)
	mux.HandleFunc("GET /api/attempts/{id}", s.getAttempt)
	mux.HandleFunc("PATCH /api/attempts/{id}", s.updateAttempt)
	mux.HandleFunc("DELETE /api/attempts/{id}", s.deleteAttempt)
	mux.HandleFunc("GET /api/attempts/{id}/feedback", s.listFeedback)
	mux.HandleFunc("POST /api/attempts/{id}/feedback", s.createFeedback)
	mux.HandleFunc("GET /api/attempts/{id}/messages", s.listMessages)
	mux.HandleFunc("POST /api/attempts/{id}/messages", s.sendMessage)

	if staticDir != "" {
		if _, err := os.Stat(filepath.Join(staticDir, "index.html")); err == nil {
			mux.Handle("/", spa(staticDir))
		}
	}
	return logRequests(mux)
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"aiConfigured": ai.Configured(),
		"model":        s.ai.Model(),
	})
}

func (s *Server) questions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"categories": s.bank.Categories,
		"questions":  s.bank.Questions,
	})
}

func (s *Server) solution(w http.ResponseWriter, r *http.Request) {
	md, ok := s.bank.Solution(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "no reference solution for this question yet")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"markdown": md})
}

func (s *Server) conceptPage(w http.ResponseWriter, r *http.Request) {
	md, ok := s.bank.Explainer(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "no explainer for this concept yet")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"markdown": md})
}

// allFeedback returns every report with its question, newest first, for trend and weak-area views.
func (s *Server) allFeedback(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.AllFeedback(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) concepts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"groups":   s.bank.ConceptGroups,
		"concepts": s.bank.Concepts,
	})
}

func (s *Server) progress(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.Progress(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) listAttempts(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListAttempts(r.Context(), r.URL.Query().Get("questionId"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) createAttempt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		QuestionID string `json:"questionId"`
		Mode       string `json:"mode"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Mode == "" {
		body.Mode = ai.ModePractice
	}
	if body.Mode != ai.ModePractice && body.Mode != ai.ModeMock {
		writeError(w, http.StatusBadRequest, "mode must be practice or mock")
		return
	}
	if _, ok := s.bank.Question(body.QuestionID); !ok {
		writeError(w, http.StatusBadRequest, "unknown questionId")
		return
	}
	a, err := s.store.CreateAttempt(r.Context(), body.QuestionID, body.Mode)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

func (s *Server) getAttempt(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	a, err := s.store.GetAttempt(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) updateAttempt(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var u store.AttemptUpdate
	if !readJSON(w, r, &u) {
		return
	}
	if u.Status != nil && *u.Status != "in_progress" && *u.Status != "completed" {
		writeError(w, http.StatusBadRequest, "status must be in_progress or completed")
		return
	}
	a, err := s.store.UpdateAttempt(r.Context(), id, u)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) deleteAttempt(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteAttempt(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listFeedback(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	list, err := s.store.ListFeedback(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) createFeedback(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		DiagramPNG string `json:"diagramPng"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	a, q, ok := s.attemptAndQuestion(w, r, id)
	if !ok {
		return
	}
	solution, _ := s.bank.Solution(q.ID)
	report, score, err := s.ai.Feedback(r.Context(), q, solution, s.bank.ConceptIDs(), a.Answers, body.DiagramPNG)
	if err != nil {
		log.Printf("feedback attempt %d: %v", id, err)
		writeError(w, http.StatusBadGateway, ai.Describe(err))
		return
	}
	fb, err := s.store.AddFeedback(r.Context(), id, score, report)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, fb)
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	list, err := s.store.ListMessages(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// sendMessage streams the interviewer's reply as server-sent events:
// "delta" {text}, then "done" {user, assistant} or "error" {error}.
// Both turns are stored only after the reply succeeds, so history stays valid.
func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Text       string `json:"text"`
		DiagramPNG string `json:"diagramPng"`
		Stage      string `json:"stage"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Text == "" {
		writeError(w, http.StatusBadRequest, "text is required")
		return
	}
	a, q, ok := s.attemptAndQuestion(w, r, id)
	if !ok {
		return
	}
	stored, err := s.store.ListMessages(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	history, err := ai.DecodeHistory(stored)
	if err != nil {
		writeErr(w, err)
		return
	}
	userTurn := ai.UserTurn(a.Answers, body.DiagramPNG, body.Text, body.Stage, a.ElapsedSeconds)
	history = append(history, userTurn)

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	send := func(event string, data any) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		if flusher != nil {
			flusher.Flush()
		}
	}

	reply, assistantTurn, err := s.ai.Chat(r.Context(), q, a.Mode, history, func(t string) {
		send("delta", map[string]string{"text": t})
	})
	if err != nil {
		log.Printf("chat attempt %d: %v", id, err)
		send("error", map[string]string{"error": ai.Describe(err)})
		return
	}

	userRaw, _ := json.Marshal(userTurn)
	asstRaw, _ := json.Marshal(assistantTurn)
	um, err := s.store.AddMessage(r.Context(), id, "user", body.Text, string(userRaw))
	if err == nil {
		var am *store.Message
		if am, err = s.store.AddMessage(r.Context(), id, "assistant", reply, string(asstRaw)); err == nil {
			send("done", map[string]any{"user": um, "assistant": am})
			return
		}
	}
	send("error", map[string]string{"error": "saving chat: " + err.Error()})
}

func (s *Server) attemptAndQuestion(w http.ResponseWriter, r *http.Request, id int64) (*store.Attempt, *content.Question, bool) {
	a, err := s.store.GetAttempt(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return nil, nil, false
	}
	q, ok := s.bank.Question(a.QuestionID)
	if !ok {
		writeError(w, http.StatusNotFound, "question no longer exists")
		return nil, nil, false
	}
	return a, q, true
}

// ---- helpers ----

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return id, true
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20) // diagrams can be a few MB
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	log.Printf("internal error: %v", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

// spa serves files from dir, falling back to index.html for client-side routes.
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(filepath.Join(dir, filepath.Clean(r.URL.Path))); err != nil {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		files.ServeHTTP(w, r)
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api" {
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		next.ServeHTTP(w, r)
	})
}
