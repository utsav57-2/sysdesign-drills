import { useEffect, useId, useState } from 'react'

type Mermaid = typeof import('mermaid').default

let mermaidPromise: Promise<Mermaid> | null = null
let initializedFor: 'light' | 'dark' | null = null

function scheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Colors mirror the tokens in index.css so diagrams read as part of the page.
const THEMES = {
  light: {
    background: '#ffffff',
    primaryColor: '#f7f8f4',
    primaryBorderColor: '#1c2b39',
    primaryTextColor: '#1c2b39',
    secondaryColor: '#e3eafb',
    tertiaryColor: '#edf0ea',
    lineColor: '#4d5c69',
    textColor: '#1c2b39',
    clusterBkg: '#edf0ea',
    clusterBorder: '#d3d9d0',
    actorBkg: '#e3eafb',
    actorBorder: '#1f56d1',
    noteBkgColor: '#f7eedb',
    noteBorderColor: '#9a6400',
  },
  dark: {
    background: '#1f2932',
    primaryColor: '#1a232c',
    primaryBorderColor: '#a9b5bf',
    primaryTextColor: '#e4e9ed',
    secondaryColor: '#1d2b4a',
    tertiaryColor: '#141b22',
    lineColor: '#a9b5bf',
    textColor: '#e4e9ed',
    clusterBkg: '#141b22',
    clusterBorder: '#2f3b46',
    actorBkg: '#1d2b4a',
    actorBorder: '#6d97ff',
    noteBkgColor: '#33291a',
    noteBorderColor: '#e0ad4f',
  },
}

async function getMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidPromise
  const s = scheme()
  if (initializedFor !== s) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: "'Schibsted Grotesk', system-ui, sans-serif",
      themeVariables: { ...THEMES[s], fontSize: '14px' },
      flowchart: { curve: 'basis', padding: 12 },
      sequence: { mirrorActors: false },
    })
    initializedFor = s
  }
  return mermaid
}

export default function Diagram({ source }: { source: string }) {
  const id = 'd' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    getMermaid()
      .then((m) => m.render(id, source))
      .then(({ svg }) => !cancelled && setSvg(svg))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [id, source])

  if (error) {
    return (
      <div className="diagram-error">
        <p>This diagram couldn’t be drawn: {error}</p>
        <pre>{source}</pre>
      </div>
    )
  }
  if (!svg) return <div className="diagram loading">Drawing diagram…</div>
  // Mermaid sanitizes its output under securityLevel 'strict'.
  return (
    <>
      <button type="button" className="diagram" onClick={() => setExpanded(true)} title="Open full screen">
        <span dangerouslySetInnerHTML={{ __html: svg }} />
      </button>
      {expanded && (
        <div className="diagram-overlay" role="dialog" aria-label="Diagram" onClick={() => setExpanded(false)}
          onKeyDown={(e) => e.key === 'Escape' && setExpanded(false)} tabIndex={-1} ref={(el) => el?.focus()}>
          <div className="diagram-full" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="muted small">Click anywhere or press Esc to close</p>
        </div>
      )}
    </>
  )
}
