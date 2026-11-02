// Command server runs the system design practice backend.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"

	"sysdesign-prep/backend/internal/ai"
	"sysdesign-prep/backend/internal/api"
	"sysdesign-prep/backend/internal/content"
	"sysdesign-prep/backend/internal/store"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8787", "listen address")
	dataDir := flag.String("data", "../data", "directory containing questions.json and concepts.json")
	dbPath := flag.String("db", "sysdesign.db", "SQLite database path")
	staticDir := flag.String("static", "../frontend/dist", "built frontend to serve (skipped if missing)")
	flag.Parse()

	bank, err := content.Load(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	aiClient := ai.New(os.Getenv("SDP_MODEL"))
	if !ai.Configured() {
		log.Print("warning: no Anthropic credentials found; AI interviewer and feedback will fail until ANTHROPIC_API_KEY is set")
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	srv := api.New(bank, st, aiClient)
	log.Printf("loaded %d questions, %d concepts; model %s; listening on http://%s",
		len(bank.Questions), len(bank.Concepts), aiClient.Model(), ln.Addr())
	log.Fatal(http.Serve(ln, srv.Handler(*staticDir)))
}
