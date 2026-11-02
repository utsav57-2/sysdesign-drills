import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useBank } from '../data'
import { Md, QuestionCards, splitSections } from '../components/Markdown'

const FOLLOW_UPS = 'common follow-up questions'

export default function ConceptPage() {
  const { id = '' } = useParams()
  const { bank, error } = useBank()
  const [md, setMd] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const concept = bank?.concept(id)

  useEffect(() => {
    setMd(null)
    setLoadError(null)
    window.scrollTo(0, 0)
    if (!concept?.hasExplainer) return
    api.conceptPage(id).then((r) => setMd(r.markdown), (e: Error) => setLoadError(e.message))
  }, [id, concept?.hasExplainer])

  // Questions that use this concept, and the concepts most often used alongside it.
  const { usedBy, related } = useMemo(() => {
    if (!bank) return { usedBy: [], related: [] }
    const usedBy = bank.questions.filter((q) => q.concepts.includes(id))
    const counts = new Map<string, number>()
    usedBy.forEach((q) => q.concepts.forEach((c) => c !== id && counts.set(c, (counts.get(c) ?? 0) + 1)))
    const related = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c]) => bank.concept(c))
      .filter((c) => c !== undefined)
    return { usedBy, related }
  }, [bank, id])

  if (error) return <main className="page"><p className="error">{error}</p></main>
  if (!bank) return <main className="page"><p className="muted">Loading…</p></main>
  if (!concept) {
    return (
      <main className="page">
        <h1>Concept not found</h1>
        <Link to="/concepts">All concepts</Link>
      </main>
    )
  }

  const group = bank.groups.find((g) => g.id === concept.group)
  const siblings = bank.concepts.filter((c) => c.group === concept.group)
  const idx = siblings.findIndex((c) => c.id === id)
  const prev = siblings[idx - 1]
  const next = siblings[idx + 1]

  const sections = md ? [...splitSections(md).values()] : []

  return (
    <main className="page concept-page">
      <Link to="/concepts" className="back">All concepts</Link>
      <div className="concept-layout">
        <article className="concept-article">
          <p className="concept-group">{group?.name}</p>
          <h1>{concept.name}</h1>
          <p className="lede">{concept.summary}</p>

          {!concept.hasExplainer && <p className="empty">A full explainer for this concept hasn’t been written yet.</p>}
          {loadError && <p className="error">Couldn’t load the explainer: {loadError}</p>}
          {concept.hasExplainer && md === null && !loadError && <p className="muted">Loading explainer…</p>}

          <div className="solution explainer">
            {sections.map((s) =>
              s.title.toLowerCase() === FOLLOW_UPS ? (
                <QuestionCards key={s.title} body={s.body} title={s.title} hint="Try answering each one before opening it." />
              ) : (
                <section key={s.title}>
                  <h2>{s.title}</h2>
                  <Md>{s.body}</Md>
                </section>
              ),
            )}
          </div>

          <nav className="concept-pager" aria-label={`More in ${group?.name}`}>
            {prev ? <Link to={`/concepts/${prev.id}`}>‹ {prev.name}</Link> : <span />}
            {next ? <Link to={`/concepts/${next.id}`}>{next.name} ›</Link> : <span />}
          </nav>
        </article>

        <aside className="concept-aside">
          <section>
            <h2>Used in</h2>
            {usedBy.length === 0 ? (
              <p className="muted small">Not tagged on any question yet.</p>
            ) : (
              <ul>
                {usedBy.map((q) => (
                  <li key={q.id}><Link to={`/questions/${q.id}`}>{q.title.replace(/^Design (a |an )?/, '')}</Link></li>
                ))}
              </ul>
            )}
          </section>
          {related.length > 0 && (
            <section>
              <h2>Often used with</h2>
              <ul className="chips">
                {related.map((c) => (
                  <li key={c.id}><Link to={`/concepts/${c.id}`} className="chip">{c.name}</Link></li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </main>
  )
}
