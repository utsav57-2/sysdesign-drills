# Design Drills

A local system design interview practice app: 47 common interview questions, a staged workspace
with a whiteboard, an AI interviewer (self-paced or a timed mock interview), scored feedback on each
attempt, worked solutions for the 11 most-asked questions, and tracking of the concepts you keep missing.

## Run it

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # optional; needed for the interviewer and feedback
./run.sh                               # builds everything, serves http://127.0.0.1:8787
```

Without an API key you can still practice, draw, and save attempts.

Options (pass to `./run.sh` or `backend/bin/server`): `-addr`, `-db` (SQLite file, default
`backend/sysdesign.db`), `-data`, `-static`. Set `SDP_MODEL` to use a different Claude model
(default `claude-opus-5-5`).

### Frontend development

```sh
cd backend && go run .          # API on :8787
cd frontend && npm run dev      # Vite on :5173, proxies /api to :8787
```

## Layout

- `data/` — `questions.json` (question bank), `concepts.json` (glossary), and `solutions/<question-id>.md`
  (worked solutions; one `## ` heading per stage: Requirements, Core entities, API, High-level design,
  Deep dives). Drop in a new solution file and restart to add one; the grader uses it as its answer key.
- `backend/` — Go: `net/http` API, SQLite via `modernc.org/sqlite` (no cgo), Claude via `anthropic-sdk-go`.
  - `internal/content` loads the JSON bank
  - `internal/store` attempts, feedback, chat history
  - `internal/ai` interviewer chat (streamed over SSE) and grading (structured JSON output)
  - `internal/api` HTTP routes
- `frontend/` — React + Vite + TypeScript, Excalidraw for the whiteboard.

## How a practice session works

1. Pick a question and start either a **mock interview** (the interviewer leads, keeps time, and moves
   you between stages) or a **self-paced** practice attempt. The clock starts (target ~37 min).
2. Work through the five stages: requirements, core entities, API, high-level design (whiteboard +
   notes), deep dives. Everything autosaves.
3. Talk to the interviewer at any time. Each message includes your current notes, plus the
   whiteboard when it has changed.
4. Press **Get feedback** for a 1–10 score per stage, strengths, gaps, and what to study next.
5. Compare against the worked solution (unlocks once you finish or get feedback). The History page
   shows the concepts you miss most and your average score per stage.
