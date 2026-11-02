import type { Difficulty } from '../api'
import { DIFFICULTY_LABEL } from '../data'

const LEVEL = { easy: 1, medium: 2, hard: 3 } as const

export function DifficultyPips({ level }: { level: Difficulty }) {
  return (
    <span className={`pips pips-${level}`} title={DIFFICULTY_LABEL[level]}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= LEVEL[level] ? 'filled' : ''} />
      ))}
      <span className="pips-label">{DIFFICULTY_LABEL[level]}</span>
    </span>
  )
}

export function ScoreBadge({ score }: { score?: number }) {
  if (score == null) return <span className="score score-none">No score yet</span>
  const tone = score >= 8 ? 'good' : score >= 6 ? 'ok' : 'low'
  return (
    <span className={`score score-${tone}`}>
      <b>{score}</b>/10
    </span>
  )
}
