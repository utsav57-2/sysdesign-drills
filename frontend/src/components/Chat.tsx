import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseStageMarker, sendChat, type ChatMessage, type StageId } from '../api'

interface Props {
  attemptId: number
  messages: ChatMessage[]
  onMessages: (m: ChatMessage[]) => void
  /** Returns the diagram PNG if it changed since the last message, else ''. */
  getDiagram: () => Promise<string>
  beforeSend: () => Promise<void>
  disabled: boolean
  mode: 'practice' | 'mock'
  stage: StageId
  onStage: (stage: StageId) => void
}

const STARTERS = [
  'Hi! Can I start by clarifying the requirements?',
  'What scale should I design for?',
  'Can you review my API before I move on?',
]

export default function Chat({ attemptId, messages, onMessages, getDiagram, beforeSend, disabled, mode, stage, onStage }: Props) {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streaming, pending])

  const send = async (text: string) => {
    text = text.trim()
    if (!text || pending) return
    setPending(text)
    setStreaming('')
    setError(null)
    setDraft('')
    try {
      await beforeSend()
      const diagram = await getDiagram()
      const { user, assistant } = await sendChat(attemptId, text, diagram, stage, (t) => setStreaming((s) => s + t))
      onMessages([...messages, user, assistant])
      const next = parseStageMarker(assistant.text).stage
      if (next && next !== stage) onStage(next)
    } catch (e) {
      setError((e as Error).message)
      setDraft(text)
    } finally {
      setPending(null)
      setStreaming('')
    }
  }

  return (
    <div className="chat">
      <div className="chat-log" aria-live="polite">
        {messages.length === 0 && !pending && mode === 'mock' && (
          <div className="chat-empty">
            <p>
              The interviewer will introduce the problem, keep time, and move you from stage to stage, like a real
              interview. Think out loud here and write your answers in the workspace.
            </p>
            <button className="primary" onClick={() => send('Hi, I’m ready to begin.')} disabled={disabled}>
              Begin the interview
            </button>
          </div>
        )}
        {messages.length === 0 && !pending && mode === 'practice' && (
          <div className="chat-empty">
            <p>
              Talk through your design the way you would with a real interviewer. They can see your notes and
              whiteboard, answer scoping questions, and push back on your choices.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} className="ghost" onClick={() => send(s)} disabled={disabled}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{parseStageMarker(m.text).text}</Markdown> : <p>{m.text}</p>}
          </div>
        ))}
        {pending && (
          <>
            <div className="bubble user"><p>{pending}</p></div>
            <div className="bubble assistant">
              {streaming ? <Markdown remarkPlugins={[remarkGfm]}>{parseStageMarker(streaming).text}</Markdown> : <p className="typing">Interviewer is thinking…</p>}
            </div>
          </>
        )}
        {error && <p className="error small">Message not sent: {error}</p>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(draft)
            }
          }}
          placeholder={disabled ? 'Add an Anthropic API key to talk to the interviewer' : 'Ask a question or explain a decision'}
          rows={2}
          disabled={disabled || !!pending}
        />
        <button type="submit" className="primary" disabled={disabled || !!pending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
