import { useMemo, useRef } from 'react'
import { Excalidraw, restore, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

interface Props {
  scene: string
  onChange: (scene: string) => void
}

// Loaded lazily: Excalidraw is by far the largest dependency.
export default function Whiteboard({ scene, onChange }: Props) {
  const initialData = useMemo(() => {
    if (!scene) return { appState: { viewBackgroundColor: '#ffffff' } }
    try {
      const restored = restore(JSON.parse(scene), null, null)
      return { elements: restored.elements, appState: { viewBackgroundColor: restored.appState.viewBackgroundColor }, files: restored.files }
    } catch {
      return { appState: { viewBackgroundColor: '#ffffff' } }
    }
    // Only the first scene seeds the canvas; later changes come from the canvas itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // onChange fires on every pointer move; only report real edits.
  const lastVersion = useRef<number | null>(null)

  return (
    <div className="whiteboard">
      <Excalidraw
        initialData={initialData}
        onChange={(elements, appState, files) => {
          const version = elements.reduce((sum, el) => sum + el.version, 0) + elements.length
          if (lastVersion.current === null) {
            lastVersion.current = version
            return
          }
          if (version === lastVersion.current) return
          lastVersion.current = version
          onChange(serializeAsJSON(elements, appState, files, 'local'))
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
      />
    </div>
  )
}
