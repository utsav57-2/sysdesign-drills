import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Attempt, type Feedback, type StageId } from '../api'
import { formatDate, formatDuration, useBank } from '../data'
import { ScoreBadge } from '../components/Badges'
import { STAGES } from '../stages'

export default function History() {
  const { bank } = useBank()
  const [attempts, setAttempts] = useState<Attempt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<Feedback[]>([])

  useEffect(() => {
    api.attempts().then(setAttempts, (e: Error) => setError(e.message))
    api.allFeedback().then(setFeedback, () => {})
  }, [])

  const remove = async (id: number) => {
    try {
      await api.deleteAttempt(id)
      setAttempts((list) => list?.filter((a) => a.id !== id) ?? null)
    } catch (e) {
      setError((e as Error).message)
    }
    setConfirming(null)
  }

  if (error) return <main className="page"><p className="error">{error}</p></main>
  if (!attempts || !bank) return <main className="page"><p className="muted">Loading…</p></main>

  const scored = attempts.filter((a) => a.bestScore != null)
  const avg = scored.length ? (scored.reduce((s, a) => s + a.bestScore!, 0) / scored.length).toFixed(1) : null
  const minutes = Math.round(attempts.reduce((s, a) => s + a.elapsedSeconds, 0) / 60)

  // Only the latest review of each attempt counts, so regrading doesn't double-count.
  const liveIds = new Set(attempts.map((a) => a.id))
  const latest = new Map<number, Feedback>()
  for (const f of feedback) if (liveIds.has(f.attemptId) && !latest.has(f.attemptId)) latest.set(f.attemptId, f)
  const reports = [...latest.values()]

  const missed = new Map<string, number>()
  reports.forEach((f) => f.report.missedConcepts.forEach((c) => missed.set(c, (missed.get(c) ?? 0) + 1)))
  const weak = [...missed.entries()].filter(([id]) => bank.concept(id)).sort((a, b) => b[1] - a[1]).slice(0, 8)

  const stageAvg = STAGES.map((st) => {
    const scores = reports.flatMap((f) => f.report.sections.filter((x) => x.stage === st.id).map((x) => x.score))
    return { stage: st, avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null }
  })
  const weakestStage = stageAvg.filter((x) => x.avg != null).sort((a, b) => a.avg! - b.avg!)[0]?.stage.id as StageId | undefined

  const tried = new Set(attempts.map((a) => a.questionId))
  const practiceFor = (conceptId: string) => {
    const options = bank.questions.filter((q) => q.concepts.includes(conceptId))
    return options.find((q) => !tried.has(q.id)) ?? options[0]
  }

  return (
    <main className="page history">
      <h1>Your practice</h1>
      {attempts.length === 0 ? (
        <p className="empty">
          Nothing here yet. <Link to="/">Pick a question</Link> and start your first attempt.
        </p>
      ) : (
        <>
          <p className="lede">
            {attempts.length} attempts across {new Set(attempts.map((a) => a.questionId)).size} questions, {minutes} minutes in
            total{avg && `, averaging ${avg}/10 where graded`}.
          </p>
          {reports.length > 0 && (
            <div className="insights">
              <section>
                <h2>Concepts you keep missing</h2>
                {weak.length === 0 ? (
                  <p className="muted">No gaps flagged in your graded attempts so far.</p>
                ) : (
                  <ol className="weak-list">
                    {weak.map(([id, n]) => {
                      const q = practiceFor(id)
                      return (
                        <li key={id}>
                          <Link to={`/concepts/${id}`}>{bank.concept(id)!.name}</Link>
                          <span className="muted small">missed in {n} of {reports.length}</span>
                          {q && <Link to={`/questions/${q.id}`} className="small">Practice: {q.title.replace(/^Design (a |an )?/, '')}</Link>}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>
              <section>
                <h2>Average score by stage</h2>
                <table className="stage-avg">
                  <tbody>
                    {stageAvg.map(({ stage, avg }) => (
                      <tr key={stage.id} className={stage.id === weakestStage ? 'weakest' : ''}>
                        <th>{stage.name}</th>
                        <td>
                          <span className="meter" aria-hidden="true"><i style={{ width: `${(avg ?? 0) * 10}%` }} /></span>
                        </td>
                        <td>{avg == null ? '–' : avg.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {weakestStage && <p className="muted small">Your weakest stage is {STAGES.find((x) => x.id === weakestStage)!.name.toLowerCase()}.</p>}
              </section>
            </div>
          )}

          <h2 className="table-title">All attempts</h2>
          <table className="attempts">
            <thead>
              <tr><th>Question</th><th>Last worked on</th><th>Status</th><th>Time spent</th><th>Best score</th><th /></tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/practice/${a.id}`}>{bank.question(a.questionId)?.title ?? a.questionId}</Link></td>
                  <td>{formatDate(a.updatedAt)}</td>
                  <td>{a.status === 'completed' ? 'Finished' : 'In progress'}</td>
                  <td>{formatDuration(a.elapsedSeconds)}</td>
                  <td><ScoreBadge score={a.bestScore} /></td>
                  <td className="row-actions">
                    {confirming === a.id ? (
                      <>
                        <button className="danger small" onClick={() => remove(a.id)}>Delete attempt</button>
                        <button className="ghost small" onClick={() => setConfirming(null)}>Keep</button>
                      </>
                    ) : (
                      <button className="ghost small" onClick={() => setConfirming(a.id)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  )
}
