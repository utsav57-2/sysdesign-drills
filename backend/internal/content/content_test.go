package content

import (
	"strings"
	"testing"
)

func TestLoadRealData(t *testing.T) {
	b, err := Load("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, id := range b.ConceptIDs() {
		known[id] = true
	}
	solved := 0
	for _, q := range b.Questions {
		for _, c := range q.Concepts {
			if !known[c] {
				t.Errorf("%s uses unknown concept %q", q.ID, c)
			}
		}
		if !q.HasSolution {
			continue
		}
		solved++
		md, _ := b.Solution(q.ID)
		for _, h := range []string{"## Requirements", "## Core entities", "## API", "## High-level design", "## Deep dives", "## Follow-up questions", "```mermaid"} {
			if !strings.Contains(md, h) {
				t.Errorf("solution %s missing %q", q.ID, h)
			}
		}
		if _, followUps, ok := strings.Cut(md, "## Follow-up questions"); ok && strings.Count(followUps, "\n### ") < 6 {
			t.Errorf("solution %s has fewer than 6 follow-up questions", q.ID)
		}
	}
	if solved != len(b.Questions) {
		t.Errorf("got %d solutions, want one for each of the %d questions", solved, len(b.Questions))
	}
}

func TestEveryConceptHasExplainer(t *testing.T) {
	b, err := Load("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	headings := []string{"## The problem it solves", "## How it works", "## Worked example", "## Trade-offs",
		"## When to use it (and when not)", "## In an interview", "## Common follow-up questions"}
	for _, c := range b.Concepts {
		md, ok := b.Explainer(c.ID)
		if !ok {
			t.Errorf("concept %s has no explainer", c.ID)
			continue
		}
		if !strings.HasPrefix(md, "# "+c.Name+"\n") {
			t.Errorf("explainer %s should start with %q", c.ID, "# "+c.Name)
		}
		for _, h := range headings {
			if !strings.Contains(md, h) {
				t.Errorf("explainer %s missing %q", c.ID, h)
			}
		}
	}
}
