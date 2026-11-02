package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestReopenAndModes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	ctx := context.Background()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateAttempt(ctx, "url-shortener", "mock")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddFeedback(ctx, a.ID, 7, json.RawMessage(`{"overallScore":7}`)); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Reopening runs the migrations again; they must be idempotent.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.GetAttempt(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != "mock" || got.BestScore == nil || *got.BestScore != 7 {
		t.Fatalf("unexpected attempt: %+v", got)
	}
	all, err := s.AllFeedback(ctx)
	if err != nil || len(all) != 1 || all[0].QuestionID != "url-shortener" {
		t.Fatalf("AllFeedback = %+v, %v", all, err)
	}
}
