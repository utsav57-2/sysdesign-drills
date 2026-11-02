import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type Attempt } from '../api'
import { FREQUENCY_LABEL, formatDate, formatDuration, useBank } from '../data'
import { DifficultyPips, ScoreBadge } from '../components/Badges'
import Solution from '../components/Solution'

export default function QuestionPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { bank, error } = useBank()
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [reveal, setReveal] = useState(false)
  const [showSolution, setShowSolution] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    api.attempts(id).then(setAttempts, () => {})
  }, [id])

  if (error) return <main className="page"><p className="error">{error}</p></main>
  if (!bank) return <main className="page"><p className="muted">Loading…</p></main>
  const q = bank.question(id)
  if (!q) return <main className="page"><h1>Question not found</h1><Link to="/">Back to questions</Link></main>

  const start = async (mode: Attempt['mode']) => {
    setStarting(true)
    setStartError(null)
    try {
      const a = await api.createAttempt(q.id, mode)
      navigate(`/practice/${a.id}`)
    } catch (e) {
      setStartError((e as Error).message)
      setStarting(false)
    }
  }

  const replace = (a: Attempt) => setAttempts((list) => list.map((x) => (x.id === a.id ? a : x)))

  const end = async (a: Attempt) => {
    setRowError(null)
    try {
      replace(await api.updateAttempt(a.id, { status: 'completed' }))
    } catch (e) {
      setRowError((e as Error).message)
    }
  }

  const remove = async (attemptId: number) => {
    setRowError(null)
    try {
      await api.deleteAttempt(attemptId)
      setAttempts((list) => list.filter((x) => x.id !== attemptId))
    } catch (e) {
      setRowError((e as Error).message)
    }
    setConfirming(null)
  }

  const inProgress = attempts.find((a) => a.status === 'in_progress')

  return (
    <main className="page question-page">
      <Link to="/" className="back">All questions</Link>

      <div className="question-hero">
        <div>
          <DifficultyPips level={q.difficulty} />
          <h1>{q.title}</h1>
          <p className="lede">{q.summary}</p>
          <p className="muted">
            {bank.categoryName(q.category)}. {FREQUENCY_LABEL[q.frequency]}, including at {q.companies.join(', ')}.
          </p>
        </div>
        <div className="start-box">
          <button className="primary big" onClick={() => start('mock')} disabled={starting}>
            Start a mock interview
          </button>
          <p className="muted small">The interviewer leads, keeps time, and moves you through each stage.</p>
          <button onClick={() => start('practice')} disabled={starting}>
            Practice at your own pace
          </button>
          {inProgress && (
            <Link to={`/practice/${inProgress.id}`} className="button">
              Resume attempt from {formatDate(inProgress.updatedAt)}
            </Link>
          )}
          {startError && <p className="error small">{startError}</p>}

        </div>
      </div>

      <section className="reference">
        <div className="reference-head">
          <h2>What a strong answer covers</h2>
          <button className="ghost" onClick={() => setReveal((r) => !r)} aria-expanded={reveal}>
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
        {!reveal ? (
          <p className="muted">Hidden so it doesn’t spoil your attempt. Open it afterwards to check what you missed.</p>
        ) : (
          <div className="reference-grid">
            <div>
              <h3>Core features</h3>
              <ul>{q.functional.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h3>System qualities</h3>
              <ul>{q.nonFunctional.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h3>Hard parts to dig into</h3>
              <ul>{q.challenges.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h3>Concepts used</h3>
              <ul className="chips">
                {q.concepts.map((c) => (
                  <li key={c}>
                    <Link to={`/concepts/${c}`} className="chip">{bank.concept(c)?.name ?? c}</Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      {q.hasSolution && (
        <section className="reference">
          <div className="reference-head">
            <h2>Worked solution</h2>
            <button className="ghost" onClick={() => setShowSolution((v) => !v)} aria-expanded={showSolution}>
              {showSolution ? 'Hide' : attempts.length === 0 ? 'Show anyway' : 'Show'}
            </button>
          </div>
          {showSolution ? (
            <Solution questionId={q.id} />
          ) : (
            <p className="muted">
              {attempts.length === 0
                ? 'You’ll learn more by trying it first. Come back after an attempt to compare.'
                : 'A full answer covering every stage, to compare against your own.'}
            </p>
          )}
        </section>
      )}

      <section>
        <h2>Your attempts</h2>
        {attempts.length === 0 ? (
          <p className="muted">You haven’t tried this one yet.</p>
        ) : (
          <table className="attempts">
            <thead>
              <tr><th>Started</th><th>Type</th><th>Status</th><th>Time spent</th><th>Best score</th><th /></tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.createdAt)}</td>
                  <td>{a.mode === 'mock' ? 'Mock interview' : 'Practice'}</td>
                  <td>{a.status === 'completed' ? 'Finished' : 'In progress'}</td>
                  <td>{formatDuration(a.elapsedSeconds)}</td>
                  <td><ScoreBadge score={a.bestScore} /></td>
                  <td className="row-actions">
                    {confirming === a.id ? (
                      <>
                        <button className="danger small" onClick={() => remove(a.id)}>Delete for good</button>
                        <button className="ghost small" onClick={() => setConfirming(null)}>Keep</button>
                      </>
                    ) : (
                      <>
                        <Link to={`/practice/${a.id}`}>Open</Link>
                        {a.status === 'in_progress' && (
                          <button className="ghost small" onClick={() => end(a)}>{a.mode === 'mock' ? 'End' : 'Finish'}</button>
                        )}
                        <button className="ghost small" onClick={() => setConfirming(a.id)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rowError && <p className="error small">{rowError}</p>}
      </section>
    </main>
  )
}
