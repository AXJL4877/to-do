import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../store'
import { resolveClipTransform } from '../lib/keyframeEval'

let lastPointer: { x: number; y: number } | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY } }, { passive: true, capture: true })
}

/** 选中片段中心在屏幕上的位置（编辑窗优先，object-fit:contain 的留边算进去） */
function clipPivot(): { x: number; y: number } | null {
  const s = useApp.getState()
  const clip = s.seq().clips.find((c) => s.selectedClipIds.includes(c.id))
  if (!clip) return null
  const canvas =
    document.querySelector<HTMLCanvasElement>('[data-testid="edit-canvas"]')
    ?? document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas"]')
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const k = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const dw = canvas.width * k
  const dh = canvas.height * k
  const ox = rect.left + (rect.width - dw) / 2
  const oy = rect.top + (rect.height - dh) / 2
  const tr = resolveClipTransform(clip, s.playhead)
  return { x: ox + ((tr.x + 1) / 2) * dw, y: oy + ((tr.y + 1) / 2) * dh }
}

type Hud = { x: number; y: number; text: string }

/** S / R：移动鼠标直接缩放 / 旋转选中片段；左键确定，右键或 Esc 取消 */
export function TransformGesture() {
  const gesture = useApp((s) => s.transformGesture)
  const [hud, setHud] = useState<Hud | null>(null)
  const [pivot, setPivot] = useState<{ x: number; y: number } | null>(null)
  const handlers = useRef<{
    move: (x: number, y: number, mods: { shift: boolean; ctrl: boolean }) => void
  } | null>(null)
  const finishRef = useRef<((commit: boolean) => void) | null>(null)

  useEffect(() => {
    if (!gesture) {
      handlers.current = null
      setHud(null)
      setPivot(null)
      return
    }
    const st = useApp.getState()
    const clip = st.seq().clips.find((c) => st.selectedClipIds.includes(c.id))
    const live = clip ? resolveClipTransform(clip, st.playhead) : null
    const origin = gesture.prop === 'scale' ? (live?.scaleX ?? 1) : (live?.rotation ?? 0)
    const pv = clipPivot()
    const start = lastPointer ?? (pv ? { x: pv.x + 120, y: pv.y } : { x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const r0 = pv ? Math.hypot(start.x - pv.x, start.y - pv.y) : 0
    const radial = !!pv && r0 > 24
    let prevAngle = pv ? Math.atan2(start.y - pv.y, start.x - pv.x) : 0
    let accAngle = 0
    let raf = 0
    let pending: number | null = null
    setPivot(radial || gesture.prop === 'rotation' ? pv : null)

    const label = (amount: number) => {
      const tag = gesture.keyed ? ' · K' : ''
      if (gesture.prop === 'scale') return `缩放 ${Math.round(origin * amount * 100)}%${tag}`
      return `旋转 ${(origin + amount).toFixed(1)}°${tag}`
    }

    const move = (x: number, y: number, mods: { shift: boolean; ctrl: boolean }) => {
      let amount: number
      if (gesture.prop === 'scale') {
        let f = radial && pv ? Math.hypot(x - pv.x, y - pv.y) / r0 : 2 ** ((x - start.x) / 150)
        if (mods.shift) f = 1 + (f - 1) * 0.2
        if (mods.ctrl && origin > 1e-6) f = Math.max(0.05, Math.round((origin * f) / 0.05) * 0.05) / origin
        amount = Math.max(0.01 / Math.max(origin, 1e-6), f)
      } else {
        let deg: number
        if (pv) {
          const a = Math.atan2(y - pv.y, x - pv.x)
          let d = a - prevAngle
          if (d > Math.PI) d -= 2 * Math.PI
          if (d < -Math.PI) d += 2 * Math.PI
          accAngle += d
          prevAngle = a
          deg = (accAngle * 180) / Math.PI
        } else {
          deg = (x - start.x) * 0.5
        }
        if (mods.shift) deg *= 0.2
        if (mods.ctrl) deg = Math.round((origin + deg) / 15) * 15 - origin
        amount = deg
      }
      setHud({ x, y, text: label(amount) })
      pending = amount
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          if (pending != null) useApp.getState().updateTransformGesture(pending)
        })
      }
    }
    handlers.current = { move }
    setHud({ x: start.x, y: start.y, text: label(gesture.prop === 'scale' ? 1 : 0) })

    const flush = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (pending != null) useApp.getState().updateTransformGesture(pending)
      pending = null
    }
    const finish = (commit: boolean) => {
      if (commit) flush()
      else if (raf) cancelAnimationFrame(raf)
      useApp.getState().endTransformGesture(commit)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
        if (lastPointer) move(lastPointer.x, lastPointer.y, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.type !== 'keydown') return
      if (e.key === 'Escape') finish(false)
      else if (e.key === 'Enter' || e.key === ' ') finish(true)
    }
    const onBlur = () => finish(true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    finishRef.current = finish
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
      if (raf) cancelAnimationFrame(raf)
      finishRef.current = null
    }
  }, [gesture])

  if (!gesture) return null
  const cursor = gesture.prop === 'scale' ? 'nwse-resize' : 'grabbing'
  return createPortal(
    <div
      className="fixed inset-0 z-[9999]"
      style={{ cursor, userSelect: 'none' }}
      data-testid="transform-gesture"
      onPointerMove={(e) => handlers.current?.move(e.clientX, e.clientY, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.button === 2) { finishRef.current?.(false); return }
        if (e.button === 0) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerUp={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        finishRef.current?.(true)
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {pivot && hud && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
          <line x1={pivot.x} y1={pivot.y} x2={hud.x} y2={hud.y} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 4" />
          <circle cx={pivot.x} cy={pivot.y} r="4" fill="var(--accent)" />
        </svg>
      )}
      {hud && (
        <div
          className="absolute pointer-events-none rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap shadow"
          style={{
            left: hud.x + 16, top: hud.y + 16,
            background: 'var(--surface-ink, #1b1b1b)', color: 'var(--text-on-ink, #fff)',
          }}
          data-testid="transform-gesture-hud"
        >
          <div className="tabular-nums">{hud.text}</div>
          <div className="opacity-60 text-[10px]">左键确定 · 右键/Esc 取消 · Shift 微调 · Ctrl 吸附</div>
        </div>
      )}
    </div>,
    document.body,
  )
}
