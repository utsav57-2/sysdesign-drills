import type { StageId } from './api'

export interface Stage {
  id: StageId
  name: string
  minutes: number
  prompt: string
  placeholder: string
}

// The delivery framework most interviewers expect, in order.
export const STAGES: Stage[] = [
  {
    id: 'requirements',
    name: 'Requirements',
    minutes: 5,
    prompt:
      'Agree on scope. List the 3–4 core features users need, then the qualities the system must have: scale, latency, consistency vs availability, durability.',
    placeholder:
      'Functional\n- Users can …\n- Users can …\n\nNon-functional\n- Low latency: …\n- Scale: … DAU, … reads/sec\n- Consistency: …',
  },
  {
    id: 'entities',
    name: 'Core entities',
    minutes: 2,
    prompt: 'Name the main things the system stores and moves around. Fields can come later.',
    placeholder: '- User\n- …',
  },
  {
    id: 'api',
    name: 'API',
    minutes: 5,
    prompt: 'Define the endpoints that satisfy each functional requirement. One endpoint per requirement is a good start.',
    placeholder: 'POST /v1/things\n  body: { … }\n  → 201 { id }\n\nGET /v1/things/{id}\n  → { … }',
  },
  {
    id: 'highLevel',
    name: 'High-level design',
    minutes: 15,
    prompt:
      'Draw the services, data stores, and how requests flow between them. Walk through each API call end to end and make sure every functional requirement is met.',
    placeholder: 'Notes on the diagram: request flow, data model, why each component is there …',
  },
  {
    id: 'deepDives',
    name: 'Deep dives',
    minutes: 10,
    prompt:
      'Revisit the non-functional requirements. Where does the design break at scale? Cover bottlenecks, failure modes, consistency, and the trade-offs you are making.',
    placeholder: '- How do we handle …?\n- What happens when … fails?',
  },
]

export const STAGE_NAMES = Object.fromEntries(STAGES.map((s) => [s.id, s.name])) as Record<StageId, string>
