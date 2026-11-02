// Package content loads the static question bank and concept glossary.
package content

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Category struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Question struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Category      string   `json:"category"`
	Difficulty    string   `json:"difficulty"`
	Frequency     string   `json:"frequency"`
	Companies     []string `json:"companies"`
	Summary       string   `json:"summary"`
	Functional    []string `json:"functional"`
	NonFunctional []string `json:"nonFunctional"`
	Challenges    []string `json:"challenges"`
	Concepts      []string `json:"concepts"`
	HasSolution   bool     `json:"hasSolution"`
}

type ConceptGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Concept struct {
	ID           string `json:"id"`
	Group        string `json:"group"`
	Name         string `json:"name"`
	Summary      string `json:"summary"`
	HasExplainer bool   `json:"hasExplainer"`
}

type Bank struct {
	Categories    []Category     `json:"categories"`
	Questions     []Question     `json:"questions"`
	ConceptGroups []ConceptGroup `json:"conceptGroups"`
	Concepts      []Concept      `json:"concepts"`

	byID       map[string]*Question
	solutions  map[string]string
	explainers map[string]string
}

// Load reads questions.json and concepts.json from dir.
func Load(dir string) (*Bank, error) {
	var q struct {
		Categories []Category `json:"categories"`
		Questions  []Question `json:"questions"`
	}
	if err := readJSON(filepath.Join(dir, "questions.json"), &q); err != nil {
		return nil, err
	}
	var c struct {
		Groups   []ConceptGroup `json:"groups"`
		Concepts []Concept      `json:"concepts"`
	}
	if err := readJSON(filepath.Join(dir, "concepts.json"), &c); err != nil {
		return nil, err
	}

	b := &Bank{
		Categories:    q.Categories,
		Questions:     q.Questions,
		ConceptGroups: c.Groups,
		Concepts:      c.Concepts,
		byID:          make(map[string]*Question, len(q.Questions)),
	}
	for i := range b.Questions {
		b.byID[b.Questions[i].ID] = &b.Questions[i]
	}
	if err := b.loadSolutions(filepath.Join(dir, "solutions")); err != nil {
		return nil, err
	}
	if err := b.loadExplainers(filepath.Join(dir, "concepts")); err != nil {
		return nil, err
	}
	return b, nil
}

// loadExplainers reads optional concept pages named concepts/<concept-id>.md.
func (b *Bank) loadExplainers(dir string) error {
	idx := make(map[string]*Concept, len(b.Concepts))
	for i := range b.Concepts {
		idx[b.Concepts[i].ID] = &b.Concepts[i]
	}
	b.explainers = map[string]string{}
	return readMarkdownDir(dir, func(id, md string) error {
		c, ok := idx[id]
		if !ok {
			return fmt.Errorf("concept page %s.md has no matching concept", id)
		}
		b.explainers[id] = md
		c.HasExplainer = true
		return nil
	})
}

// Explainer returns the full concept page, if one exists.
func (b *Bank) Explainer(id string) (string, bool) {
	s, ok := b.explainers[id]
	return s, ok
}

// readMarkdownDir calls fn for each <id>.md file in dir; a missing dir is fine.
func readMarkdownDir(dir string, fn func(id, md string) error) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".md")
		if !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		if err := fn(id, string(data)); err != nil {
			return err
		}
	}
	return nil
}

// loadSolutions reads optional reference answers named solutions/<question-id>.md.
func (b *Bank) loadSolutions(dir string) error {
	b.solutions = map[string]string{}
	return readMarkdownDir(dir, func(id, md string) error {
		q, ok := b.byID[id]
		if !ok {
			return fmt.Errorf("solution %s.md has no matching question", id)
		}
		b.solutions[id] = md
		q.HasSolution = true
		return nil
	})
}

// Solution returns the reference answer for a question, if one exists.
func (b *Bank) Solution(id string) (string, bool) {
	s, ok := b.solutions[id]
	return s, ok
}

// ConceptIDs lists every concept ID in glossary order.
func (b *Bank) ConceptIDs() []string {
	ids := make([]string, len(b.Concepts))
	for i, c := range b.Concepts {
		ids[i] = c.ID
	}
	return ids
}

func (b *Bank) Question(id string) (*Question, bool) {
	q, ok := b.byID[id]
	return q, ok
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}
