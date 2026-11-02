import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useBank } from '../data'

export default function Concepts() {
  const { bank, error } = useBank()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  // Old links pointed at /concepts#id; send them to the concept's own page.
  useEffect(() => {
    if (hash) navigate(`/concepts/${hash.slice(1)}`, { replace: true })
  }, [hash, navigate])

  const usedCount = useMemo(() => {
    const m = new Map<string, number>()
    bank?.questions.forEach((q) => q.concepts.forEach((c) => m.set(c, (m.get(c) ?? 0) + 1)))
    return m
  }, [bank])

  if (error) return <main className="page"><p className="error">{error}</p></main>
  if (!bank) return <main className="page"><p className="muted">Loading…</p></main>

  const q = query.trim().toLowerCase()
  const matches = (c: { name: string; summary: string; id: string }) =>
    !q || c.name.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q) || c.id.includes(q)

  return (
    <main className="page concepts">
      <h1>Building blocks</h1>
      <p className="lede">
        The {bank.concepts.length} ideas that come up again and again. Open one for how it works, a worked example, and
        what to say in an interview.
      </p>
      <input
        type="search"
        className="search concept-search"
        placeholder="Search concepts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {bank.groups.map((g) => {
        const list = bank.concepts.filter((c) => c.group === g.id && matches(c))
        if (list.length === 0) return null
        return (
          <section key={g.id}>
            <h2>{g.name}</h2>
            <ul className="concept-grid">
              {list.map((c) => (
                <li key={c.id}>
                  <Link to={`/concepts/${c.id}`} className="concept-card">
                    <b>{c.name}</b>
                    <span>{c.summary}</span>
                    <small>
                      {usedCount.get(c.id) ?? 0} {usedCount.get(c.id) === 1 ? 'question' : 'questions'}
                      {!c.hasExplainer && ', explainer coming'}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}
