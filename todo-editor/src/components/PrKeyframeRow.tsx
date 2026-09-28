import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NumInput } from './NumInput'
import {
  defaultHandles,
  keyframeSideSpeeds,
  sampleKeyframes,
  sampleSpeedCurve,
} from '../lib/keyframeEval'
import type { Clip, Ease, Keyframe, KfHandle } from '../types'
import { useApp } from '../store'
import { clearKfDeleteContext, setKfDeleteContext, setKfGraphHovered } from '../lib/kfDelete'
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
  /** 速度图数据源：单轨 → 带符号变化率；多轨（XY）→ 合速度。缺省用本行关键帧 */
  speedTracks?: Keyframe[][]
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
  /** F3 自动贝塞尔 */
  onAutoBezier?: (ids: string[]) => void
}

/** 关键帧行：数值 + 缓动预设（默认线性）+ 速度曲线（选中关键帧可拖入/出速度手柄） */
export function PrKeyframeRow({
  prop, label, clip, playhead, displayValue,
  min, max, step, unit, defaultValue, testId,
  toStore = (v) => v, toUi = (v) => v,
  hideGraph, graphOnly, hideEase, pxPerSec, timelineSpan, speedTracks,
  onChange, onToggleKeyframe, onGotoAdjacent, onSeek, onMoveKeyframe, onSetEase,
  onSetHandle, onEnableBezier, onRemoveKeyframes, onAutoBezier,
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

  const span = timelineSpan ?? clip.duration
  const synced = pxPerSec != null
  const tracks = useMemo(() => speedTracks ?? [frames], [speedTracks, frames])
  const graph = armed && (
    <SpeedGraph
      prop={prop}
      frames={frames}
      speedTracks={tracks}
      duration={clip.duration}
      clipStart={synced ? clip.start : 0}
      absStart={clip.start}
      spanDuration={synced ? span : clip.duration}
      stripRef={stripRef}
      synced={synced}
      selectedId={selected?.id ?? null}
      onSeekAbs={(t) => onSeek(synced ? t : clip.start + t)}
      onMoveKeyframe={(id, t) => onMoveKeyframe(prop, id, t)}
      onSeekLocal={(t) => useApp.getState().setPlayhead(clip.start + t, { exact: true })}
      onSetHandle={onSetHandle ? (id, which, h) => onSetHandle(prop, id, which, h) : undefined}
      onEnableBezier={onEnableBezier ? (id) => onEnableBezier(prop, id) : undefined}
      onRemoveKeyframes={onRemoveKeyframes}
      onAutoBezier={onAutoBezier}
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

/** 当前生效的出手柄（与 sampleKeyframes 的取值规则一致） */
function effectiveOut(k: Keyframe): KfHandle {
  return k.ease === 'bezier' ? (k.oh ?? defaultHandles('easeInOut').oh) : defaultHandles(k.ease).oh
}

/** 当前生效的入手柄：段 prev→k 是否走曲线由 prev 决定 */
function effectiveIn(prev: Keyframe, k: Keyframe): KfHandle {
  if (prev.ease !== 'bezier') return defaultHandles(prev.ease).ih
  return k.ih ?? defaultHandles(k.ease === 'bezier' ? 'easeInOut' : k.ease).ih
}

function fmtSpeed(v: number | null) {
  if (v == null) return '—'
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : v.toFixed(3)
}

type HandleInfo = { which: 'oh' | 'ih'; t: number; speed: number; spanT: number; spanV: number }

function SpeedGraph({
  prop, frames, speedTracks, duration, clipStart, absStart, spanDuration, stripRef, synced, selectedId,
  onSeekAbs, onMoveKeyframe, onSeekLocal, onSetHandle, onEnableBezier, onRemoveKeyframes, onAutoBezier,
}: {
  prop: string
  frames: Keyframe[]
  speedTracks: Keyframe[][]
  duration: number
  clipStart: number
  absStart: number
  spanDuration: number
  stripRef: React.RefObject<HTMLDivElement | null>
  synced?: boolean
  selectedId: string | null
  onSeekAbs: (absoluteT: number) => void
  onMoveKeyframe: (id: string, localT: number) => void
  onSeekLocal: (localT: number) => void
  onSetHandle?: (id: string, which: 'oh' | 'ih', handle: KfHandle) => void
  onEnableBezier?: (id: string) => void
  onRemoveKeyframes?: (ids: string[]) => void
  onAutoBezier?: (ids: string[]) => void
}) {
  const sorted = useMemo(() => [...frames].sort((a, b) => a.t - b.t), [frames])
  const signed = speedTracks.filter((k) => k.length).length === 1
  const curve = useMemo(
    () => sampleSpeedCurve(speedTracks, duration, Math.max(120, Math.min(600, Math.round(duration * 60)))),
    [speedTracks, duration],
  )
  const sides = useMemo(
    () => new Map(sorted.map((k) => [k.id, keyframeSideSpeeds(speedTracks, k.t, duration)])),
    [sorted, speedTracks, duration],
  )
  const [picked, setPicked] = useState<string[]>([])
  const [box, setBox] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null)
  const [dragRange, setDragRange] = useState<null | { lo: number; hi: number }>(null)
  const span = Math.max(1e-6, spanDuration)

  const xOf = (local: number) => (clipStart + local) / span

  const selected = selectedId ? sorted.find((k) => k.id === selectedId) ?? null : null
  const selIdx = selected ? sorted.findIndex((k) => k.id === selected.id) : -1

  // 选中关键帧的入/出速度手柄。多轨（XY）时各轨共用同一归一化手柄，合速度 = 手柄斜率 × 空间距离
  const handles: HandleInfo[] = []
  if (onSetHandle && selected && selIdx >= 0) {
    for (const which of ['oh', 'ih'] as const) {
      const parts = speedTracks.filter((k) => k.length).map((track) => {
        const s = [...track].sort((a, b) => a.t - b.t)
        const i = s.findIndex((k) => Math.abs(k.t - selected.t) < 1e-4)
        if (i < 0) return null
        const j = which === 'oh' ? i + 1 : i - 1
        if (j < 0 || j >= s.length) return null
        const k = s[i]
        const n = s[j]
        if ((which === 'oh' ? k : n).ease === 'hold') return null
        const spanT = Math.abs(n.t - k.t)
        if (spanT <= 1e-6) return null
        const spanV = which === 'oh' ? n.value - k.value : k.value - n.value
        const h = which === 'oh' ? effectiveOut(k) : effectiveIn(n, k)
        return { spanT, spanV, h }
      }).filter((p): p is NonNullable<typeof p> => !!p)
      if (!parts.length) continue
      const p0 = parts[0]
      const speeds = parts.map((p) => (p.h.y * p.spanV) / (p.h.x * p.spanT))
      handles.push({
        which,
        t: selected.t + p0.h.x * p0.spanT,
        speed: signed ? speeds[0] : Math.hypot(...speeds),
        spanT: p0.spanT,
        spanV: signed ? p0.spanV : Math.hypot(...parts.map((p) => p.spanV)),
      })
    }
  }
  const [dragHandle, setDragHandle] = useState<'oh' | 'ih' | null>(null)

  const range = useMemo(() => {
    let lo = 0
    let hi = 0
    for (const p of curve) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    if (!signed) lo = 0
    if (hi - lo < 1e-9) hi = lo + 1
    const pad = (hi - lo) * 0.15
    return { lo: signed && lo < 0 ? lo - pad : lo, hi: hi + pad }
  }, [curve, signed])
  const { lo, hi } = dragRange ?? range
  const yOf = (v: number) => 1 - (v - lo) / (hi - lo)
  const clampY = (y: number) => Math.max(0.02, Math.min(0.98, y))

  function keyY(k: Keyframe) {
    const s = sides.get(k.id)
    const vals = [s?.inSpeed, s?.outSpeed].filter((v): v is number => v != null && Number.isFinite(v))
    const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    return clampY(yOf(v))
  }

  // 每帧同步键盘上下文（勿放 effect，避免回调抖动把注册清掉）
  setKfDeleteContext({
    picked,
    selectedId,
    remove: onRemoveKeyframes ?? null,
    allIds: sorted.map((k) => k.id),
    autoBezier: onAutoBezier ?? null,
    selectAll: () => setPicked(sorted.map((k) => k.id)),
  })
  useEffect(() => () => {
    clearKfDeleteContext()
    setKfGraphHovered(false)
  }, [])

  useEffect(() => {
    const alive = new Set(frames.map((f) => f.id))
    setPicked((prev) => {
      const next = prev.filter((id) => alive.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [frames])

  useEffect(() => {
    if (!selectedId) return
    setPicked((prev) => (prev.includes(selectedId) ? prev : [selectedId]))
  }, [selectedId])

  const linePts = curve.map((p) => `${(xOf(p.t) * 100).toFixed(3)} ${(yOf(p.v) * 100).toFixed(3)}`)
  const pathD = linePts.length ? `M${linePts.join(' L')}` : ''
  const zeroY = yOf(0) * 100
  const areaD = curve.length
    ? `${pathD} L${(xOf(curve[curve.length - 1].t) * 100).toFixed(3)} ${zeroY.toFixed(3)} L${(xOf(curve[0].t) * 100).toFixed(3)} ${zeroY.toFixed(3)} Z`
    : ''

  function clientToLocalT(clientX: number, el: HTMLElement) {
    const rect = el.getBoundingClientRect()
    const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return r * span - clipStart
  }

  function startHandleDrag(e: React.PointerEvent, h: HandleInfo) {
    if (!onSetHandle || !selected) return
    e.preventDefault()
    e.stopPropagation()
    const el = stripRef.current
    if (!el || duration <= 0) return
    const kf = selected
    const frozen = { lo, hi }
    setDragRange(frozen)
    setDragHandle(h.which)
    onEnableBezier?.(kf.id)
    const canSpeed = Math.abs(h.spanV) > 1e-9
    const startInfl = Math.abs(h.t - kf.t) / h.spanT
    const rect0 = el.getBoundingClientRect()
    const grabDy = e.clientY - (rect0.top + clampY(yOf(h.speed)) * rect0.height)

    // 自动锁轴：先动超过 4px 的方向决定只改速度（上下）或只改影响范围（左右）；Shift 两者同时
    let axis: 'speed' | 'infl' | null = null
    const x0 = e.clientX
    const y0 = e.clientY

    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      if (!axis) {
        const dx = Math.abs(ev.clientX - x0)
        const dy = Math.abs(ev.clientY - y0)
        if (Math.max(dx, dy) < 4 && !ev.shiftKey) return
        axis = dy >= dx ? 'speed' : 'infl'
      }
      const free = ev.shiftKey
      // 不夹到图内：拖出图外仍按冻结的纵轴比例继续加减速
      const ny = (ev.clientY - grabDy - rect.top) / rect.height
      let speed = free || axis === 'speed' ? frozen.hi - ny * (frozen.hi - frozen.lo) : h.speed
      if (!signed) speed = Math.max(0, speed)
      const infl = free || axis === 'infl'
        ? Math.max(0.02, Math.min(0.98, Math.abs(clientToLocalT(ev.clientX, el) - kf.t) / h.spanT))
        : startInfl
      const x = h.which === 'oh' ? infl : -infl
      onSetHandle(kf.id, h.which, { x, y: canSpeed ? (speed * x * h.spanT) / h.spanV : 0 })
    }
    const onUp = () => {
      setDragRange(null)
      setDragHandle(null)
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
      const x = xOf(f.t)
      const y = keyY(f)
      return x >= left && x <= right && y >= top && y <= bottom
    }).map((f) => f.id)
  }

  return (
    <div
      ref={stripRef}
      className={clsx('pr-kf-graph', synced && 'pr-kf-graph--synced')}
      data-testid={`kf-strip-${prop}`}
      data-graph="speed"
      title={`速度曲线${signed ? '（变化率/秒）' : '（合速度/秒）'} · 拖空白处 scrub · 拖菱形移动 · Ctrl+拖框选 · Ctrl+A 全选 · F3 自动贝塞尔（框选则只处理选中）`}
      onPointerEnter={() => setKfGraphHovered(true)}
      onPointerLeave={() => setKfGraphHovered(false)}
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
        e.preventDefault()
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
      {synced && duration > 0 && (
        <div
          className="pr-kf-clip-band"
          data-testid="kf-clip-lane"
          style={{ left: `${(clipStart / span) * 100}%`, width: `${(duration / span) * 100}%` }}
        />
      )}

      <svg className="pr-kf-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <line
          x1={xOf(0) * 100} x2={xOf(duration) * 100} y1={zeroY} y2={zeroY}
          stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.45"
          vectorEffect="non-scaling-stroke"
        />
        <path d={areaD} fill="var(--accent)" opacity="0.12" />
        <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" opacity="0.95" data-testid={`kf-speed-path-${prop}`} />
        {selected && handles.map((h) => (
          <line
            key={h.which}
            x1={xOf(selected.t) * 100} y1={clampY(yOf(h.speed)) * 100}
            x2={xOf(h.t) * 100} y2={clampY(yOf(h.speed)) * 100}
            stroke="var(--accent)" strokeWidth="1.5" opacity="0.6"
            vectorEffect="non-scaling-stroke"
          />
        ))}
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
        const isSel = picked.includes(f.id) || selected?.id === f.id
        const s = sides.get(f.id)
        return (
          <button
            key={f.id}
            type="button"
            data-kf-id={f.id}
            className={clsx('pr-kf-mark', isSel && 'selected', f.ease === 'bezier' && 'is-bezier')}
            style={{ left: `${xOf(f.t) * 100}%`, top: `${keyY(f) * 100}%` }}
            title={`${f.t.toFixed(2)}s · ${f.ease} · 入 ${fmtSpeed(s?.inSpeed ?? null)} / 出 ${fmtSpeed(s?.outSpeed ?? null)} 每秒`}
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
              const frozen = { lo, hi }
              setDragRange(frozen)
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
                setDragRange(null)
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

      {handles.map((h) => (
        <button
          key={h.which}
          type="button"
          data-kf-handle={h.which}
          className={clsx('pr-kf-handle pr-kf-handle--speed', dragHandle === h.which && 'is-dragging')}
          style={{ left: `${xOf(h.t) * 100}%`, top: `${clampY(yOf(h.speed)) * 100}%` }}
          title={`${h.which === 'oh' ? '出' : '入'}速度 ${fmtSpeed(h.speed)}/秒 · 影响 ${Math.round((Math.abs(h.t - (selected?.t ?? 0)) / h.spanT) * 100)}% · 上下拖=速度 · 左右拖=影响范围 · 按住 Shift 同时调 · 双击恢复自动`}
          data-testid={`kf-handle-${h.which}-${prop}`}
          onPointerDown={(e) => startHandleDrag(e, h)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (selected) onAutoBezier?.([selected.id])
          }}
        />
      ))}
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
