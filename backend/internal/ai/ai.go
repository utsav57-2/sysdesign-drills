// Package ai wraps the Claude API for interview feedback and the interviewer chat.
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/shared/constant"

	"sysdesign-prep/backend/internal/content"
	"sysdesign-prep/backend/internal/store"
)

const DefaultModel = "claude-opus-5-5"

var ErrRefused = errors.New("the model declined this request")

type Client struct {
	api   anthropic.Client
	model string
}

func New(model string) *Client {
	if model == "" {
		model = DefaultModel
	}
	return &Client{api: anthropic.NewClient(), model: model}
}

func (c *Client) Model() string { return c.model }

// Configured reports whether any credential source the SDK reads is present.
func Configured() bool {
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("ANTHROPIC_AUTH_TOKEN") != "" {
		return true
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(home, ".config", "anthropic"))
	return err == nil
}

// baseParams sets options shared by every request: adaptive thinking and
// server-side refusal fallbacks routed by Anthropic's defaults.
func (c *Client) baseParams(effort anthropic.BetaOutputConfigEffort) anthropic.BetaMessageNewParams {
	return anthropic.BetaMessageNewParams{
		Model:        c.model,
		Thinking:     anthropic.BetaThinkingConfigParamUnion{OfAdaptive: &anthropic.BetaThinkingConfigAdaptiveParam{}},
		OutputConfig: anthropic.BetaOutputConfigParam{Effort: effort},
		Fallbacks:    anthropic.BetaFallbacksParamUnion{OfDefault: constant.ValueOf[constant.Default]()},
		Betas:        []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
	}
}

// Workspace renders the candidate's current answers as plain text.
func Workspace(a store.Answers) string {
	section := func(title, body string) string {
		body = strings.TrimSpace(body)
		if body == "" {
			body = "(empty)"
		}
		return "## " + title + "\n" + body + "\n"
	}
	return strings.Join([]string{
		section("Requirements", a.Requirements),
		section("Core Entities", a.Entities),
		section("API Design", a.API),
		section("High-Level Design notes", a.HighLevel),
		section("Deep Dives", a.DeepDives),
	}, "\n")
}

func questionBrief(q *content.Question) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Question: %s\n%s\n\n", q.Title, q.Summary)
	fmt.Fprintf(&b, "Reference functional requirements: %s\n", strings.Join(q.Functional, "; "))
	fmt.Fprintf(&b, "Reference non-functional requirements: %s\n", strings.Join(q.NonFunctional, "; "))
	fmt.Fprintf(&b, "Key challenges a strong answer addresses: %s\n", strings.Join(q.Challenges, "; "))
	fmt.Fprintf(&b, "Relevant concepts: %s\n", strings.Join(q.Concepts, ", "))
	return b.String()
}

// diagramBlock turns a PNG data URL (or bare base64) into an image block.
func diagramBlock(png string) (anthropic.BetaContentBlockParamUnion, bool) {
	png = strings.TrimPrefix(png, "data:image/png;base64,")
	if png == "" {
		return anthropic.BetaContentBlockParamUnion{}, false
	}
	return anthropic.NewBetaImageBlock(anthropic.BetaBase64ImageSourceParam{
		Data:      png,
		MediaType: anthropic.BetaBase64ImageSourceMediaTypeImagePNG,
	}), true
}

// ---- Feedback ----

// seniorChecklist is what a senior candidate is expected to raise without being asked.
// Both the interviewer and the grader use it.
const seniorChecklist = `
Beyond the core design, a senior candidate is expected to raise these without being prompted, where they matter for this problem:
- Scale estimation that actually drives decisions (QPS, read/write ratio, storage growth, bandwidth, peaks).
- API details: pagination, versioning, authentication and authorization, idempotency, error handling.
- Data: access patterns and indexes, normalization vs denormalization, and a reasoned database choice (relational vs NoSQL, ACID vs BASE).
- Consistency: which parts need strong consistency and which can be eventual, justified by the business (CAP).
- Communication: why each interaction is synchronous or asynchronous, and why services are split where they are.
- Reliability: timeouts, retries with backoff, idempotency, circuit breakers, dead-letter queues, bulkheads, graceful degradation.
- High availability: no single points of failure, failover, multi-zone or multi-region, backups, RPO and RTO.
- Security: authn/authz, encryption in transit and at rest, secrets and key rotation, audit logs, rate limiting and abuse.
- Observability: metrics, logs, traces, SLIs and SLOs, alerting.
- Performance and cost: batching, caching, compression, connection pooling; storage, replication and cross-region costs.
- Trade-offs: every major choice should name what it gives up.
`

const feedbackSystem = `You are a senior staff engineer grading a system design interview, in the style of a FAANG onsite.
The candidate worked through a standard delivery framework: requirements, core entities, API design, high-level design (a whiteboard diagram plus notes), and deep dives.
Grade against what is expected of a mid-to-senior (L5/E5) candidate. Be specific and concrete: reference what the candidate actually wrote or drew, name the exact technologies or techniques they should have used, and explain why.
Empty sections should get low scores and say what was expected. Do not invent content the candidate did not provide.
Scores are integers from 1 (missing or wrong) to 10 (exceptional).
When a reference solution is provided, use it as the answer key for what a strong answer covers, but give full credit for different approaches that are well reasoned and correct.
missedConcepts lists glossary concept IDs the candidate should have used or explained better; leave it empty if they covered everything important.
Score the checklist below mostly in deep dives. Name the specific items the candidate skipped that matter for this problem, and do not penalize items that are irrelevant to it.
` + seniorChecklist

// feedbackSchema constrains missedConcepts to glossary IDs so weak areas can be tracked over time.
func feedbackSchema(conceptIDs []string) map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"overallScore", "verdict", "summary", "sections", "diagramFeedback", "missedConcepts", "nextSteps"},
		"properties": map[string]any{
			"overallScore": map[string]any{"type": "integer", "description": "1-10"},
			"verdict": map[string]any{
				"type": "string",
				"enum": []string{"strong_no_hire", "no_hire", "lean_no_hire", "lean_hire", "hire", "strong_hire"},
			},
			"summary": map[string]any{"type": "string", "description": "2-4 sentence overall assessment"},
			"sections": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"required":             []string{"stage", "score", "strengths", "gaps", "suggestions"},
					"properties": map[string]any{
						"stage":       map[string]any{"type": "string", "enum": []string{"requirements", "entities", "api", "highLevel", "deepDives"}},
						"score":       map[string]any{"type": "integer", "description": "1-10"},
						"strengths":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
						"gaps":        map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
						"suggestions": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					},
				},
			},
			"diagramFeedback": map[string]any{"type": "string", "description": "Feedback on the whiteboard diagram, or a note that none was provided"},
			"missedConcepts":  map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": conceptIDs}},
			"nextSteps":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
	}
}

type Report struct {
	OverallScore int    `json:"overallScore"`
	Verdict      string `json:"verdict"`
}

// Feedback grades an attempt and returns the raw JSON report plus its overall score.
// solution is an optional reference answer in Markdown.
func (c *Client) Feedback(ctx context.Context, q *content.Question, solution string, conceptIDs []string, a store.Answers, diagramPNG string) (json.RawMessage, int, error) {
	blocks := []anthropic.BetaContentBlockParamUnion{
		anthropic.NewBetaTextBlock(questionBrief(q)),
	}
	if solution != "" {
		blocks = append(blocks, anthropic.NewBetaTextBlock("<reference_solution>\n"+solution+"\n</reference_solution>"))
	}
	if img, ok := diagramBlock(diagramPNG); ok {
		blocks = append(blocks, anthropic.NewBetaTextBlock("The candidate's whiteboard diagram:"), img)
	} else {
		blocks = append(blocks, anthropic.NewBetaTextBlock("The candidate did not draw a whiteboard diagram."))
	}
	blocks = append(blocks, anthropic.NewBetaTextBlock("The candidate's written answers:\n\n"+Workspace(a)+"\nGrade this attempt."))

	params := c.baseParams(anthropic.BetaOutputConfigEffortHigh)
	params.MaxTokens = 16000
	params.OutputConfig.Format = anthropic.BetaJSONOutputFormatParam{Schema: feedbackSchema(conceptIDs)}
	params.System = []anthropic.BetaTextBlockParam{{Text: feedbackSystem}}
	params.Messages = []anthropic.BetaMessageParam{anthropic.NewBetaUserMessage(blocks...)}

	resp, err := c.api.Beta.Messages.New(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	if resp.StopReason == anthropic.BetaStopReasonRefusal {
		return nil, 0, ErrRefused
	}
	if resp.StopReason == anthropic.BetaStopReasonMaxTokens {
		return nil, 0, errors.New("feedback was cut off (max_tokens reached)")
	}
	text := textOf(resp)
	var r Report
	if err := json.Unmarshal([]byte(text), &r); err != nil {
		return nil, 0, fmt.Errorf("parse feedback: %w", err)
	}
	return json.RawMessage(text), r.OverallScore, nil
}

// ---- Interviewer chat ----

const (
	ModePractice = "practice"
	ModeMock     = "mock"
)

const interviewerBase = `You are an experienced system design interviewer.
Behave like a real interviewer: keep replies short (usually 1-4 sentences), answer clarifying questions about scope and scale with realistic numbers, and probe the candidate's decisions with follow-up questions ("What happens when...?", "Why X over Y?", "How does this scale to...?").
Do not hand over the solution or design the system for them. If they are stuck, give a small hint. If they ask for a full answer outright, remind them this is practice and nudge them toward the next step instead.
Each candidate message starts with a status line (elapsed time and the stage they have open) and a snapshot of their written workspace, sometimes with their whiteboard diagram. Refer to it naturally rather than repeating it.
Use the checklist below to choose probes. If the candidate never brings up security, failure handling, observability or cost, ask about the ones that matter most for this problem, one at a time, the way a real interviewer would. Don't recite the list.
` + seniorChecklist

const practiceMode = `
The candidate is practicing at their own pace and leads the conversation. Respond to what they ask; don't push them through stages unless they ask what to do next.
`

const mockMode = `
This is a timed mock interview and you lead it, the way a real interviewer would. The target is about 37 minutes:
requirements ~5 min, core entities ~2 min, API ~5 min, high-level design ~15 min, deep dives ~10 min.
- On the first message, briefly introduce the problem in one or two sentences and ask the candidate to start with requirements.
- Keep the candidate moving. When a stage is good enough, or its time is up, say so and move them to the next stage.
- In deep dives, pick the one or two most important weaknesses in their design and press on them. If time allows, also ask how the system fails, how it's secured, and how they'd know it's healthy.
- Around 37 minutes, wrap up: thank them and tell them to press "Get feedback" for their scored review.
- Whenever you move the candidate to a different stage, end your message with a final line of exactly "STAGE: <id>", where <id> is one of requirements, entities, api, highLevel, deepDives. The app hides this line and switches the candidate's view. Never mention it.
`

func chatSystem(q *content.Question, mode string) string {
	m := practiceMode
	if mode == ModeMock {
		m = mockMode
	}
	return interviewerBase + m + "\n" + questionBrief(q)
}

// UserTurn builds the next user message: a status line, the workspace
// snapshot, the optional diagram, and what the candidate said.
func UserTurn(a store.Answers, diagramPNG, said, stage string, elapsedSeconds int) anthropic.BetaMessageParam {
	status := fmt.Sprintf("[%d:%02d elapsed, candidate is on the %q stage]", elapsedSeconds/60, elapsedSeconds%60, stage)
	blocks := []anthropic.BetaContentBlockParamUnion{
		anthropic.NewBetaTextBlock(status + "\n<workspace>\n" + Workspace(a) + "</workspace>"),
	}
	if img, ok := diagramBlock(diagramPNG); ok {
		blocks = append(blocks, anthropic.NewBetaTextBlock("Current whiteboard:"), img)
	}
	blocks = append(blocks, anthropic.NewBetaTextBlock("Candidate: "+said))
	return anthropic.NewBetaUserMessage(blocks...)
}

// DecodeHistory restores stored message params for replay.
func DecodeHistory(msgs []store.Message) ([]anthropic.BetaMessageParam, error) {
	out := make([]anthropic.BetaMessageParam, 0, len(msgs))
	for _, m := range msgs {
		var p anthropic.BetaMessageParam
		if err := json.Unmarshal([]byte(m.Raw), &p); err != nil {
			return nil, fmt.Errorf("decode message %d: %w", m.ID, err)
		}
		out = append(out, p)
	}
	return out, nil
}

// Chat streams the interviewer's reply to history (which must end with the
// new user turn), calling onText for each text delta. It returns the reply
// text and the assistant message param to store for replay.
func (c *Client) Chat(ctx context.Context, q *content.Question, mode string, history []anthropic.BetaMessageParam, onText func(string)) (string, anthropic.BetaMessageParam, error) {
	params := c.baseParams(anthropic.BetaOutputConfigEffortMedium)
	params.MaxTokens = 64000
	params.System = []anthropic.BetaTextBlockParam{{
		Text:         chatSystem(q, mode),
		CacheControl: anthropic.NewBetaCacheControlEphemeralParam(),
	}}
	params.Messages = history
	params.CacheControl = anthropic.NewBetaCacheControlEphemeralParam()

	stream := c.api.Beta.Messages.NewStreaming(ctx, params)
	msg := anthropic.BetaMessage{}
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return "", anthropic.BetaMessageParam{}, err
		}
		if d, ok := ev.AsAny().(anthropic.BetaRawContentBlockDeltaEvent); ok {
			if t, ok := d.Delta.AsAny().(anthropic.BetaTextDelta); ok {
				onText(t.Text)
			}
		}
	}
	if err := stream.Err(); err != nil {
		return "", anthropic.BetaMessageParam{}, err
	}
	if msg.StopReason == anthropic.BetaStopReasonRefusal {
		return "", anthropic.BetaMessageParam{}, ErrRefused
	}
	return textOf(&msg), msg.ToParam(), nil
}

func textOf(m *anthropic.BetaMessage) string {
	var b strings.Builder
	for _, block := range m.Content {
		if t, ok := block.AsAny().(anthropic.BetaTextBlock); ok {
			b.WriteString(t.Text)
		}
	}
	return b.String()
}

// Describe turns API errors into messages a user can act on.
func Describe(err error) string {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case 401:
			return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY and restart the backend."
		case 403:
			return "This API key doesn't have access to " + DefaultModel + ". Set SDP_MODEL to a model your key can use."
		case 429:
			return "Rate limited by the Anthropic API. Wait a moment and try again."
		case 529, 500, 502, 503:
			return "The Anthropic API is temporarily unavailable. Try again shortly."
		}
		return fmt.Sprintf("Anthropic API error (%d).", apiErr.StatusCode)
	}
	if errors.Is(err, ErrRefused) {
		return "The model declined to respond to this. Try rephrasing."
	}
	return err.Error()
}
