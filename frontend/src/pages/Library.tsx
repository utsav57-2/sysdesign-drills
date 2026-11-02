import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Difficulty, type Progress } from '../api'
import { DIFFICULTY_LABEL, FREQUENCY_LABEL, FREQUENCY_RANK, useBank } from '../data'
import { DifficultyPips, ScoreBadge } from '../components/Badges'

type StatusFilter = 'all' | 'new' | 'started' | 'done'
type Sort = 'frequency' | 'difficulty' | 'title'

const DIFF_RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 }

export default function Library() {
  const { bank, error } = useBank()
  const [progress, setProgress] = useState<Map<string, Progress>>(new Map())
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<Sort>('frequency')

  useEffect(() => {
    api.progress().then((list) => setProgress(new Map(list.map((p) => [p.questionId, p]))), () => {})
  }, [])

  const visible = useMemo(() => {
    if (!bank) return []
    const q = query.trim().toLowerCase()
    return bank.questions
      .filter((x) => category === 'all' || x.category === category)
      .filter((x) => difficulty === 'all' || x.difficulty === difficulty)
      .filter((x) => {
        const p = progress.get(x.id)
        if (status === 'new') return !p
        if (status === 'started') return !!p && p.completed === 0
        if (status === 'done') return !!p && p.completed > 0
        return true
      })
      .filter(
        (x) =>
          !q ||
          x.title.toLowerCase().includes(q) ||
          x.summary.toLowerCase().includes(q) ||
          x.companies.some((c) => c.toLowerCase().includes(q)) ||
          x.concepts.some((c) => c.includes(q)),
      )
      .sort((a, b) => {
        if (sort === 'title') return a.title.localeCompare(b.title)
        if (sort === 'difficulty') return DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty] || a.title.localeCompare(b.title)
        return FREQUENCY_RANK[a.frequency] - FREQUENCY_RANK[b.frequency] || DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty]
      })
  }, [bank, progress, query, category, difficulty, status, sort])

  if (error) return <main className="page"><p className="error">Couldn’t load questions: {error}. Is the backend running on port 8787?</p></main>
  if (!bank) return <main className="page"><p className="muted">Loading questions…</p></main>

  const practiced = progress.size
  const counts = new Map<string, number>()
  bank.questions.forEach((x) => counts.set(x.category, (counts.get(x.category) ?? 0) + 1))

  return (
    <main className="page library">
      <div className="library-head">
        <h1>Pick a system to design</h1>
        <p className="lede">
          {bank.questions.length} questions that come up in real interviews. You’ve practiced {practiced} of them.
        </p>
      </div>

      <div className="library-body">
        <aside className="filters" aria-label="Filters">
          <input
            type="search"
            className="search"
            placeholder="Search titles, companies, concepts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <fieldset>
            <legend>Category</legend>
            <button className={category === 'all' ? 'filter on' : 'filter'} onClick={() => setCategory('all')}>
              All <span>{bank.questions.length}</span>
            </button>
            {bank.categories.map((c) => (
              <button key={c.id} className={category === c.id ? 'filter on' : 'filter'} onClick={() => setCategory(c.id)}>
                {c.name} <span>{counts.get(c.id) ?? 0}</span>
              </button>
            ))}
          </fieldset>

          <fieldset>
            <legend>Difficulty</legend>
            <div className="segmented">
              {(['all', 'easy', 'medium', 'hard'] as const).map((d) => (
                <button key={d} className={difficulty === d ? 'on' : ''} onClick={() => setDifficulty(d)}>
                  {d === 'all' ? 'Any' : DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Your progress</legend>
            <div className="segmented">
              {([
                ['all', 'Any'],
                ['new', 'New'],
                ['started', 'Started'],
                ['done', 'Done'],
              ] as const).map(([v, label]) => (
                <button key={v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </aside>

        <section className="question-list" aria-label="Questions">
          <div className="list-toolbar">
            <span className="muted">{visible.length} shown</span>
            <label>
              Sort by{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="frequency">How often asked</option>
                <option value="difficulty">Difficulty</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>

          {visible.length === 0 && (
            <p className="empty">No questions match these filters. Clear the search or pick a different category.</p>
          )}

          <ol className="rows">
            {visible.map((x) => {
              const p = progress.get(x.id)
              return (
                <li key={x.id}>
                  <Link to={`/questions/${x.id}`} className="row">
                    <DifficultyPips level={x.difficulty} />
                    <div className="row-main">
                      <h2>{x.title}</h2>
                      <p>{x.summary}</p>
                      <div className="row-meta">
                        <span>{bank.categoryName(x.category)}</span>
                        <span>{FREQUENCY_LABEL[x.frequency]}</span>
                        <span className="companies">{x.companies.slice(0, 4).join(', ')}</span>
                        {x.hasSolution && <span className="has-solution">Worked solution</span>}
                      </div>
                    </div>
                    <div className="row-status">
                      {p ? (
                        <>
                          <ScoreBadge score={p.bestScore} />
                          <span className="muted small">
                            {p.attempts} {p.attempts === 1 ? 'attempt' : 'attempts'}
                          </span>
                        </>
                      ) : (
                        <span className="muted small">Not started</span>
                      )}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ol>
        </section>
      </div>
    </main>
  )
}
