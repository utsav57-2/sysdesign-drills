package ai

import (
	"encoding/json"
	"strings"
	"testing"

	"sysdesign-prep/backend/internal/store"
)

func TestUserTurnRoundTrip(t *testing.T) {
	turn := UserTurn(store.Answers{Requirements: "users can shorten URLs"}, "data:image/png;base64,iVBORw0KGgo=", "How many users?", "requirements", 125)
	raw, err := json.Marshal(turn)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeHistory([]store.Message{{Raw: string(raw)}})
	if err != nil {
		t.Fatal(err)
	}
	again, _ := json.Marshal(decoded[0])
	if string(raw) != string(again) {
		t.Fatalf("round trip changed message:\n%s\n%s", raw, again)
	}
	for _, want := range []string{`"role":"user"`, `"type":"image"`, `"media_type":"image/png"`, "Candidate: How many users?", `[2:05 elapsed, candidate is on the \"requirements\" stage]`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("missing %s in %s", want, raw)
		}
	}
}

func TestBaseParams(t *testing.T) {
	p := New("").baseParams("high")
	raw, _ := json.Marshal(p)
	for _, want := range []string{`"fallbacks":"default"`, `"type":"adaptive"`, `"effort":"high"`, `"model":"claude-opus-5-5"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("missing %s in %s", want, raw)
		}
	}
}

func TestFeedbackSchemaConceptEnum(t *testing.T) {
	raw, _ := json.Marshal(feedbackSchema([]string{"caching", "sharding"}))
	if !strings.Contains(string(raw), `"enum":["caching","sharding"]`) {
		t.Errorf("concept enum missing: %s", raw)
	}
}
