import { lazy, Suspense } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const Diagram = lazy(() => import('./Diagram'))

// ```mermaid blocks become rendered diagrams; everything else is ordinary Markdown.
const components: Components = {
  pre({ node, children }) {
    const code = node?.children[0]
    if (code?.type === 'element' && code.tagName === 'code') {
      const cls = code.properties?.className
      const isMermaid = Array.isArray(cls) && cls.includes('language-mermaid')
      const text = code.children[0]?.type === 'text' ? code.children[0].value : ''
      if (isMermaid) {
        return (
          <Suspense fallback={<div className="diagram loading">Drawing diagram…</div>}>
            <Diagram source={text.trim()} />
          </Suspense>
        )
      }
    }
    return <pre>{children}</pre>
  },
}

export function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
}

/** Splits Markdown into "## <title>" sections, keyed by lowercase title, in order. */
export function splitSections(md: string): Map<string, { title: string; body: string }> {
  const sections = new Map<string, { title: string; body: string }>()
  for (const part of md.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const title = part.slice(0, nl).trim()
    sections.set(title.toLowerCase(), { title, body: part.slice(nl + 1).trim() })
  }
  return sections
}

/** Each "### question" becomes a collapsed card so you can answer before peeking. */
export function QuestionCards({ body, title, hint }: { body: string; title: string; hint?: string }) {
  const items = body
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const nl = part.indexOf('\n')
      return { q: part.slice(0, nl).trim(), a: part.slice(nl + 1).trim() }
    })
  return (
    <section className="follow-ups">
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      {items.map((it) => (
        <details key={it.q}>
          <summary>{it.q}</summary>
          <Md>{it.a}</Md>
        </details>
      ))}
    </section>
  )
}
