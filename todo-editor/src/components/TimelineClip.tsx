import { memo, useMemo, useRef } from 'react'
import clsx from 'clsx'
import type { Clip, Track } from '../types'
import { useApp } from '../store'

function Waveform({ seed }: { seed: string }) {
  const bars = Array.from({ length: 24 }, (_, i) => {
    let h = 0.3
    for (let j = 0; j < seed.length; j++) h += (seed.charCodeAt(j) * (i + 1) * (j + 3)) % 17 / 34
    return Math.min(0.95, 0.2 + (h % 0.75))
  })
  return (
    <svg className="absolute inset-x-0 bottom-0 h-[55%] opacity-50 pointer-events-none" preserveAspectRatio="none" viewBox="0 0 24 10">
      {bars.map((h, i) => (
        <rect key={i} x={i} y={10 - h * 10} width={0.85} height={h * 10} fill="currentColor" />
      ))}
    </svg>
  )
}

/** 根据转场 / 入出场动画 / 音频淡化 / 透明度关键帧，算左右渐变 */
function edgeHints(clip: Clip, widthPx: number) {
  const dur = Math.max(0.05, clip.duration)
  const toPx = (sec: number) =>
    Math.min(widthPx * 0.48, Math.max(10, (Math.min(sec, dur * 0.9) / dur) * widthPx))

  let inSec = 0
  let outSec = 0
  let inLabel = ''
  let outLabel = ''

  if (clip.transitionIn && clip.transitionIn.duration > 0) {
    inSec = Math.max(inSec, clip.transitionIn.duration)
    inLabel = `转场入 · ${clip.transitionIn.type}`
  }
  if (clip.transitionOut && clip.transitionOut.duration > 0) {
    outSec = Math.max(outSec, clip.transitionOut.duration)
    outLabel = `转场出 · ${clip.transitionOut.type}`
  }

  const tin = clip.text
  if (tin?.animIn && tin.animIn !== 'none') {
    inSec = Math.max(inSec, tin.animInDur ?? 0.8)
    inLabel = inLabel || `入场 · ${tin.animIn}`
  }
  if (tin?.animOut && tin.animOut !== 'none') {
    outSec = Math.max(outSec, tin.animOutDur ?? 0.4)
    outLabel = outLabel || `出场 · ${tin.animOut}`
  }

  if (clip.audio?.fadeIn > 0) {
    inSec = Math.max(inSec, clip.audio.fadeIn)
    inLabel = inLabel || '淡入'
  }
  if (clip.audio?.fadeOut > 0) {
    outSec = Math.max(outSec, clip.audio.fadeOut)
    outLabel = outLabel || '淡出'
  }

  const op = clip.keyframes.opacity
  if (op && op.length >= 2) {
    const sorted = [...op].sort((a, b) => a.t - b.t)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (first.t <= 0.08 && first.value < 0.2) {
      const rise = sorted.find((k) => k.value >= 0.5) ?? sorted[1]
      inSec = Math.max(inSec, Math.max(0.05, rise.t - first.t))
      inLabel = inLabel || '淡入'
    }
    if (last.t >= dur - 0.08 && last.value < 0.2) {
      const fall = [...sorted].reverse().find((k) => k.value >= 0.5) ?? sorted[sorted.length - 2]
      outSec = Math.max(outSec, Math.max(0.05, last.t - fall.t))
      outLabel = outLabel || '淡出'
    }
  }

  for (const key of ['x', 'y', 'scale'] as const) {
    const kf = clip.keyframes[key]
    if (!kf || kf.length < 2 || inSec > 0) continue
    const sorted = [...kf].sort((a, b) => a.t - b.t)
    if (sorted[0].t <= 0.08 && sorted[1].t - sorted[0].t > 0.05) {
      inSec = Math.max(inSec, sorted[1].t - sorted[0].t)
      inLabel = inLabel || '入场动画'
    }
  }

  return {
    inSec,
    outSec,
    inPx: inSec > 0.03 ? toPx(inSec) : 0,
    outPx: outSec > 0.03 ? toPx(outSec) : 0,
    inLabel: inSec > 0.03 ? `${inLabel} ${inSec.toFixed(2)}s · 拖边缘调时长` : '',
    outLabel: outSec > 0.03 ? `${outLabel} ${outSec.toFixed(2)}s · 拖边缘调时长` : '',
  }
}

type Props = {
  clip: Clip
  track: Track
  selected: boolean
  tool: string
  left: number
  width: number
  onPointerDown: (e: React.PointerEvent) => void
  onTrimIn: (e: React.PointerEvent) => void
  onTrimOut: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}

export const TimelineClip = memo(function TimelineClip({
  clip, track, selected, tool, left, width,
  onPointerDown, onTrimIn, onTrimOut, onContextMenu,
}: Props) {
  const resizeEdgeAnim = useApp((s) => s.resizeEdgeAnim)
  const drag = useRef<{ edge: 'in' | 'out'; startX: number; originSec: number } | null>(null)

  const bg = clip.text
    ? 'hsl(32 70% 48% / 0.25)'
    : track.kind === 'audio'
      ? 'hsl(158 45% 40% / 0.25)'
      : 'hsl(200 55% 48% / 0.25)'

  const w = Math.max(24, width)
  const hints = useMemo(() => edgeHints(clip, w), [clip, w])
  const pxPerSec = w / Math.max(0.05, clip.duration)

  function onAnimHandleDown(e: React.PointerEvent, edge: 'in' | 'out') {
    e.stopPropagation()
    e.preventDefault()
    const originSec = edge === 'in' ? hints.inSec : hints.outSec
    drag.current = { edge, startX: e.clientX, originSec }
    resizeEdgeAnim(clip.id, edge, originSec, { record: true })
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dx = ev.clientX - d.startX
      const deltaSec = (edge === 'in' ? dx : -dx) / pxPerSec
      resizeEdgeAnim(clip.id, edge, d.originSec + deltaSec, { record: false })
    }
    const onUp = (ev: PointerEvent) => {
      drag.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      try { el.releasePointerCapture(ev.pointerId) } catch { /* already released */ }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={clsx('absolute top-1 bottom-1 rounded-md overflow-hidden border group', selected && 'ring-2')}
      style={{
        left, width: w,
        background: bg,
        borderColor: selected ? 'var(--accent)' : 'var(--border)',
        opacity: clip.enabled ? 1 : 0.4,
        cursor: tool === 'razor' ? 'inherit' : tool === 'hand' ? 'grab' : 'grab',
        color: track.kind === 'audio' ? 'hsl(158 45% 30%)' : undefined,
      }}
      data-testid={`clip-${clip.id}`}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        useApp.getState().openPropWheelOnMonitor()
      }}
      onContextMenu={onContextMenu}
      title="1 静态 · 2 K帧模式 · 3 转场；K帧下 S缩放 T透明"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 z-20"
        style={{ background: 'var(--accent)' }}
        data-testid={`clip-trim-in-${clip.id}`}
        onPointerDown={onTrimIn}
      />
      <div
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 z-20"
        style={{ background: 'var(--accent)' }}
        data-testid={`clip-trim-out-${clip.id}`}
        onPointerDown={onTrimOut}
      />

      {hints.inPx > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 z-[1]"
          style={{
            width: hints.inPx,
            background: 'linear-gradient(90deg, hsl(24 85% 52% / 0.55), hsl(24 85% 52% / 0.12), transparent)',
          }}
          title={hints.inLabel}
          data-testid={`clip-anim-in-${clip.id}`}
        >
          <div
            className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-[3] opacity-70 group-hover:opacity-100"
            style={{ background: 'linear-gradient(90deg, transparent, hsl(24 85% 45% / 0.85))' }}
            data-testid={`clip-anim-in-handle-${clip.id}`}
            title={hints.inLabel}
            onPointerDown={(e) => onAnimHandleDown(e, 'in')}
          />
        </div>
      )}
      {hints.outPx > 0 && (
        <div
          className="absolute right-0 top-0 bottom-0 z-[1]"
          style={{
            width: hints.outPx,
            background: 'linear-gradient(90deg, transparent, hsl(24 85% 52% / 0.12), hsl(24 85% 52% / 0.55))',
          }}
          title={hints.outLabel}
          data-testid={`clip-anim-out-${clip.id}`}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-[3] opacity-70 group-hover:opacity-100"
            style={{ background: 'linear-gradient(90deg, hsl(24 85% 45% / 0.85), transparent)' }}
            data-testid={`clip-anim-out-handle-${clip.id}`}
            title={hints.outLabel}
            onPointerDown={(e) => onAnimHandleDown(e, 'out')}
          />
        </div>
      )}

      {track.kind === 'audio' && <Waveform seed={clip.id} />}
      <span className="text-[10px] font-medium truncate block px-1.5 pt-0.5 pointer-events-none relative z-[2]">{clip.name}</span>
    </div>
  )
})
