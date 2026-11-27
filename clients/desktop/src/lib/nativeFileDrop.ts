/**
 * Files dragged into the window from Finder / Explorer.
 *
 * Tauri's native drag-and-drop is on (`dragDropEnabled` default), so the WebView never sees an
 * external drag: no HTML5 `dragover`/`drop`, and a file dropped anywhere cannot open and replace
 * the page. Text drags are swallowed the same way, on purpose — text comes in by paste. What Tauri
 * hands over is each file's path, and it has already added those paths to the asset scope, so a
 * dropped file is cached by `cache_file` exactly like one chosen with「+ 导入」(no size cap, no
 * bytes through the WebView).
 *
 * One listener for the whole window; drop zones register an element and get the paths when the
 * drop lands inside it.
 */

export type FileDropEvent =
  | { type: 'enter' | 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' }

export interface FileDropZone {
  element: () => HTMLElement | null
  /** Whether a file drag is currently over this zone (for highlighting). */
  onHover?: (over: boolean) => void
  onDrop: (paths: string[]) => void
}

const zones = new Set<FileDropZone>()
let hovered: FileDropZone | null = null

/**
 * Tauri reports the position in physical pixels on Windows, but on macOS wry passes the AppKit
 * dragging location in points unchanged (already CSS pixels).
 */
export function toClientPoint(
  position: { x: number; y: number },
  scale: number,
  isMac: boolean,
): { x: number; y: number } {
  if (isMac || !scale) return { x: position.x, y: position.y }
  return { x: position.x / scale, y: position.y / scale }
}

function zoneAt(point: { x: number; y: number }): FileDropZone | null {
  const hit = document.elementFromPoint(point.x, point.y)
  if (!hit) return null
  for (const zone of zones) {
    const element = zone.element()
    if (element && element.contains(hit)) return zone
  }
  return null
}

function setHovered(next: FileDropZone | null) {
  if (next === hovered) return
  hovered?.onHover?.(false)
  hovered = next
  hovered?.onHover?.(true)
}

const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

/** Feeds one native drag event to the registered zones. Exported for the browser smoke harness. */
export function dispatchFileDrop(event: FileDropEvent) {
  if (event.type === 'leave') {
    setHovered(null)
    return
  }
  const zone = zoneAt(toClientPoint(event.position, window.devicePixelRatio, isMacPlatform()))
  if (event.type !== 'drop') {
    setHovered(zone)
    return
  }
  setHovered(null)
  if (zone && event.paths.length > 0) zone.onDrop(event.paths)
}

export function registerFileDropZone(zone: FileDropZone): () => void {
  zones.add(zone)
  return () => {
    zones.delete(zone)
    if (hovered === zone) hovered = null
  }
}

/** Starts listening to Tauri's drag-drop events; a no-op outside Tauri. Call once at startup. */
export async function startNativeFileDrop(): Promise<void> {
  const { isTauri } = await import('../api/agent/runtime')
  if (!isTauri()) return
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'leave') dispatchFileDrop({ type: 'leave' })
    else if (payload.type === 'drop') dispatchFileDrop({ type: 'drop', paths: payload.paths, position: payload.position })
    else dispatchFileDrop({ type: payload.type, position: payload.position })
  })
}
