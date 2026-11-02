/** Renders a saved whiteboard scene to a PNG data URL, or '' if it is empty. */
export async function sceneToPng(scene: string): Promise<string> {
  if (!scene) return ''
  const { exportToBlob, restore } = await import('@excalidraw/excalidraw')
  const restored = restore(JSON.parse(scene), null, null)
  const elements = restored.elements.filter((el) => !el.isDeleted)
  if (elements.length === 0) return ''
  const blob = await exportToBlob({
    elements,
    appState: { ...restored.appState, exportBackground: true, viewBackgroundColor: '#ffffff' },
    files: restored.files,
    mimeType: 'image/png',
    maxWidthOrHeight: 1600,
  })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
