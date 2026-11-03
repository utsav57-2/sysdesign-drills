import { useEffect, useState, type ReactNode } from 'react'
import { api, type StageId } from '../api'
import { STAGES } from '../stages'
import { Md, QuestionCards, splitSections } from './Markdown'

const FOLLOW_UPS = 'follow-up questions'
const PRODUCTION = 'production readiness'

const solutionCache = new Map<string, Promise<string>>()

function loadSolution(questionId: string) {
  let p = solutionCache.get(questionId)
  if (!p) {
    p = api.solution(questionId).then((r) => r.markdown)
    p.catch(() => solutionCache.delete(questionId))
    solutionCache.set(questionId, p)
  }
  return p
}

interface Props {
  questionId: string
  /** Show only this stage's section, with a toggle to expand the rest. */
  stage?: StageId
}

// Solution files use one "## <stage name>" heading per stage, plus "## Production readiness"
// and "## Follow-up questions", which both belong with the deep dives.
export default function Solution({ questionId, stage }: Props) {
  const [md, setMd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(!stage)

  useEffect(() => {
    loadSolution(questionId).then(setMd, (e: Error) => setError(e.message))
  }, [questionId])

  if (error) return <p className="error small">Couldn’t load the solution: {error}</p>
  if (md === null) return <p className="muted small">Loading solution…</p>

  const sections = splitSections(md)
  const visible = showAll ? STAGES : STAGES.filter((s) => s.id === stage)
  const withDeepDives = showAll || stage === 'deepDives'
  const production = withDeepDives && sections.get(PRODUCTION)?.body
  const followUps = withDeepDives && sections.get(FOLLOW_UPS)?.body

  const blocks: ReactNode[] = visible.map((s) => {
    const body = sections.get(s.name.toLowerCase())?.body
    return (
      body && (
        <section key={s.id}>
          <h3>{s.name}</h3>
          <Md>{body}</Md>
        </section>
      )
    )
  })

  return (
    <div className="solution">
      {blocks}
      {production && (
        <section>
          <h3>Production readiness</h3>
          <Md>{production}</Md>
        </section>
      )}
      {followUps && (
        <QuestionCards
          body={followUps}
          title="Follow-up questions"
          hint="What an interviewer is likely to ask next. Answer out loud first, then open each one."
        />
      )}
      {stage && (
        <button className="ghost small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only this stage' : 'Show every stage'}
        </button>
      )}
    </div>
  )
}
