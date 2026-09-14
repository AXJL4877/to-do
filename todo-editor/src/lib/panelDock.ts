import type { PointerEvent as ReactPointerEvent } from 'react'

export type DockSlot = 'left' | 'right' | 'bottom'
export type DockPanel = 'media' | 'ai'
export type AiDock = DockSlot | 'tab'

export type PanelDock = {
  media: DockSlot
  ai: AiDock
}

export const defaultPanelDock: PanelDock = { media: 'left', ai: 'tab' }

export function panelsIn(slot: DockSlot, dock: PanelDock): DockPanel[] {
  const ids: DockPanel[] = []
  if (dock.media === slot) ids.push('media')
  if (dock.ai === slot) ids.push('ai')
  return ids
}

export function hitDockSlot(x: number, y: number, rect: DOMRect): DockSlot | null {
  const rx = (x - rect.left) / Math.max(1, rect.width)
  const ry = (y - rect.top) / Math.max(1, rect.height)
  if (ry > 0.7) return 'bottom'
  if (rx < 0.2) return 'left'
  if (rx > 0.8) return 'right'
  return null
}

let lastArmedAt = 0
type DragState = { id: DockPanel; hover: DockSlot | null }

export function shouldIgnoreDockClick() {
  if (Date.now() - lastArmedAt > 400) return false
  lastArmedAt = 0
  return true
}

let drag: DragState | null = null
const subs = new Set<() => void>()

function emit() {
  for (const cb of subs) cb()
}

export function getDockDrag() {
  return drag
}

export function subscribeDockDrag(cb: () => void) {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** 从面板标题开始拖，松手落到左/右/下停靠区 */
export function beginDockDrag(id: DockPanel, e: ReactPointerEvent, onDrop: (slot: DockSlot) => void) {
  if (e.button !== 0) return
  const startX = e.clientX
  const startY = e.clientY
  let armed = false

  const move = (ev: PointerEvent) => {
    if (!armed) {
      if (Math.abs(ev.clientX - startX) < 8 && Math.abs(ev.clientY - startY) < 8) return
      armed = true
      drag = { id, hover: null }
      emit()
    }
    const host = document.querySelector('[data-testid="workspace"]')
    const rect = host?.getBoundingClientRect()
    const hover = rect ? hitDockSlot(ev.clientX, ev.clientY, rect) : null
    if (!drag || drag.hover === hover) return
    drag = { id, hover }
    emit()
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const slot = drag?.hover
    const did = armed
    drag = null
    emit()
    if (did) lastArmedAt = Date.now()
    if (did && slot) onDrop(slot)
    ev.preventDefault()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
