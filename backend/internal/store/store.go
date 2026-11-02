// Package store persists practice attempts, feedback, and interviewer chat in SQLite.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

const schema = `
CREATE TABLE IF NOT EXISTS attempts (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	question_id     TEXT NOT NULL,
	status          TEXT NOT NULL DEFAULT 'in_progress',
	answers         TEXT NOT NULL DEFAULT '{}',
	whiteboard      TEXT NOT NULL DEFAULT '',
	elapsed_seconds INTEGER NOT NULL DEFAULT 0,
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id);

CREATE TABLE IF NOT EXISTS feedback (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	score      INTEGER NOT NULL,
	report     TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_attempt ON feedback(attempt_id);

CREATE TABLE IF NOT EXISTS messages (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	role       TEXT NOT NULL,
	text       TEXT NOT NULL,
	raw        TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_attempt ON messages(attempt_id);
`

// Answers holds the candidate's notes for each stage of the interview.
type Answers struct {
	Requirements string `json:"requirements"`
	Entities     string `json:"entities"`
	API          string `json:"api"`
	HighLevel    string `json:"highLevel"`
	DeepDives    string `json:"deepDives"`
}

type Attempt struct {
	ID             int64     `json:"id"`
	QuestionID     string    `json:"questionId"`
	Status         string    `json:"status"`
	Mode           string    `json:"mode"`
	Answers        Answers   `json:"answers"`
	Whiteboard     string    `json:"whiteboard"`
	ElapsedSeconds int       `json:"elapsedSeconds"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	BestScore      *int      `json:"bestScore,omitempty"`
}

type Feedback struct {
	ID         int64           `json:"id"`
	AttemptID  int64           `json:"attemptId"`
	QuestionID string          `json:"questionId,omitempty"`
	Score      int             `json:"score"`
	Report     json.RawMessage `json:"report"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// Message is one interviewer chat turn. Raw is the exact API message param,
// replayed unchanged on later turns so thinking blocks stay valid.
type Message struct {
	ID        int64     `json:"id"`
	AttemptID int64     `json:"attemptId"`
	Role      string    `json:"role"`
	Text      string    `json:"text"`
	Raw       string    `json:"-"`
	CreatedAt time.Time `json:"createdAt"`
}

type Progress struct {
	QuestionID   string     `json:"questionId"`
	Attempts     int        `json:"attempts"`
	Completed    int        `json:"completed"`
	BestScore    *int       `json:"bestScore,omitempty"`
	LastActivity *time.Time `json:"lastActivity,omitempty"`
}

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	// Columns added after the first release.
	if _, err := db.Exec(`ALTER TABLE attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'practice'`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		db.Close()
		return nil, fmt.Errorf("migrate mode column: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func parseTime(v string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, v)
	return t
}

const attemptCols = `a.id, a.question_id, a.status, a.mode, a.answers, a.whiteboard, a.elapsed_seconds, a.created_at, a.updated_at,
	(SELECT MAX(score) FROM feedback f WHERE f.attempt_id = a.id)`

type scanner interface{ Scan(dest ...any) error }

func scanAttempt(row scanner) (*Attempt, error) {
	var (
		a                  Attempt
		answers, from, upd string
		best               sql.NullInt64
	)
	if err := row.Scan(&a.ID, &a.QuestionID, &a.Status, &a.Mode, &answers, &a.Whiteboard, &a.ElapsedSeconds, &from, &upd, &best); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal([]byte(answers), &a.Answers)
	a.CreatedAt, a.UpdatedAt = parseTime(from), parseTime(upd)
	if best.Valid {
		v := int(best.Int64)
		a.BestScore = &v
	}
	return &a, nil
}

func (s *Store) CreateAttempt(ctx context.Context, questionID, mode string) (*Attempt, error) {
	ts := now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO attempts (question_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)`, questionID, mode, ts, ts)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetAttempt(ctx, id)
}

func (s *Store) GetAttempt(ctx context.Context, id int64) (*Attempt, error) {
	return scanAttempt(s.db.QueryRowContext(ctx, `SELECT `+attemptCols+` FROM attempts a WHERE a.id = ?`, id))
}

// ListAttempts returns attempts newest first, optionally filtered by question.
func (s *Store) ListAttempts(ctx context.Context, questionID string) ([]Attempt, error) {
	q := `SELECT ` + attemptCols + ` FROM attempts a`
	var args []any
	if questionID != "" {
		q += ` WHERE a.question_id = ?`
		args = append(args, questionID)
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY a.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attempt{}
	for rows.Next() {
		a, err := scanAttempt(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

type AttemptUpdate struct {
	Status         *string  `json:"status"`
	Answers        *Answers `json:"answers"`
	Whiteboard     *string  `json:"whiteboard"`
	ElapsedSeconds *int     `json:"elapsedSeconds"`
}

func (s *Store) UpdateAttempt(ctx context.Context, id int64, u AttemptUpdate) (*Attempt, error) {
	a, err := s.GetAttempt(ctx, id)
	if err != nil {
		return nil, err
	}
	if u.Status != nil {
		a.Status = *u.Status
	}
	if u.Answers != nil {
		a.Answers = *u.Answers
	}
	if u.Whiteboard != nil {
		a.Whiteboard = *u.Whiteboard
	}
	if u.ElapsedSeconds != nil {
		a.ElapsedSeconds = *u.ElapsedSeconds
	}
	answers, _ := json.Marshal(a.Answers)
	if _, err := s.db.ExecContext(ctx,
		`UPDATE attempts SET status = ?, answers = ?, whiteboard = ?, elapsed_seconds = ?, updated_at = ? WHERE id = ?`,
		a.Status, string(answers), a.Whiteboard, a.ElapsedSeconds, now(), id); err != nil {
		return nil, err
	}
	return s.GetAttempt(ctx, id)
}

func (s *Store) DeleteAttempt(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM attempts WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AddFeedback(ctx context.Context, attemptID int64, score int, report json.RawMessage) (*Feedback, error) {
	ts := now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO feedback (attempt_id, score, report, created_at) VALUES (?, ?, ?, ?)`, attemptID, score, string(report), ts)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Feedback{ID: id, AttemptID: attemptID, Score: score, Report: report, CreatedAt: parseTime(ts)}, nil
}

func (s *Store) ListFeedback(ctx context.Context, attemptID int64) ([]Feedback, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, attempt_id, score, report, created_at FROM feedback WHERE attempt_id = ? ORDER BY id DESC`, attemptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Feedback{}
	for rows.Next() {
		var (
			f          Feedback
			report, ts string
		)
		if err := rows.Scan(&f.ID, &f.AttemptID, &f.Score, &report, &ts); err != nil {
			return nil, err
		}
		f.Report, f.CreatedAt = json.RawMessage(report), parseTime(ts)
		out = append(out, f)
	}
	return out, rows.Err()
}

// AllFeedback returns every report across attempts, newest first.
func (s *Store) AllFeedback(ctx context.Context) ([]Feedback, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT f.id, f.attempt_id, a.question_id, f.score, f.report, f.created_at
		FROM feedback f JOIN attempts a ON a.id = f.attempt_id ORDER BY f.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Feedback{}
	for rows.Next() {
		var (
			f          Feedback
			report, ts string
		)
		if err := rows.Scan(&f.ID, &f.AttemptID, &f.QuestionID, &f.Score, &report, &ts); err != nil {
			return nil, err
		}
		f.Report, f.CreatedAt = json.RawMessage(report), parseTime(ts)
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) AddMessage(ctx context.Context, attemptID int64, role, text, raw string) (*Message, error) {
	ts := now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO messages (attempt_id, role, text, raw, created_at) VALUES (?, ?, ?, ?, ?)`, attemptID, role, text, raw, ts)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Message{ID: id, AttemptID: attemptID, Role: role, Text: text, Raw: raw, CreatedAt: parseTime(ts)}, nil
}

func (s *Store) ListMessages(ctx context.Context, attemptID int64) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, attempt_id, role, text, raw, created_at FROM messages WHERE attempt_id = ? ORDER BY id`, attemptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var (
			m  Message
			ts string
		)
		if err := rows.Scan(&m.ID, &m.AttemptID, &m.Role, &m.Text, &m.Raw, &ts); err != nil {
			return nil, err
		}
		m.CreatedAt = parseTime(ts)
		out = append(out, m)
	}
	return out, rows.Err()
}

// Progress summarizes attempts per question.
func (s *Store) Progress(ctx context.Context) ([]Progress, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.question_id,
		       COUNT(*),
		       SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END),
		       (SELECT MAX(f.score) FROM feedback f JOIN attempts a2 ON a2.id = f.attempt_id WHERE a2.question_id = a.question_id),
		       MAX(a.updated_at)
		FROM attempts a GROUP BY a.question_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Progress{}
	for rows.Next() {
		var (
			p    Progress
			best sql.NullInt64
			last string
		)
		if err := rows.Scan(&p.QuestionID, &p.Attempts, &p.Completed, &best, &last); err != nil {
			return nil, err
		}
		if best.Valid {
			v := int(best.Int64)
			p.BestScore = &v
		}
		t := parseTime(last)
		p.LastActivity = &t
		out = append(out, p)
	}
	return out, rows.Err()
}
