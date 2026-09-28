import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Move, Type, Palette, Sparkles, Box, X, ChevronLeft,
  Maximize2, RotateCw, Aperture, ArrowLeftRight, ArrowUpDown, Blend, KeyRound,
} from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '../store'
import { resolveClipTransform, sampleKeyframes } from '../lib/keyframeEval'
import type { Clip, TransitionType } from '../types'

function sampleFontSize(clip: Clip, playhead: number) {
  const localT = Math.max(0, playhead - clip.start)
  return sampleKeyframes(clip.keyframes.fontSize, localT, clip.text?.fontSize ?? 48)
}

type RingId = 'root' | 'static' | 'dynamic' | 'transition' | 'color' | 'effect' | 'mask' | 'scene3d'
type DialProp = 'scale' | 'x' | 'y' | 'rotation' | 'opacity' | 'fontSize' | 'camZ' | 'exposure' | 'transDur'
type DialMode = 'static' | 'dynamic'

type Slice = {
  id: string
  label: string
  Icon: typeof Move
  action: () => void
}

const R = 78
const TRANS: { id: TransitionType; label: string }[] = [
  { id: 'dissolve', label: '叠化' },
  { id: 'fadeBlack', label: '闪黑' },
  { id: 'fadeWhite', label: '闪白' },
  { id: 'push', label: '推拉' },
  { id: 'wipe', label: '擦除' },
]

function polar(i: number, n: number, radius: number) {
  const a = (i / n) * Math.PI * 2 - Math.PI / 2
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius }
}

function ringTitle(ring: RingId) {
  if (ring === 'static') return '静态'
  if (ring === 'dynamic') return '动态'
  if (ring === 'transition') return '转场'
  if (ring === 'color') return '调色'
  if (ring === 'effect') return '特效'
  if (ring === 'mask') return '蒙版'
  if (ring === 'scene3d') return '3D'
  return '属性'
}

/** 渐进式属性轮盘：1 静态 · 2 动态(K帧) · 3 转场 */
export function PropWheel() {
  const wheel = useApp((s) => s.propWheel)
  const closePropWheel = useApp((s) => s.closePropWheel)
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const playhead = useApp((s) => s.playhead)
  const sequences = useApp((s) => s.sequences)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const updateSelectedTransform = useApp((s) => s.updateSelectedTransform)
  const setDynamicAtPlayhead = useApp((s) => s.setDynamicAtPlayhead)
  const updateSelectedText = useApp((s) => s.updateSelectedText)
  const updateSelectedColor = useApp((s) => s.updateSelectedColor)
  const autoKeyframe = useApp((s) => s.autoKeyframe)
  const toggleAutoKeyframe = useApp((s) => s.toggleAutoKeyframe)
  const addTransition = useApp((s) => s.addTransition)
  const setTransitionDuration = useApp((s) => s.setTransitionDuration)
  const addEffect = useApp((s) => s.addEffect)
  const setClipMask = useApp((s) => s.setClipMask)
  const toggleMaskInvert = useApp((s) => s.toggleMaskInvert)
  const setChromaKey = useApp((s) => s.setChromaKey)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const updateCamera3d = useApp((s) => s.updateCamera3d)
  const setClipThreeD = useApp((s) => s.setClipThreeD)

  const [ring, setRing] = useState<RingId>('root')
  const [entryShortcut, setEntryShortcut] = useState(false)
  const [dial, setDial] = useState<null | { prop: DialProp; label: string; origin: number; mode: DialMode }>(null)
  const dialRef = useRef<{ lastAng: number; value: number } | null>(null)
  const dialRaf = useRef(0)
  const dialPending = useRef<number | null>(null)

  const seq = sequences.find((q) => q.id === activeSeqId) ?? sequences[0]
  const clip = seq.clips.find((c) => selectedClipIds.includes(c.id))

  useEffect(() => {
    if (!wheel) return
    if (wheel.dial) {
      setRing(wheel.dial.mode)
      setEntryShortcut(true)
      setDial({
        prop: wheel.dial.prop,
        label: wheel.dial.label,
        origin: wheel.dial.origin,
        mode: wheel.dial.mode,
      })
      return
    }
    setDial(null)
    if (wheel.ring === 'static' || wheel.ring === 'dynamic' || wheel.ring === 'transition') {
      setRing(wheel.ring)
      setEntryShortcut(true)
    } else {
      setRing('root')
      setEntryShortcut(false)
    }
  }, [wheel?.at, wheel?.ring, wheel?.x, wheel?.y, wheel?.dial, wheel])

  useEffect(() => {
    if (!wheel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (dial && wheel.dial) closePropWheel()
        else if (dial) setDial(null)
        else if (!entryShortcut && ring !== 'root') setRing('root')
        else closePropWheel()
      }
      // Enter 确认拨盘
      if (e.key === 'Enter' && dial) {
        e.preventDefault()
        if (dialPending.current != null) flushDial(dial.prop)
        const wasDynamic = dial.mode === 'dynamic'
        setDial(null)
        if (wasDynamic || wheel.dial) closePropWheel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wheel, dial, ring, entryShortcut, closePropWheel])

  useEffect(() => () => {
    if (dialRaf.current) cancelAnimationFrame(dialRaf.current)
  }, [])

  const openDial = (prop: DialProp, label: string, origin: number, mode: DialMode = 'static') => {
    setDial({ prop, label, origin, mode })
  }

  const clampProp = (prop: DialProp, v: number) => {
    if (prop === 'opacity') return Math.max(0, Math.min(1, v))
    if (prop === 'scale') return Math.max(0.05, v)
    if (prop === 'fontSize') return Math.max(8, v)
    if (prop === 'transDur') return Math.max(0.05, v)
    if (prop === 'camZ') return Math.max(0.5, v)
    return v
  }

  /** 默认自由；按住 Shift 才磁吸到关键值 */
  const smartSnap = (prop: DialProp, v: number, magnetic: boolean) => {
    if (!magnetic) return v
    const pull = (stops: number[], thresh: number, alsoInt = true) => {
      let best = v
      let bestD = thresh
      for (const s of stops) {
        const d = Math.abs(v - s)
        if (d < bestD) { bestD = d; best = s }
      }
      if (alsoInt) {
        const nearestInt = Math.round(v)
        if (Math.abs(v - nearestInt) < bestD) {
          bestD = Math.abs(v - nearestInt)
          best = nearestInt
        }
      }
      return bestD < thresh ? best : v
    }
    switch (prop) {
      case 'rotation':
        return pull(
          [0, 15, 30, 45, 60, 90, 120, 135, 150, 180, -15, -30, -45, -60, -90, -120, -135, -150, -180],
          5,
        )
      case 'opacity':
        return pull([0, 0.25, 0.5, 0.75, 1], 0.035, false)
      case 'scale':
        return pull([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4], 0.055)
      case 'x':
      case 'y':
        return pull([0, 0.25, -0.25, 0.5, -0.5, 1, -1], 0.04)
      case 'fontSize':
        return Math.round(v)
      case 'exposure':
        return pull([0, 0.25, -0.25, 0.5, -0.5, 1, -1], 0.07)
      case 'transDur':
        return pull([0.25, 0.5, 0.75, 1, 1.5, 2], 0.06)
      case 'camZ':
        return pull([1, 2, 3, 5, 8, 10], 0.18)
      default:
        return v
    }
  }

  const applyDialValue = (prop: DialProp, raw: number, magnetic: boolean) =>
    clampProp(prop, smartSnap(prop, raw, magnetic))


  const flushDial = (prop: DialProp) => {
    dialRaf.current = 0
    const v = dialPending.current
    if (v == null) return
    dialPending.current = null
    writeProp(prop, v)
  }

  const queueDialWrite = (prop: DialProp, v: number) => {
    dialPending.current = v
    if (!dialRaf.current) {
      dialRaf.current = requestAnimationFrame(() => flushDial(prop))
    }
  }

  const readProp = (prop: DialProp): number => {
    if (!clip) return 0
    const mode = dial?.mode ?? 'static'
    if (prop === 'camZ') return seq.scene3d?.camera?.z ?? 5
    if (prop === 'exposure') return clip.color.exposure
    if (prop === 'transDur') return clip.transitionOut?.duration ?? 0.5
    // 动态：播放头插值（K 帧优先）；静态：底层值
    if (mode === 'dynamic') {
      const live = resolveClipTransform(clip, playhead)
      if (prop === 'scale') return live.scaleX
      if (prop === 'x') return live.x
      if (prop === 'y') return live.y
      if (prop === 'rotation') return live.rotation
      if (prop === 'opacity') return live.opacity
      return sampleFontSize(clip, playhead)
    }
    if (prop === 'scale') return clip.transform.scaleX
    if (prop === 'x') return clip.transform.x
    if (prop === 'y') return clip.transform.y
    if (prop === 'rotation') return clip.transform.rotation
    if (prop === 'opacity') return clip.transform.opacity
    return clip.text?.fontSize ?? 48
  }

  const writeProp = (prop: DialProp, v: number) => {
    const mode = dial?.mode ?? 'static'
    if (mode === 'dynamic' && (prop === 'scale' || prop === 'x' || prop === 'y' || prop === 'rotation' || prop === 'opacity' || prop === 'fontSize')) {
      const kfProp = prop === 'scale' ? 'scale' : prop
      setDynamicAtPlayhead(kfProp, prop === 'fontSize' ? Math.round(v) : v)
      return
    }
    switch (prop) {
      case 'scale': updateSelectedTransform({ scaleX: v, scaleY: v }); break
      case 'x': updateSelectedTransform({ x: v }); break
      case 'y': updateSelectedTransform({ y: v }); break
      case 'rotation': updateSelectedTransform({ rotation: v }); break
      case 'opacity': updateSelectedTransform({ opacity: Math.max(0, Math.min(1, v)) }); break
      case 'fontSize': updateSelectedText({ fontSize: Math.round(v) }); break
      case 'camZ': updateCamera3d({ z: Math.max(0.5, v) }, { record: false }); break
      case 'exposure': updateSelectedColor({ exposure: v }); break
      case 'transDur': setTransitionDuration(Math.max(0.1, v)); break
    }
  }

  const slices: Slice[] = useMemo(() => {
    if (!clip) return []
    if (ring === 'root') {
      const list: Slice[] = [
        { id: 'st', label: '静态', Icon: Move, action: () => { setRing('static'); setEntryShortcut(false) } },
        { id: 'ak', label: autoKeyframe ? 'K开' : 'K帧', Icon: KeyRound, action: () => { toggleAutoKeyframe() } },
        { id: 'tr', label: '转场', Icon: Blend, action: () => { setRing('transition'); setEntryShortcut(false) } },
        { id: '3d', label: '3D', Icon: Box, action: () => { setRing('scene3d'); setEntryShortcut(false) } },
      ]
      if (!clip.text) {
        list.push({ id: 'co', label: '调色', Icon: Palette, action: () => { setRing('color'); setEntryShortcut(false) } })
        list.push({ id: 'fx', label: '特效', Icon: Sparkles, action: () => { setRing('effect'); setEntryShortcut(false) } })
        list.push({ id: 'mk', label: '蒙版', Icon: Aperture, action: () => { setRing('mask'); setEntryShortcut(false) } })
      }
      return list
    }
    if (ring === 'static') {
      const list: Slice[] = [
        { id: 'sc', label: '缩放', Icon: Maximize2, action: () => openDial('scale', '缩放', clip.transform.scaleX, 'static') },
        { id: 'x', label: 'X', Icon: ArrowLeftRight, action: () => openDial('x', '位置 X', clip.transform.x, 'static') },
        { id: 'y', label: 'Y', Icon: ArrowUpDown, action: () => openDial('y', '位置 Y', clip.transform.y, 'static') },
        { id: 'ro', label: '旋转', Icon: RotateCw, action: () => openDial('rotation', '旋转', clip.transform.rotation, 'static') },
        { id: 'op', label: '透明', Icon: Aperture, action: () => openDial('opacity', '透明度', clip.transform.opacity, 'static') },
      ]
      if (clip.text) {
        list.push({ id: 'fs', label: '字号', Icon: Type, action: () => openDial('fontSize', '字号', clip.text!.fontSize, 'static') })
      }
      return list
    }
    if (ring === 'dynamic') {
      // 动态环已改为：2 开 K帧 · S/T 拨盘 · 拖位置打点；此处仅保留开关
      return [
        {
          id: 'ak',
          label: autoKeyframe ? 'K开' : 'K帧',
          Icon: KeyRound,
          action: () => { toggleAutoKeyframe() },
        },
      ]
    }
    if (ring === 'transition') {
      const list: Slice[] = TRANS.map((t) => ({
        id: t.id,
        label: t.label,
        Icon: Blend,
        action: () => addTransition(t.id),
      }))
      list.push({
        id: 'tdur',
        label: '时长',
        Icon: RotateCw,
        action: () => {
          if (!clip.transitionOut) addTransition('dissolve')
          openDial('transDur', '转场时长', clip.transitionOut?.duration ?? 0.5, 'static')
        },
      })
      return list
    }
    if (ring === 'color') {
      return [
        { id: 'ex', label: '曝光', Icon: Palette, action: () => openDial('exposure', '曝光', clip.color.exposure, 'static') },
        { id: 'rst', label: '重置', Icon: RotateCw, action: () => { updateSelectedColor({ temperature: 0, tint: 0, exposure: 0, contrast: 0, saturation: 0 }); closePropWheel() } },
      ]
    }
    if (ring === 'effect') {
      return [
        { id: 'bl', label: '模糊', Icon: Sparkles, action: () => { addEffect('blur', '模糊'); closePropWheel() } },
        { id: 'vg', label: '暗角', Icon: Aperture, action: () => { addEffect('vignette', '暗角'); closePropWheel() } },
        { id: 'sh', label: '锐化', Icon: Maximize2, action: () => { addEffect('sharpen', '锐化'); closePropWheel() } },
      ]
    }
    if (ring === 'mask') {
      return [
        { id: 'mask-rect', label: '矩形', Icon: Maximize2, action: () => { setClipMask('rect'); closePropWheel() } },
        { id: 'mask-ellipse', label: '圆形', Icon: Aperture, action: () => { setClipMask('ellipse'); closePropWheel() } },
        { id: 'mask-linear', label: '线性', Icon: ArrowUpDown, action: () => { setClipMask('linear'); closePropWheel() } },
        { id: 'mask-pen', label: '钢笔', Icon: Move, action: () => { setClipMask('pen'); closePropWheel() } },
        { id: 'mask-text', label: '文字', Icon: Type, action: () => { setClipMask('text'); closePropWheel() } },
        { id: 'mask-invert', label: '反转', Icon: RotateCw, action: () => { toggleMaskInvert(); closePropWheel() } },
        { id: 'btn-chroma', label: '抠像', Icon: Sparkles, action: () => { setChromaKey(!(clip.chromaKey?.enabled)); closePropWheel() } },
        { id: 'mask-clear', label: '清除', Icon: X, action: () => { setClipMask(null); setChromaKey(false); closePropWheel() } },
      ]
    }
    if (ring === 'scene3d') {
      return [
        { id: 'on', label: '开3D', Icon: Box, action: () => { setMonitorCompose('3d'); setClipThreeD(true); closePropWheel() } },
        { id: 'cz', label: '相机Z', Icon: Move, action: () => openDial('camZ', '相机 Z', seq.scene3d?.camera?.z ?? 5, 'static') },
        { id: 'off', label: '回2D', Icon: Box, action: () => { setMonitorCompose('2d'); closePropWheel() } },
      ]
    }
    return []
  }, [ring, clip, seq.scene3d?.camera?.z, playhead, autoKeyframe]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!wheel || !clip) return null

  const cx = Math.min(window.innerWidth - 120, Math.max(120, wheel.x))
  const cy = Math.min(window.innerHeight - 120, Math.max(120, wheel.y))
  const live = dial ? readProp(dial.prop) : null
  const title = ringTitle(ring)

  function onDialRingPointerDown(e: React.PointerEvent) {
    if (!dial) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const ang = Math.atan2(e.clientY - cy, e.clientX - cx)
    dialRef.current = { lastAng: ang, value: readProp(dial.prop) }
    // 拖拽放慢：约原先 1/3～1/4
    const sens =
      dial.prop === 'opacity' ? 0.1
        : dial.prop === 'scale' ? 0.14
          : dial.prop === 'fontSize' ? 3.5
            : dial.prop === 'rotation' ? 8
              : dial.prop === 'camZ' || dial.prop === 'transDur' ? 0.25
                : 0.12
    const prop = dial.prop

    const onMove = (ev: PointerEvent) => {
      const d = dialRef.current
      if (!d) return
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx)
      let delta = a - d.lastAng
      if (delta > Math.PI) delta -= Math.PI * 2
      if (delta < -Math.PI) delta += Math.PI * 2
      d.lastAng = a
      d.value += delta * sens
      const magnetic = ev.shiftKey
      const next = applyDialValue(prop, d.value, magnetic)
      // 磁吸后把内部累加值也拉齐，避免“粘住又立刻滑开”
      if (magnetic && next !== d.value && Math.abs(next - d.value) < 0.2) {
        d.value = next
      }
      queueDialWrite(prop, next)
    }
    const onUp = (ev: PointerEvent) => {
      const d = dialRef.current
      if (d) {
        const snapped = applyDialValue(prop, d.value, ev.shiftKey)
        d.value = snapped
        writeProp(prop, snapped)
      } else if (dialPending.current != null) {
        flushDial(prop)
      }
      dialRef.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      try { el.releasePointerCapture(ev.pointerId) } catch { /* */ }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  function onDialWheel(e: React.WheelEvent) {
    if (!dial) return
    e.preventDefault()
    e.stopPropagation()
    const prop = dial.prop
    const dir = e.deltaY > 0 ? -1 : 1
    const magnetic = e.shiftKey
    const cur = readProp(prop)
    let next: number

    if (prop === 'opacity') {
      if (magnetic) {
        // Shift：跳到 0/25/50/75/100%
        const stops = [0, 0.25, 0.5, 0.75, 1]
        next = dir > 0
          ? (stops.find((s) => s > cur + 0.001) ?? 1)
          : ([...stops].reverse().find((s) => s < cur - 0.001) ?? 0)
      } else {
        next = clampProp(prop, cur + dir * 0.05)
      }
    } else {
      const step =
        prop === 'scale' || prop === 'x' || prop === 'y' || prop === 'exposure' ? 0.05
          : prop === 'fontSize' ? 1
            : prop === 'rotation' ? 5
              : prop === 'camZ' || prop === 'transDur' ? 0.25
                : 0.05
      if (magnetic) {
        next = applyDialValue(prop, cur + dir * step, true)
      } else {
        next = clampProp(prop, cur + dir * step)
      }
    }

    if (dialRef.current) dialRef.current.value = next
    writeProp(prop, next)
  }

  function confirmDial(e?: React.SyntheticEvent) {
    e?.stopPropagation()
    e?.preventDefault()
    if (dialPending.current != null && dial) flushDial(dial.prop)
    setDial(null)
    // S/R/T 快捷键打开的拨盘：确定后关掉轮盘，K帧模式保持
    if (dial?.mode === 'dynamic' || wheel?.dial) closePropWheel()
  }

  return (
    <div className="prop-wheel-root" data-testid="prop-wheel" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="prop-wheel-backdrop"
        aria-label="关闭属性轮盘"
        data-testid="prop-wheel-backdrop"
        onClick={closePropWheel}
      />
      <div className="prop-wheel" style={{ left: cx, top: cy }} data-testid={`prop-wheel-ring-${ring}`}>
        {dial ? (
          <div
            className="prop-wheel-dial"
            data-testid="prop-wheel-dial"
            title="外环拖拽 / 滚轮 · Shift 开磁吸 · Enter 确定"
            onWheel={onDialWheel}
          >
            <div
              className="prop-wheel-dial-ring"
              data-testid="prop-wheel-dial-ring"
              onPointerDown={onDialRingPointerDown}
              onWheel={onDialWheel}
            />
            <div className="prop-wheel-center prop-wheel-center--dial" onWheel={onDialWheel}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{dial.label}</span>
              <span className="text-[15px] font-semibold tabular-nums">
                {dial.prop === 'opacity' ? `${Math.round((live ?? 0) * 100)}%`
                  : dial.prop === 'fontSize' || dial.prop === 'rotation' ? Math.round(live ?? 0)
                    : dial.prop === 'transDur' ? `${(live ?? 0).toFixed(2)}s`
                      : (live ?? 0).toFixed(2)}
              </span>
              <button
                type="button"
                className="prop-wheel-mini"
                data-testid="prop-wheel-dial-back"
                onPointerDown={(e) => { e.stopPropagation() }}
                onClick={confirmDial}
              >
                确定
              </button>
            </div>
          </div>
        ) : (
          <>
            {slices.map((s, i) => {
              const p = polar(i, slices.length, R)
              const active = s.id === 'ak' && autoKeyframe
              return (
                <button
                  key={s.id}
                  type="button"
                  className={clsx('prop-wheel-slice', active && 'is-active')}
                  style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                  title={s.id === 'ak' ? (autoKeyframe ? '关闭 K帧模式' : '开启 K帧模式：拖位置自动打点') : s.label}
                  aria-label={s.label}
                  aria-pressed={s.id === 'ak' ? autoKeyframe : undefined}
                  data-testid={`prop-wheel-${s.id}`}
                  onClick={s.action}
                >
                  <s.Icon size={16} strokeWidth={1.75} />
                  <span>{s.label}</span>
                </button>
              )
            })}
            <div className="prop-wheel-center">
              <button
                type="button"
                className="prop-wheel-hub"
                data-testid="prop-wheel-hub"
                title={ring === 'root' || entryShortcut ? '关闭' : '返回'}
                onClick={() => {
                  if (ring === 'root' || entryShortcut) closePropWheel()
                  else setRing('root')
                }}
              >
                {ring === 'root' || entryShortcut ? <X size={16} /> : <ChevronLeft size={16} />}
              </button>
              <span className="prop-wheel-name" title={title || clip.name}>
                {title || clip.name}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
