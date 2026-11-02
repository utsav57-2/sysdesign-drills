import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type Answers, type Attempt, type ChatMessage, type Config, type Feedback, type StageId } from '../api'
import { formatDuration, useBank } from '../data'
import { STAGES } from '../stages'
import { sceneToPng } from '../diagram'
import Chat from '../components/Chat'
import FeedbackReport from '../components/FeedbackReport'
import Solution from '../components/Solution'

const Whiteboard = lazy(() => import('../components/Whiteboard'))

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error'

export default function Practice() {
  const attemptId = Number(useParams().attemptId)
  const navigate = useNavigate()
  const { bank } = useBank()

  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Answers | null>(null)
  const [scene, setScene] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [stage, setStage] = useState<StageId>('requirements')
  const [panel, setPanel] = useState<'chat' | 'feedback' | 'solution'>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [config, setConfig] = useState<Config | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [grading, setGrading] = useState(false)
  const [gradeError, setGradeError] = useState<string | null>(null)
  const [peeked, setPeeked] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Latest values for the save loop, which runs outside React renders.
  const latest = useRef({ answers, scene, elapsed })
  latest.current = { answers, scene, elapsed }
  const dirty = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const sentScene = useRef<string | null>(null)
  const deleted = useRef(false)

  useEffect(() => {
    Promise.all([api.attempt(attemptId), api.messages(attemptId), api.feedback(attemptId), api.config()])
      .then(([a, m, f, c]) => {
        setAttempt(a)
        setAnswers(a.answers)
        setScene(a.whiteboard)
        setElapsed(a.elapsedSeconds)
        setMessages(m)
        setFeedback(f)
        setConfig(c)
        if (f.length > 0) setPanel('feedback')
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [attemptId])

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const { answers, scene, elapsed } = latest.current
    if (!answers || deleted.current) return
    dirty.current = false
    setSaveState('saving')
    try {
      await api.updateAttempt(attemptId, { answers, whiteboard: scene, elapsedSeconds: elapsed })
      setSaveState(dirty.current ? 'unsaved' : 'saved')
    } catch {
      dirty.current = true
      setSaveState('error')
    }
  }, [attemptId])

  const scheduleSave = useCallback(() => {
    dirty.current = true
    setSaveState('unsaved')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 800)
  }, [flush])

  // Clock runs while the attempt is open and the tab is visible.
  const running = attempt?.status === 'in_progress'
  useEffect(() => {
    if (!running) return
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') setElapsed((s) => s + 1)
    }, 1000)
    const persist = window.setInterval(() => void flush(), 20000)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(persist)
    }
  }, [running, flush])

  // Save on leaving the page.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current) void flush()
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      void flush()
    }
  }, [flush])

  if (loadError) return <main className="page"><p className="error">Couldn’t open this attempt: {loadError}</p><Link to="/">Back to questions</Link></main>
  if (!attempt || !answers || !bank) return <main className="page"><p className="muted">Loading attempt…</p></main>

  const question = bank.question(attempt.questionId)
  const current = STAGES.find((s) => s.id === stage)!
  const stageIndex = STAGES.indexOf(current)
  const targetSeconds = STAGES.reduce((sum, s) => sum + s.minutes, 0) * 60
  const aiReady = config?.aiConfigured ?? false

  const setAnswer = (id: StageId, value: string) => {
    setAnswers((a) => (a ? { ...a, [id]: value } : a))
    scheduleSave()
  }

  const onScene = (s: string) => {
    setScene(s)
    scheduleSave()
  }

  const diagramIfChanged = async () => {
    if (scene === sentScene.current) return ''
    const png = await sceneToPng(scene)
    sentScene.current = scene
    return png
  }

  const grade = async () => {
    setGrading(true)
    setGradeError(null)
    setPanel('feedback')
    try {
      await flush()
      const fb = await api.requestFeedback(attemptId, await sceneToPng(scene))
      setFeedback((f) => [fb, ...f])
    } catch (e) {
      setGradeError((e as Error).message)
    } finally {
      setGrading(false)
    }
  }

  const toggleFinished = async () => {
    setActionError(null)
    try {
      await flush()
      const status = attempt.status === 'completed' ? 'in_progress' : 'completed'
      setAttempt(await api.updateAttempt(attemptId, { status }))
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  const remove = async () => {
    setActionError(null)
    window.clearTimeout(saveTimer.current)
    deleted.current = true
    try {
      await api.deleteAttempt(attemptId)
      navigate(`/questions/${attempt.questionId}`, { replace: true })
    } catch (e) {
      deleted.current = false
      setConfirmDelete(false)
      setActionError((e as Error).message)
    }
  }

  const ended = attempt.status === 'completed'
  const isMock = attempt.mode === 'mock'

  const filled = (id: StageId) => (id === 'highLevel' ? answers.highLevel.trim() !== '' || scene !== '' : answers[id].trim() !== '')

  return (
    <div className="practice">
      <div className="practice-bar">
        <div className="practice-title">
          <Link to={`/questions/${attempt.questionId}`} className="back">{question?.title ?? attempt.questionId}</Link>
          {attempt.mode === 'mock' && <span className="mode-tag">Mock interview</span>}
        </div>
        <div className="practice-actions">
          <span className={`save-state ${saveState}`}>
            {{ saved: 'All changes saved', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Couldn’t save, retrying on next edit' }[saveState]}
          </span>
          <span className={`clock ${elapsed > targetSeconds ? 'over' : ''}`} title={`Target ${targetSeconds / 60} minutes`}>
            {formatDuration(elapsed)}
            <small> / {targetSeconds / 60}:00</small>
          </span>
          {actionError && <span className="error small">{actionError}</span>}
          {confirmDelete ? (
            <>
              <button className="danger" onClick={remove}>Delete for good</button>
              <button className="ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button className="ghost" onClick={() => setConfirmDelete(true)} title="Delete this attempt, its chat and feedback">
              Delete
            </button>
          )}
          <button onClick={toggleFinished}>
            {ended ? (isMock ? 'Resume interview' : 'Reopen attempt') : isMock ? 'End interview' : 'Mark as finished'}
          </button>
          <button className="primary" onClick={grade} disabled={grading || !aiReady} title={aiReady ? '' : 'Needs an Anthropic API key'}>
            {grading ? 'Grading…' : 'Get feedback'}
          </button>
        </div>
      </div>

      <div className="practice-body">
        <section className="workspace">
          <ol className="stage-tabs" role="tablist">
            {STAGES.map((s, i) => (
              <li key={s.id}>
                <button role="tab" aria-selected={s.id === stage} className={s.id === stage ? 'on' : ''} onClick={() => setStage(s.id)}>
                  <span className={`stage-num ${filled(s.id) ? 'done' : ''}`}>{i + 1}</span>
                  {s.name}
                  <small>{s.minutes} min</small>
                </button>
              </li>
            ))}
          </ol>

          <div className={`stage-pane ${stage === 'highLevel' ? 'with-board' : ''}`}>
            <p className="stage-prompt">{current.prompt}</p>
            {stage === 'highLevel' ? (
              <div className="board-layout">
                <Suspense fallback={<div className="whiteboard loading">Loading whiteboard…</div>}>
                  <Whiteboard scene={scene} onChange={onScene} />
                </Suspense>
                <textarea
                  className="notes"
                  value={answers.highLevel}
                  onChange={(e) => setAnswer('highLevel', e.target.value)}
                  placeholder={current.placeholder}
                  aria-label="High-level design notes"
                />
              </div>
            ) : (
              <textarea
                className={`answer ${stage === 'api' ? 'mono' : ''}`}
                value={answers[stage]}
                onChange={(e) => setAnswer(stage, e.target.value)}
                placeholder={current.placeholder}
                aria-label={current.name}
                autoFocus
              />
            )}
            <div className="stage-nav">
              {stageIndex > 0 && <button className="ghost" onClick={() => setStage(STAGES[stageIndex - 1].id)}>Back to {STAGES[stageIndex - 1].name}</button>}
              <span />
              {stageIndex < STAGES.length - 1 && <button onClick={() => setStage(STAGES[stageIndex + 1].id)}>Next: {STAGES[stageIndex + 1].name}</button>}
            </div>
          </div>
        </section>

        <aside className="side-panel">
          <div className="panel-tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'chat'} className={panel === 'chat' ? 'on' : ''} onClick={() => setPanel('chat')}>
              Interviewer
            </button>
            <button role="tab" aria-selected={panel === 'feedback'} className={panel === 'feedback' ? 'on' : ''} onClick={() => setPanel('feedback')}>
              Feedback{feedback.length > 0 && ` (${feedback.length})`}
            </button>
            {question?.hasSolution && (
              <button role="tab" aria-selected={panel === 'solution'} className={panel === 'solution' ? 'on' : ''} onClick={() => setPanel('solution')}>
                Solution
              </button>
            )}
          </div>

          {!aiReady && config && (
            <div className="notice">
              The interviewer and grading use Claude. Set <code>ANTHROPIC_API_KEY</code> and restart the backend to turn them on.
              You can still practice and save your answers without it.
            </div>
          )}

          {panel === 'chat' ? (
            <Chat attemptId={attemptId} messages={messages} onMessages={setMessages} getDiagram={diagramIfChanged} beforeSend={flush} disabled={!aiReady} ended={ended} mode={attempt.mode} stage={stage} onStage={setStage} />
          ) : panel === 'solution' ? (
            <div className="feedback-panel">
              {attempt.status === 'completed' || feedback.length > 0 || peeked ? (
                <Solution questionId={attempt.questionId} stage={stage} />
              ) : (
                <div className="chat-empty">
                  <p>
                    The worked solution unlocks when you mark the attempt finished or get feedback. Peeking now makes this
                    attempt less useful as practice.
                  </p>
                  <div className="starters">
                    <button className="ghost" onClick={() => setPeeked(true)}>Show this stage’s solution anyway</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="feedback-panel">
              {grading && <p className="typing">Grading your attempt. This usually takes under a minute.</p>}
              {gradeError && <p className="error small">Feedback failed: {gradeError}</p>}
              {!grading && feedback.length === 0 && !gradeError && (
                <p className="muted">
                  When you’ve worked through the stages, press <b>Get feedback</b> for a scored review of each stage and your whiteboard.
                </p>
              )}
              {feedback.map((f, i) => (
                <details key={f.id} open={i === 0}>
                  <summary>
                    {i === 0 ? 'Latest review' : `Earlier review`}: {f.score}/10
                  </summary>
                  <FeedbackReport feedback={f} />
                </details>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
