export type Difficulty = 'easy' | 'medium' | 'hard'
export type Frequency = 'very-high' | 'high' | 'medium' | 'low'

export interface Category {
  id: string
  name: string
}

export interface Question {
  id: string
  title: string
  category: string
  difficulty: Difficulty
  frequency: Frequency
  companies: string[]
  summary: string
  functional: string[]
  nonFunctional: string[]
  challenges: string[]
  concepts: string[]
  hasSolution: boolean
}

export interface ConceptGroup {
  id: string
  name: string
}

export interface Concept {
  id: string
  group: string
  name: string
  summary: string
  hasExplainer: boolean
}

export interface Answers {
  requirements: string
  entities: string
  api: string
  highLevel: string
  deepDives: string
}

export interface Attempt {
  id: number
  questionId: string
  status: 'in_progress' | 'completed'
  mode: 'practice' | 'mock'
  answers: Answers
  whiteboard: string
  elapsedSeconds: number
  createdAt: string
  updatedAt: string
  bestScore?: number
}

export interface Progress {
  questionId: string
  attempts: number
  completed: number
  bestScore?: number
  lastActivity?: string
}

export type StageId = keyof Answers

export interface SectionReport {
  stage: StageId
  score: number
  strengths: string[]
  gaps: string[]
  suggestions: string[]
}

export interface Report {
  overallScore: number
  verdict: 'strong_no_hire' | 'no_hire' | 'lean_no_hire' | 'lean_hire' | 'hire' | 'strong_hire'
  summary: string
  sections: SectionReport[]
  diagramFeedback: string
  missedConcepts: string[]
  nextSteps: string[]
}

export interface Feedback {
  id: number
  attemptId: number
  questionId?: string
  score: number
  report: Report
  createdAt: string
}

export interface ChatMessage {
  id: number
  attemptId: number
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface Config {
  aiConfigured: boolean
  model: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  config: () => request<Config>('/config'),
  questions: () => request<{ categories: Category[]; questions: Question[] }>('/questions'),
  concepts: () => request<{ groups: ConceptGroup[]; concepts: Concept[] }>('/concepts'),
  solution: (questionId: string) => request<{ markdown: string }>(`/questions/${encodeURIComponent(questionId)}/solution`),
  allFeedback: () => request<Feedback[]>('/feedback'),
  conceptPage: (id: string) => request<{ markdown: string }>(`/concepts/${encodeURIComponent(id)}`),
  progress: () => request<Progress[]>('/progress'),
  attempts: (questionId?: string) =>
    request<Attempt[]>(`/attempts${questionId ? `?questionId=${encodeURIComponent(questionId)}` : ''}`),
  attempt: (id: number) => request<Attempt>(`/attempts/${id}`),
  createAttempt: (questionId: string, mode: Attempt['mode']) =>
    request<Attempt>('/attempts', { method: 'POST', body: JSON.stringify({ questionId, mode }) }),
  updateAttempt: (id: number, patch: Partial<Pick<Attempt, 'status' | 'answers' | 'whiteboard' | 'elapsedSeconds'>>) =>
    request<Attempt>(`/attempts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAttempt: (id: number) => request<void>(`/attempts/${id}`, { method: 'DELETE' }),
  feedback: (id: number) => request<Feedback[]>(`/attempts/${id}/feedback`),
  requestFeedback: (id: number, diagramPng: string) =>
    request<Feedback>(`/attempts/${id}/feedback`, { method: 'POST', body: JSON.stringify({ diagramPng }) }),
  messages: (id: number) => request<ChatMessage[]>(`/attempts/${id}/messages`),
}

/** Sends a chat message and streams the interviewer's reply. */
export async function sendChat(
  attemptId: number,
  text: string,
  diagramPng: string,
  stage: StageId,
  onDelta: (text: string) => void,
): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
  const res = await fetch(`/api/attempts/${attemptId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, diagramPng, stage }),
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const event = /^event: (.*)$/m.exec(chunk)?.[1]
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? '{}')
      if (event === 'delta') onDelta(data.text)
      else if (event === 'done') return data
      else if (event === 'error') throw new Error(data.error)
    }
  }
  throw new Error('The interviewer stopped responding before finishing.')
}

const STAGE_MARKER = /\n?\s*STAGE:\s*(requirements|entities|api|highLevel|deepDives)\s*$/

/** Splits the interviewer's hidden stage-change marker off a reply. */
export function parseStageMarker(text: string): { text: string; stage?: StageId } {
  const m = STAGE_MARKER.exec(text)
  // While streaming, hide a marker that has only partly arrived.
  if (!m) return { text: text.replace(/\n\s*S(?:T(?:A(?:G(?:E(?::\s*\w*)?)?)?)?)?$/, '') }
  return { text: text.slice(0, m.index).trimEnd(), stage: m[1] as StageId }
}
