import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useApp } from '../store'
import { wheelZoom, TIMELINE_SPAN_SEC } from '../lib/timelineZoom'
import { setLivePlayhead } from '../lib/livePlayhead'
import { broadcastPlayheadSeek } from '../lib/storeSync'
import { PrKeyframeRow, livePropValue } from './PrKeyframeRow'
import type { Clip, Ease, Keyframe, KfHandle } from '../types'

const EASE_PRESETS: { id: Ease; label: string }[] = [
  { id: 'linear', label: '线性' },
  { id: 'easeIn', label: '缓入' },
  { id: 'easeOut', label: '缓出' },
  { id: 'easeInOut', label: '缓入出' },
  { id: 'hold', label: '定格' },
  { id: 'bezier', label: '曲线' },
]

const PROP_META: {
  id: string
  label: string
  unit?: string
  min?: number
  max?: number
  step?: number
  toUi?: (v: number) => number
  toStore?: (v: number) => number
}[] = [
  { id: 'xy', label: '位置', step: 0.01 },
  { id: 'scale', label: '缩放', min: 0.05, step: 0.01 },
  { id: 'rotation', label: '旋转', unit: '°', step: 1 },
  { id: 'opacity', label: '透明', unit: '%', min: 0, max: 100, step: 1, toUi: (v) => v * 100, toStore: (v) => v / 100 },
  { id: 'fontSize', label: '字号', min: 8, step: 1 },
]

type Props = {
  scrollRef: RefObject<HTMLDivElement | null>
}

const KF_H_MIN = 90
const KF_H_MAX = 480

function hasPropKfs(clip: Clip, id: string) {
  if (id === 'xy') return (clip.keyframes.x?.length ?? 0) > 0 || (clip.keyframes.y?.length ?? 0) > 0
  return (clip.keyframes[id]?.length ?? 0) > 0
}

function nearKf(list: Keyframe[] | undefined, t: number, thresh = 0.08) {
  return (list ?? []).find((k) => Math.abs(k.t - t) < thresh)
}

/** 独立 K 帧轴：选中片段且有关键帧时显示；与时间线同缩放/滚动 */
export function KeyframeEditor({ scrollRef }: Props) {
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const sequences = useApp((s) => s.sequences)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const playhead = useApp((s) => s.playhead)
  const setPlayhead = useApp((s) => s.setPlayhead)
  const setDynamicAtPlayhead = useApp((s) => s.setDynamicAtPlayhead)
  const removeKeyframeAtPlayhead = useApp((s) => s.removeKeyframeAtPlayhead)
  const gotoAdjacentKeyframe = useApp((s) => s.gotoAdjacentKeyframe)
  const setKeyframeTime = useApp((s) => s.setKeyframeTime)
  const setKeyframeEase = useApp((s) => s.setKeyframeEase)
  const setKeyframeHandle = useApp((s) => s.setKeyframeHandle)
  const enableBezierAt = useApp((s) => s.enableBezierAt)
  const setTimelineZoom = useApp((s) => s.setTimelineZoom)
  const timelineZoom = useApp((s) => s.timelineZoom)
  const pxPerSec = timelineZoom

  const kfScrollRef = useRef<HTMLDivElement>(null)
  const seekRaf = useRef(0)
  const pendingSeek = useRef<number | null>(null)

  const seq = sequences.find((q) => q.id === activeSeqId) ?? sequences[0]
  const clip = seq.clips.find((c) => selectedClipIds.includes(c.id))

  const duration = useMemo(
    () => Math.max(TIMELINE_SPAN_SEC, seq.workOut, ...seq.clips.map((c) => c.start + c.duration), 12),
    [seq],
  )
  const [bodyW, setBodyW] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => setBodyW(el.clientWidth)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef, clip?.id])
  const lanePx = Math.max(Math.ceil(duration * pxPerSec), bodyW)
  const timelineDuration = lanePx / Math.max(1, pxPerSec)

  const armedProps = useMemo(() => {
    if (!clip) return []
    return PROP_META.filter((p) => hasPropKfs(clip, p.id))
  }, [clip])

  const [prop, setProp] = useState<string | null>(null)
  const activeProp = prop && armedProps.some((p) => p.id === prop) ? prop : armedProps[0]?.id ?? null
  const meta = PROP_META.find((p) => p.id === activeProp)

  const visible = !!(clip && armedProps.length && meta && activeProp)

  const [kfH, setKfH] = useState(() => {
    const v = Number(localStorage.getItem('todo-kf-h'))
    return Number.isFinite(v) && v >= KF_H_MIN ? Math.min(KF_H_MAX, v) : 150
  })
  useEffect(() => {
    document.documentElement.style.setProperty('--kf-h', visible ? `${kfH}px` : '0px')
    return () => { document.documentElement.style.setProperty('--kf-h', '0px') }
  }, [visible, kfH])

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY
    const h0 = kfH
    let last = h0
    const move = (ev: PointerEvent) => {
      last = Math.max(KF_H_MIN, Math.min(KF_H_MAX, h0 + ev.clientY - y0))
      setKfH(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      localStorage.setItem('todo-kf-h', String(Math.round(last)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    const tl = scrollRef.current
    const kf = kfScrollRef.current
    if (!tl || !kf) return
    let lock = false
    const mirror = (from: HTMLElement, to: HTMLElement) => {
      if (lock || from.scrollLeft === to.scrollLeft) return
      lock = true
      to.scrollLeft = from.scrollLeft
      queueMicrotask(() => { lock = false })
    }
    const fromTl = () => mirror(tl, kf)
    const fromKf = () => mirror(kf, tl)
    fromTl()
    tl.addEventListener('scroll', fromTl, { passive: true })
    kf.addEventListener('scroll', fromKf, { passive: true })
    return () => {
      tl.removeEventListener('scroll', fromTl)
      kf.removeEventListener('scroll', fromKf)
    }
  }, [scrollRef, clip?.id, activeProp, pxPerSec, timelineDuration, visible])

  // 同时间线：Alt+滚轮缩放，Ctrl / Shift+滚轮左右移动（非被动监听才拦得住页面缩放）
  const zoomRef = useRef(timelineZoom)
  zoomRef.current = timelineZoom
  useEffect(() => {
    const kf = kfScrollRef.current
    if (!kf) return
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault()
        if (e.deltaY) setTimelineZoom(wheelZoom(zoomRef.current, e.deltaY))
      } else if (e.ctrlKey || e.shiftKey) {
        e.preventDefault()
        const tl = scrollRef.current
        if (tl) tl.scrollLeft += e.deltaY || e.deltaX
      }
    }
    kf.addEventListener('wheel', onWheel, { passive: false })
    return () => kf.removeEventListener('wheel', onWheel)
  }, [scrollRef, setTimelineZoom, clip?.id, visible])

  /** 合并时刻：以 x 为主，缺 x 用 y 占位（须在 early return 前，避免删光关键帧后 hooks 数量变化白屏） */
  const xyGraphClip = useMemo((): Clip | null => {
    if (!clip) return null
    const xs = [...(clip.keyframes.x ?? [])].sort((a, b) => a.t - b.t)
    const ys = [...(clip.keyframes.y ?? [])].sort((a, b) => a.t - b.t)
    const times = [...new Set([
      ...xs.map((k) => +k.t.toFixed(5)),
      ...ys.map((k) => +k.t.toFixed(5)),
    ])].sort((a, b) => a - b)
    const merged: Keyframe[] = times.map((t) => {
      const xk = xs.find((k) => Math.abs(k.t - t) < 1e-4)
      const yk = ys.find((k) => Math.abs(k.t - t) < 1e-4)
      return {
        id: xk?.id ?? yk?.id ?? `xy-${t}`,
        t,
        value: xk?.value ?? yk?.value ?? 0,
        ease: xk?.ease ?? yk?.ease ?? 'linear',
        oh: xk?.oh ?? yk?.oh,
        ih: xk?.ih ?? yk?.ih,
      }
    })
    return { ...clip, keyframes: { ...clip.keyframes, x: merged } }
  }, [clip])
  const xySpeedTracks = useMemo(
    () => (clip ? [clip.keyframes.x ?? [], clip.keyframes.y ?? []] : []),
    [clip],
  )

  if (!visible || !clip || !meta || !activeProp || !xyGraphClip) return null

  const isXy = activeProp === 'xy'
  const xVal = livePropValue(clip, 'x', playhead)
  const yVal = livePropValue(clip, 'y', playhead)
  const displayValue = isXy ? xVal : livePropValue(clip, activeProp, playhead)
  const laneW = lanePx

  // 共用缓动目标：播放头附近关键帧（XY 取 x，否则当前属性）
  const easeSrc = isXy ? (clip.keyframes.x ?? []) : (clip.keyframes[activeProp] ?? [])
  const localT = Math.max(0, playhead - clip.start)
  const easeKf = [...easeSrc].sort((a, b) => a.t - b.t).find((k) => Math.abs(k.t - localT) < 0.08) ?? null

  const seekKeepVisible = (t: number, opts?: { exact?: boolean }) => {
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    pendingSeek.current = t
    const el = scrollRef.current
    if (el) {
      const x = t * pxPerSec
      const m = 56
      if (x < el.scrollLeft + m) el.scrollLeft = Math.max(0, x - m)
      else if (x > el.scrollLeft + el.clientWidth - m) el.scrollLeft = x - el.clientWidth + m
    }
    if (!seekRaf.current) {
      seekRaf.current = requestAnimationFrame(() => {
        seekRaf.current = 0
        const pt = pendingSeek.current
        if (pt != null) setPlayhead(pt, { exact: true, ...opts })
      })
    }
  }

  /** 位置关键帧始终成对打点/删除 */
  const toggleXy = () => {
    const localT = Math.max(0, playhead - clip.start)
    const has = !!(nearKf(clip.keyframes.x, localT) || nearKf(clip.keyframes.y, localT))
    if (has) {
      removeKeyframeAtPlayhead('x')
      removeKeyframeAtPlayhead('y')
    } else {
      setDynamicAtPlayhead('x', xVal)
      setDynamicAtPlayhead('y', yVal)
    }
  }

  const moveXyTime = (_p: string, kfId: string, localT: number) => {
    const xs = clip.keyframes.x ?? []
    const ys = clip.keyframes.y ?? []
    const hit = xs.find((k) => k.id === kfId) ?? ys.find((k) => k.id === kfId)
    if (!hit) return
    const oldT = hit.t
    for (const k of xs) if (Math.abs(k.t - oldT) < 1e-4) setKeyframeTime('x', k.id, localT)
    for (const k of ys) if (Math.abs(k.t - oldT) < 1e-4) setKeyframeTime('y', k.id, localT)
  }

  const setXyEase = (_p: string, kfId: string, ease: Ease) => {
    const xs = clip.keyframes.x ?? []
    const ys = clip.keyframes.y ?? []
    const hit = xs.find((k) => k.id === kfId) ?? ys.find((k) => k.id === kfId)
    if (!hit) return
    for (const k of xs) if (Math.abs(k.t - hit.t) < 1e-4) setKeyframeEase('x', k.id, ease)
    for (const k of ys) if (Math.abs(k.t - hit.t) < 1e-4) setKeyframeEase('y', k.id, ease)
  }

  const removeXyByIds = (ids: string[]) => {
    if (!ids.length) return
    const st = useApp.getState()
    const c = st.seq().clips.find((cl) => st.selectedClipIds.includes(cl.id))
    if (!c) return
    const xs = c.keyframes.x ?? []
    const ys = c.keyframes.y ?? []
    const times = new Set<number>()
    for (const id of ids) {
      const hit = xs.find((k) => k.id === id) ?? ys.find((k) => k.id === id)
      if (hit) times.add(+hit.t.toFixed(5))
    }
    if (!times.size) return
    const xIds = xs.filter((k) => [...times].some((t) => Math.abs(k.t - t) < 1e-4)).map((k) => k.id)
    const yIds = ys.filter((k) => [...times].some((t) => Math.abs(k.t - t) < 1e-4)).map((k) => k.id)
    st.removeKeyframesByIds({ x: xIds, y: yIds })
  }

  /** 位置按时刻成对：合并图上的 id → 该时刻 x/y 两条轨的关键帧 */
  const autoBezierXy = (ids: string[]) => {
    const xs = clip.keyframes.x ?? []
    const ys = clip.keyframes.y ?? []
    const times = ids
      .map((id) => (xs.find((k) => k.id === id) ?? ys.find((k) => k.id === id))?.t)
      .filter((t): t is number => t != null)
    const at = (list: Keyframe[]) => list.filter((k) => times.some((t) => Math.abs(k.t - t) < 1e-4)).map((k) => k.id)
    useApp.getState().autoBezierKeyframes({ x: at(xs), y: at(ys) })
  }

  /** 位置手柄：同一时刻的 x/y 写入同一归一化手柄，运动路径保持直线、只改快慢 */
  const setXyHandle = (_p: string, kfId: string, which: 'oh' | 'ih', h: KfHandle) => {
    const xs = clip.keyframes.x ?? []
    const ys = clip.keyframes.y ?? []
    const hit = xs.find((k) => k.id === kfId) ?? ys.find((k) => k.id === kfId)
    if (!hit) return
    for (const k of xs) if (Math.abs(k.t - hit.t) < 1e-4) setKeyframeHandle('x', k.id, which, h)
    for (const k of ys) if (Math.abs(k.t - hit.t) < 1e-4) setKeyframeHandle('y', k.id, which, h)
  }

  const removePropByIds = (ids: string[]) => {
    if (!ids.length || !activeProp || activeProp === 'xy') return
    useApp.getState().removeKeyframesByIds({ [activeProp]: ids })
  }

  const startPan = (e: React.PointerEvent) => {
    if (!(e.button === 1 || (e.button === 0 && e.altKey))) return false
    e.preventDefault()
    e.stopPropagation()
    const tl = scrollRef.current
    if (!tl) return true
    const startX = e.clientX
    const startScroll = tl.scrollLeft
    const move = (ev: PointerEvent) => { tl.scrollLeft = startScroll - (ev.clientX - startX) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return true
  }

  return (
    <div
      className="relative shrink-0 border-b flex flex-col min-h-0"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
        height: 'var(--kf-h, 150px)',
      }}
      data-testid="keyframe-editor"
    >
      <div
        className="absolute left-0 right-0 bottom-[-3px] h-[6px] z-20 cursor-row-resize hover:bg-[var(--accent-dim)]"
        title="拖动调整曲线区高度"
        data-testid="kf-editor-resize"
        onPointerDown={startResize}
      />
      <div className="flex items-center gap-1.5 px-2 py-0.5 min-h-0 flex-wrap">
        <div className="flex flex-wrap gap-0.5 shrink-0">
          {armedProps.map((p) => (
            <button
              key={p.id}
              type="button"
              className={p.id === activeProp ? 'btn btn-ghost active text-[10px] h-5 px-1.5' : 'btn btn-ghost text-[10px] h-5 px-1.5'}
              data-testid={`kf-editor-tab-${p.id}`}
              onClick={() => setProp(p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-ghost text-[10px] h-5 px-1.5"
            style={{ color: 'var(--accent)' }}
            title="选中片段的位置/缩放/旋转/透明等所有关键帧一键自动贝塞尔（F3）"
            data-testid="kf-auto-bezier-all"
            onClick={() => useApp.getState().autoBezierAll()}
          >
            一键贝塞尔
          </button>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
          {isXy ? (
            <div className="flex items-center gap-2 shrink-0" data-testid="kf-xy-values">
              <PrKeyframeRow
                prop="x"
                label="X"
                clip={clip}
                playhead={playhead}
                displayValue={xVal}
                step={0.01}
                hideGraph
                hideEase
                onChange={(v) => setDynamicAtPlayhead('x', v)}
                onToggleKeyframe={() => toggleXy()}
                onGotoAdjacent={(_p, d) => gotoAdjacentKeyframe('x', d)}
                onSeek={(t) => seekKeepVisible(t)}
                onMoveKeyframe={moveXyTime}
              />
              <PrKeyframeRow
                prop="y"
                label="Y"
                clip={clip}
                playhead={playhead}
                displayValue={yVal}
                step={0.01}
                hideGraph
                hideEase
                onChange={(v) => setDynamicAtPlayhead('y', v)}
                onToggleKeyframe={() => toggleXy()}
                onGotoAdjacent={(_p, d) => gotoAdjacentKeyframe('y', d)}
                onSeek={(t) => seekKeepVisible(t)}
                onMoveKeyframe={moveXyTime}
              />
            </div>
          ) : (
            <PrKeyframeRow
              prop={activeProp}
              label={meta.label}
              clip={clip}
              playhead={playhead}
              displayValue={displayValue}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              unit={meta.unit}
              toUi={meta.toUi}
              toStore={meta.toStore}
              hideGraph
              hideEase
              onChange={(v) => setDynamicAtPlayhead(activeProp, v)}
              onToggleKeyframe={(p, v) => useApp.getState().toggleKeyframeAtPlayhead(p, v)}
              onGotoAdjacent={gotoAdjacentKeyframe}
              onSeek={(t) => seekKeepVisible(t)}
              onMoveKeyframe={setKeyframeTime}
            />
          )}
          <div className="pr-kf-ease pr-kf-ease--inline" data-testid={`kf-ease-${activeProp}`}>
            <div className="pr-kf-ease-btns">
              {EASE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`pr-kf-ease-btn${easeKf?.ease === p.id ? ' active' : ''}`}
                  disabled={!easeKf}
                  data-testid={`kf-ease-${activeProp}-${p.id}`}
                  onClick={() => {
                    if (!easeKf) return
                    if (isXy) setXyEase('x', easeKf.id, p.id)
                    else setKeyframeEase(activeProp, easeKf.id, p.id)
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 border-t flex-1" style={{ borderColor: 'var(--border)' }}>
        <div
          className="shrink-0 w-[76px] border-r flex items-center justify-center px-1"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          <span className="text-[10px] font-medium truncate" style={{ color: 'var(--text-muted)' }}>
            {isXy ? '位置速度' : `${meta.label}速度`}
          </span>
        </div>
        <div
          ref={kfScrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden min-w-0"
          data-testid="kf-timeline-scroll"
          onPointerDown={(e) => { startPan(e) }}
        >
          <div className="relative h-full" style={{ width: laneW, minHeight: 48 }} data-testid="kf-timeline-lane">
            <PrKeyframeRow
              prop={isXy ? 'x' : activeProp}
              label={isXy ? '位置' : meta.label}
              clip={isXy ? xyGraphClip : clip}
              playhead={playhead}
              displayValue={displayValue}
              graphOnly
              pxPerSec={pxPerSec}
              timelineSpan={timelineDuration}
              onChange={() => {}}
              onToggleKeyframe={() => {}}
              onGotoAdjacent={() => {}}
              onSeek={(t) => seekKeepVisible(t, { exact: true })}
              onMoveKeyframe={isXy ? moveXyTime : setKeyframeTime}
              onSetEase={isXy ? setXyEase : setKeyframeEase}
              onSetHandle={isXy ? setXyHandle : setKeyframeHandle}
              onEnableBezier={isXy ? undefined : enableBezierAt}
              onRemoveKeyframes={isXy ? removeXyByIds : removePropByIds}
              speedTracks={isXy ? xySpeedTracks : undefined}
              onAutoBezier={isXy ? autoBezierXy : (ids) => useApp.getState().autoBezierKeyframes({ [activeProp]: ids })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
