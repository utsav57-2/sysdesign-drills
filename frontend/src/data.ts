import { useEffect, useState } from 'react'
import { api, type Category, type Concept, type ConceptGroup, type Question } from './api'

export interface Bank {
  categories: Category[]
  questions: Question[]
  groups: ConceptGroup[]
  concepts: Concept[]
  question: (id: string) => Question | undefined
  concept: (id: string) => Concept | undefined
  categoryName: (id: string) => string
}

// The question bank is static, so load it once and share it.
let bankPromise: Promise<Bank> | null = null

function loadBank(): Promise<Bank> {
  bankPromise ??= Promise.all([api.questions(), api.concepts()]).then(([q, c]) => {
    const qById = new Map(q.questions.map((x) => [x.id, x]))
    const cById = new Map(c.concepts.map((x) => [x.id, x]))
    const catById = new Map(q.categories.map((x) => [x.id, x.name]))
    return {
      categories: q.categories,
      questions: q.questions,
      groups: c.groups,
      concepts: c.concepts,
      question: (id) => qById.get(id),
      concept: (id) => cById.get(id),
      categoryName: (id) => catById.get(id) ?? id,
    }
  })
  bankPromise.catch(() => (bankPromise = null))
  return bankPromise
}

export function useBank(): { bank: Bank | null; error: string | null } {
  const [bank, setBank] = useState<Bank | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadBank().then(setBank, (e: Error) => setError(e.message))
  }, [])
  return { bank, error }
}

export const DIFFICULTY_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' } as const
export const FREQUENCY_LABEL = {
  'very-high': 'Asked very often',
  high: 'Asked often',
  medium: 'Asked sometimes',
  low: 'Asked rarely',
} as const
export const FREQUENCY_RANK = { 'very-high': 0, high: 1, medium: 2, low: 3 } as const

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
