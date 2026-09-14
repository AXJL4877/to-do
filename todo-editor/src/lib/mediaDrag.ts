import { desktop } from './desktop'

const MIME = 'application/todo-media-id'
const PREFIX = 'todo-media:'

let draggingId: string | null = null
let lastDrop = { id: '', at: 0 }

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') draggingId = null
}

export function beginMediaDrag(dt: DataTransfer, mediaId: string) {
  draggingId = mediaId
  dt.setData(MIME, mediaId)
  dt.setData('text/plain', PREFIX + mediaId)
  dt.effectAllowed = 'copy'
  window.addEventListener('keydown', onEsc)
}

export function finishMediaDrag() {
  window.removeEventListener('keydown', onEsc)
  const id = draggingId
  draggingId = null
  if (id) desktop()?.endMediaDrag?.(id)
}

export function readMediaDrag(dt: DataTransfer): string | null {
  const custom = dt.getData(MIME)
  if (custom) return custom
  const plain = dt.getData('text/plain')
  if (plain.startsWith(PREFIX)) return plain.slice(PREFIX.length)
  return null
}

/** HTML5 drop 和 Electron 跨窗松手可能连发，只收一次 */
export function acceptMediaDrop(mediaId: string) {
  const now = Date.now()
  if (mediaId === lastDrop.id && now - lastDrop.at < 400) return false
  lastDrop = { id: mediaId, at: now }
  return true
}
