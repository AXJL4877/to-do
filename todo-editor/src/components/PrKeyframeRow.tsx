import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NumInput } from './NumInput'
import {
  defaultHandles,
  sampleCurvePoints,
  sampleKeyframes,
  valueRange,
} from '../lib/keyframeEval'
import type { Clip, Ease, Keyframe, KfHandle } from '../types'
import { useApp } from '../store'
import { clearKfDeleteContext, setKfDeleteContext } from '../lib/kfDelete'
import { setLocalPlayheadScrubbing } from '../lib/storeSync'
import { KfPlayheadLine } from './PlayheadOverlay'

export { tryDeletePickedKeyframes } from '../lib/kfDelete'

const EASE_PRESETS: { id: Ease; label: string }[] = [
  { id: 'linear', label: '线性' },
  { id: 'easeIn', label: '缓入' },
  { id: 'easeOut', label: '缓出' },
  { id: 'easeInOut', label: '缓入出' },
  { id: 'hold', label: '定格' },
  { id: 'bezier', label: '曲线' },
]

type Props = {
  prop: string
  label: string
  clip: Clip
  playhead: number
  displayValue: number
  min?: number
  max?: number
  step?: number
  unit?: string
  defaultValue?: number
  testId?: string
  toStore?: (ui: number) => number
  toUi?: (stored: number) => number
  /** 只渲染数值+缓动，曲线由图层单独放 */
  hideGraph?: boolean
  /** 不显示缓动预设（XY 共用一条时用） */
  hideEase?: boolean
  /** 只渲染曲线图（与时间轴同宽：绝对时间） */
  graphOnly?: boolean
  /** 与时间线同步时的像素/秒；有则图宽由父级决定 */
  pxPerSec?: number
  /** 时间轴总时长（秒）；与 clipStart 一起做绝对定位 */
  timelineSpan?: number
  onChange: (stored: number) => void
  onToggleKeyframe: (prop: string, value: number) => void
  onGotoAdjacent: (prop: string, dir: -1 | 1) => void
  onSeek: (absoluteT: number) => void
  onMoveKeyframe: (prop: string, kfId: string, localT: number) => void
  onSetEase?: (prop: string, kfId: string, ease: Ease) => void
  onSetHandle?: (prop: string, kfId: string, which: 'oh' | 'ih', handle: KfHandle) => void
  onEnableBezier?: (prop: string, kfId: string) => void
  /** 删除框选/多选关键帧（Delete） */
  onRemoveKeyframes?: (ids: string[]) => void
}

/** 关键帧行：数值 + 缓动预设（默认线性）+ 简易曲线；仅「曲线」模式显示可拖杠杆 */
export function PrKeyframeRow({
  prop, label, clip, playhead, displayValue,
  min, max, step, unit, defaultValue, testId,
  toStore = (v) => v, toUi = (v) => v,
  hideGraph, graphOnly, hideEase, pxPerSec, timelineSpan,
  onChange, onToggleKeyframe, onGotoAdjacent, onSeek, onMoveKeyframe, onSetEase,
  onSetHandle, onEnableBezier, onRemoveKeyframes,
}: Props) {
  const fps = useApp((s) => s.settings.fps)
  const frames = clip.keyframes[prop] ?? []
  // 用原始局部时间匹配关键帧（点选时 exact seek，勿再按帧取整以免竖线偏半帧）
  const rawLocal = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const near = 0.51 / Math.max(1, fps)
  const armed = frames.length > 0
  const stripRef = useRef<HTMLDivElement>(null)
  const uiValue = toUi(displayValue)
  const sorted = useMemo(() => [...frames].sort((a, b) => a.t - b.t), [frames])
  const selected = sorted.find((f) => Math.abs(f.t - rawLocal) < near) ?? null
  const active = !!selected
  const easeTarget = useMemo(() => {
    if (!selected) return null
    const i = sorted.findIndex((k) => k.id === selected.id)
    if (i < 0) return null
    if (i < sorted.length - 1) return selected
    if (i > 0) return sorted[i - 1]
    return selected
  }, [selected, sorted])

  const showHandles = !!(easeTarget?.ease === 'bezier' && onSetHandle)
  const span = timelineSpan ?? clip.duration
  const synced = pxPerSec != null
  const graph = armed && (
    <KeyframeGraph
      prop={prop}
      frames={frames}
      duration={clip.duration}
      clipStart={synced ? clip.start : 0}
      absStart={clip.start}
      spanDuration={synced ? span : clip.duration}
      stripRef={stripRef}
      showHandles={showHandles}
      synced={synced}
      selectedId={selected?.id ?? null}
      onSeekAbs={(t) => onSeek(synced ? t : clip.start + t)}
      onMoveKeyframe={(id, t) => onMoveKeyframe(prop, id, t)}
      onSeekLocal={(t) => useApp.getState().setPlayhead(clip.start + t, { exact: true })}
      onSetHandle={onSetHandle ? (id, which, h) => onSetHandle(prop, id, which, h) : undefined}
      onEnableBezier={onEnableBezier ? (id) => onEnableBezier(prop, id) : undefined}
      onRemoveKeyframes={onRemoveKeyframes}
    />
  )

  if (graphOnly) {
    return (
      <div className="pr-kf-row pr-kf-row--graph-only h-full" data-testid={testId ? `${testId}-row` : `kf-row-${prop}`}>
        {graph}
      </div>
    )
  }

  return (
    <div className="pr-kf-row" data-testid={testId ? `${testId}-row` : `kf-row-${prop}`}>
      <div className="flex items-start gap-0.5">
        <div className="flex items-center shrink-0 mt-0.5">
          <button type="button" className="pr-kf-nav" title="上一关键帧" data-testid={`kf-prev-${prop}`} disabled={!armed} onClick={() => onGotoAdjacent(prop, -1)}>
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            className={clsx(
              'w-6 h-6 grid place-items-center rounded border transition-colors',
              active
                ? 'border-[hsl(18_76%_46%/0.4)] bg-[var(--accent-dim)] text-[var(--accent)]'
                : armed
                  ? 'border-[var(--border)] text-[var(--accent)] bg-[var(--surface-1)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] bg-[var(--surface-1)] hover:text-[var(--accent)]',
            )}
            title={active ? '删除播放头处关键帧' : '在播放头添加关键帧'}
            data-testid={`kf-btn-${prop}`}
            onClick={() => onToggleKeyframe(prop, displayValue)}
          >
            <Diamond size={11} strokeWidth={active ? 2.25 : 1.75} fill={active ? 'currentColor' : 'none'} />
          </button>
          <button type="button" className="pr-kf-nav" title="下一关键帧" data-testid={`kf-next-${prop}`} disabled={!armed} onClick={() => onGotoAdjacent(prop, 1)}>
            <ChevronRight size={12} />
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <NumInput
            label={label}
            value={Number.isFinite(uiValue) ? uiValue : 0}
            min={min}
            max={max}
            step={step}
            unit={unit}
            defaultValue={defaultValue}
            testId={testId}
            onChange={(v) => onChange(toStore(v))}
          />
        </div>
      </div>

      {armed && onSetEase && !hideEase && (
        <div className="pr-kf-ease" data-testid={`kf-ease-${prop}`}>
          <div className="pr-kf-ease-btns">
            {EASE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={clsx('pr-kf-ease-btn', easeTarget?.ease === p.id && 'active')}
                disabled={!easeTarget}
                data-testid={`kf-ease-${prop}-${p.id}`}
                onClick={() => easeTarget && onSetEase(prop, easeTarget.id, p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!hideGraph && graph}
    </div>
  )
}

function KeyframeGraph({
  prop, frames, duration, clipStart, absStart, spanDuration, stripRef, showHandles, synced, selectedId,
  onSeekAbs, onMoveKeyframe, onSeekLocal, onSetHandle, onEnableBezier, onRemoveKeyframes,
}: {
  prop: string
  frames: Keyframe[]
  duration: number
  clipStart: number
  absStart: number
  spanDuration: number
  stripRef: React.RefObject<HTMLDivElement | null>
  showHandles: boolean
  synced?: boolean
  selectedId: string | null
  onSeekAbs: (absoluteT: number) => void
  onMoveKeyframe: (id: string, localT: number) => void
  onSeekLocal: (localT: number) => void
  onSetHandle?: (id: string, which: 'oh' | 'ih', handle: KfHandle) => void
  onEnableBezier?: (id: string) => void
  onRemoveKeyframes?: (ids: string[]) => void
}) {
  const sorted = useMemo(() => [...frames].sort((a, b) => a.t - b.t), [frames])
  const curve = useMemo(() => sampleCurvePoints(sorted, duration, 48), [sorted, duration])
  const { vmin, vmax } = useMemo(() => valueRange(sorted), [sorted])
  const [picked, setPicked] = useState<string[]>([])
  const [box, setBox] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null)
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const span = Math.max(1e-6, spanDuration)

  // 局部时间 → 图上 0..1（对齐整条时间轴）
  const xOf = (local: number) => (clipStart + local) / span

  // 每帧同步 Delete 上下文（勿放 effect，避免回调抖动把注册清掉）
  setKfDeleteContext({
    picked,
    selectedId,
    remove: onRemoveKeyframes ?? null,
  })
  useEffect(() => () => clearKfDeleteContext(), [])

  // 帧列表变化时清掉已不存在的选中 id
  useEffect(() => {
    const alive = new Set(frames.map((f) => f.id))
    setPicked((prev) => {
      const next = prev.filter((id) => alive.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [frames])

  // 播放头附近的点纳入选中，便于 Delete；Ctrl 多选保留
  useEffect(() => {
    if (!selectedId) return
    setPicked((prev) => (prev.includes(selectedId) ? prev : [selectedId]))
  }, [selectedId])

  const selected = selectedId ? sorted.find((k) => k.id === selectedId) ?? null : null
  const selIdx = selected ? sorted.findIndex((k) => k.id === selected.id) : -1
  const pathD = curve.map((p, i) => {
    const x = xOf(p.x * duration) * 100
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(p.y * 100).toFixed(2)}`
  }).join(' ')

  function toNorm(k: Keyframe) {
    return {
      x: xOf(k.t),
      y: 1 - (k.value - vmin) / (vmax - vmin),
    }
  }

  function handlePos(k: Keyframe, which: 'oh' | 'ih', neighbor: Keyframe) {
    const d = defaultHandles('linear')
    const h = which === 'oh' ? (k.oh ?? d.oh) : (k.ih ?? d.ih)
    const a = which === 'oh' ? k : neighbor
    const b = which === 'oh' ? neighbor : k
    const spanT = b.t - a.t
    const spanV = b.value - a.value
    const tx = k.t + h.x * spanT
    const ty = k.value + h.y * spanV
    return {
      x: xOf(tx),
      y: 1 - (ty - vmin) / (vmax - vmin),
    }
  }

  function clientToLocalT(clientX: number, el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return r * span - clipStart
  }

  function startHandleDrag(e: React.PointerEvent, kf: Keyframe, which: 'oh' | 'ih', neighbor: Keyframe) {
    if (!onSetHandle) return
    e.preventDefault()
    e.stopPropagation()
    onEnableBezier?.(kf.id)
    const el = stripRef.current
    if (!el || duration <= 0) return
    const a = which === 'oh' ? kf : neighbor
    const b = which === 'oh' ? neighbor : kf
    const spanT = Math.max(1e-6, b.t - a.t)
    const spanV = b.value - a.value
    const spanVSafe = Math.abs(spanV) < 1e-9 ? 1 : spanV

    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      const tLocal = clientToLocalT(ev.clientX, el)
      const vAbs = vmax - ny * (vmax - vmin)
      if (which === 'oh') {
        onSetHandle(kf.id, 'oh', {
          x: Math.max(0.02, Math.min(0.98, (tLocal - kf.t) / spanT)),
          y: (vAbs - kf.value) / spanVSafe,
        })
      } else {
        onSetHandle(kf.id, 'ih', {
          x: Math.max(-0.98, Math.min(-0.02, (tLocal - kf.t) / spanT)),
          y: (vAbs - kf.value) / spanVSafe,
        })
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function hitsInBox(x0: number, y0: number, x1: number, y1: number) {
    const el = stripRef.current
    if (!el) return [] as string[]
    const rect = el.getBoundingClientRect()
    const left = (Math.min(x0, x1) - rect.left) / rect.width
    const right = (Math.max(x0, x1) - rect.left) / rect.width
    const top = (Math.min(y0, y1) - rect.top) / rect.height
    const bottom = (Math.max(y0, y1) - rect.top) / rect.height
    return sorted.filter((f) => {
      const p = toNorm(f)
      return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
    }).map((f) => f.id)
  }

  return (
    <div
      ref={stripRef}
      className={clsx('pr-kf-graph', showHandles && 'pr-kf-graph--bezier', synced && 'pr-kf-graph--synced')}
      data-testid={`kf-strip-${prop}`}
      title="拖空白处 scrub · 拖菱形 · Ctrl+拖框选 · Ctrl+点多选"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement).closest('[data-kf-id],[data-kf-handle]')) return
        const el = stripRef.current
        if (!el) return
        const ctrl = e.ctrlKey || e.metaKey
        if (ctrl) {
          e.preventDefault()
          const x0 = e.clientX
          const y0 = e.clientY
          const base = [...picked]
          setBox({ x0, y0, x1: x0, y1: y0 })
          const onMove = (ev: PointerEvent) => {
            setBox({ x0, y0, x1: ev.clientX, y1: ev.clientY })
            const hits = hitsInBox(x0, y0, ev.clientX, ev.clientY)
            setPicked([...new Set([...base, ...hits])])
          }
          const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            setBox(null)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          return
        }
        setPicked([])
        const seekFromClientX = (clientX: number) => {
          const node = stripRef.current
          if (!node) return
          const rct = node.getBoundingClientRect()
          const r = Math.max(0, Math.min(1, (clientX - rct.left) / Math.max(1e-6, rct.width)))
          onSeekAbs(r * span)
        }
        setLocalPlayheadScrubbing(true)
        seekFromClientX(e.clientX)
        const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX)
        const onUp = () => {
          setLocalPlayheadScrubbing(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }}
    >
      {/* 片段区间高亮，其余铺满时间轴背景 */}
      {synced && duration > 0 && (
        <div
          className="pr-kf-clip-band"
          data-testid="kf-clip-lane"
          style={{ left: `${(clipStart / span) * 100}%`, width: `${(duration / span) * 100}%` }}
        />
      )}

      <svg className="pr-kf-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.9" />
        {showHandles && selected && selIdx >= 0 && selIdx < sorted.length - 1 && (() => {
          const n = sorted[selIdx + 1]
          const p0 = toNorm(selected)
          const h = handlePos(selected, 'oh', n)
          return (
            <line
              x1={p0.x * 100} y1={p0.y * 100}
              x2={h.x * 100} y2={h.y * 100}
              stroke="var(--accent)" strokeWidth="1.5" opacity="0.55"
              vectorEffect="non-scaling-stroke"
            />
          )
        })()}
      </svg>

      <KfPlayheadLine
        mapT={(absT) => (synced ? absT : Math.max(0, absT - absStart)) / span}
      />

      {box && stripRef.current && (() => {
        const rect = stripRef.current.getBoundingClientRect()
        const l = Math.min(box.x0, box.x1) - rect.left
        const t = Math.min(box.y0, box.y1) - rect.top
        const w = Math.abs(box.x1 - box.x0)
        const h = Math.abs(box.y1 - box.y0)
        return (
          <div
            className="pr-kf-marquee"
            data-testid="kf-marquee"
            style={{ left: l, top: t, width: w, height: h }}
          />
        )
      })()}

      {sorted.map((f) => {
        const y = 1 - (f.value - vmin) / (vmax - vmin)
        const isSel = picked.includes(f.id) || selected?.id === f.id
        return (
          <button
            key={f.id}
            type="button"
            data-kf-id={f.id}
            className={clsx('pr-kf-mark', isSel && 'selected')}
            style={{ left: `${xOf(f.t) * 100}%`, top: `${y * 100}%` }}
            title={`${f.t.toFixed(2)}s · ${f.ease}`}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const ctrl = e.ctrlKey || e.metaKey
              if (ctrl) {
                setPicked((prev) =>
                  prev.includes(f.id) ? prev.filter((id) => id !== f.id) : [...prev, f.id],
                )
                onSeekLocal(f.t)
                return
              }
              const group = picked.includes(f.id) && picked.length > 1 ? picked : [f.id]
              setPicked(group)
              onSeekLocal(f.t)
              const originT = f.t
              const origins = Object.fromEntries(
                group.map((id) => {
                  const k = sorted.find((x) => x.id === id)
                  return [id, k?.t ?? originT]
                }),
              )
              const onMove = (ev: PointerEvent) => {
                const el = stripRef.current
                if (!el || duration <= 0) return
                const newT = clientToLocalT(ev.clientX, el)
                const dt = newT - originT
                for (const id of group) {
                  onMoveKeyframe(id, Math.max(0, Math.min(duration, origins[id] + dt)))
                }
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
          >
            <Diamond size={12} fill="currentColor" strokeWidth={0} />
          </button>
        )
      })}

      {showHandles && selected && selIdx >= 0 && selIdx < sorted.length - 1 && onSetHandle && (() => {
        const n = sorted[selIdx + 1]
        const h = handlePos(selected, 'oh', n)
        return (
          <button
            type="button"
            data-kf-handle="oh"
            className="pr-kf-handle"
            style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }}
            title="拖动调整曲线"
            data-testid={`kf-handle-oh-${prop}`}
            onPointerDown={(e) => startHandleDrag(e, selected, 'oh', n)}
          />
        )
      })()}
    </div>
  )
}

export function livePropValue(clip: Clip, prop: string, playhead: number): number {
  const localT = Math.max(0, playhead - clip.start)
  const tr = clip.transform
  switch (prop) {
    case 'x': return sampleKeyframes(clip.keyframes.x, localT, tr.x)
    case 'y': return sampleKeyframes(clip.keyframes.y, localT, tr.y)
    case 'scale': return sampleKeyframes(clip.keyframes.scale, localT, tr.scaleX)
    case 'rotation': return sampleKeyframes(clip.keyframes.rotation, localT, tr.rotation)
    case 'opacity': return sampleKeyframes(clip.keyframes.opacity, localT, tr.opacity)
    case 'fontSize': return sampleKeyframes(clip.keyframes.fontSize, localT, clip.text?.fontSize ?? 48)
    default: return 0
  }
}
