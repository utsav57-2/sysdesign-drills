import type { Feedback, Report } from '../api'
import { Link } from 'react-router-dom'
import { formatDate, useBank } from '../data'
import { STAGE_NAMES } from '../stages'

const VERDICT: Record<Report['verdict'], string> = {
  strong_no_hire: 'Strong no hire',
  no_hire: 'No hire',
  lean_no_hire: 'Leaning no hire',
  lean_hire: 'Leaning hire',
  hire: 'Hire',
  strong_hire: 'Strong hire',
}

function tone(score: number) {
  return score >= 8 ? 'good' : score >= 6 ? 'ok' : 'low'
}

export default function FeedbackReport({ feedback }: { feedback: Feedback }) {
  const { bank } = useBank()
  const r = feedback.report
  return (
    <article className="report">
      <header className="report-head">
        <div className={`report-score score-${tone(r.overallScore)}`}>
          <b>{r.overallScore}</b>
          <span>/10</span>
        </div>
        <div>
          <p className={`verdict verdict-${r.verdict.includes('no') ? 'no' : 'yes'}`}>{VERDICT[r.verdict] ?? r.verdict}</p>
          <p className="muted small">Graded {formatDate(feedback.createdAt)}</p>
        </div>
      </header>
      <p>{r.summary}</p>

      {r.sections.map((s) => (
        <section key={s.stage} className="report-section">
          <h3>
            <span>{STAGE_NAMES[s.stage] ?? s.stage}</span>
            <span className={`mini-score score-${tone(s.score)}`}>{s.score}/10</span>
          </h3>
          {s.strengths.length > 0 && (
            <ul className="strengths" aria-label="Strengths">
              {s.strengths.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
          {s.gaps.length > 0 && (
            <ul className="gaps" aria-label="Gaps">
              {s.gaps.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
          {s.suggestions.length > 0 && (
            <ul className="suggestions" aria-label="Suggestions">
              {s.suggestions.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
        </section>
      ))}

      <section className="report-section">
        <h3><span>Whiteboard</span></h3>
        <p>{r.diagramFeedback}</p>
      </section>

      {r.missedConcepts.length > 0 && (
        <section className="report-section">
          <h3><span>Concepts to review</span></h3>
          <ul className="chips">
            {r.missedConcepts.map((c) => {
              const concept = bank?.concept(c)
              return (
                <li key={c}>
                  {concept ? <Link to={`/concepts/${c}`} className="chip">{concept.name}</Link> : <span className="chip">{c}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {r.nextSteps.length > 0 && (
        <section className="report-section">
          <h3><span>What to practice next</span></h3>
          <ol>{r.nextSteps.map((x) => <li key={x}>{x}</li>)}</ol>
        </section>
      )}
    </article>
  )
}
