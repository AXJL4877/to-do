import { useMemo, useRef, useEffect, useLayoutEffect, useCallback, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import {
  Lock, VolumeX, EyeOff, Magnet, Scissors, Trash2, ZoomIn, ZoomOut,
  MousePointer2, Hand, Gauge, Undo2, Redo2, Save, FolderOpen, Download, MoreHorizontal, ListCollapse, AudioLines, Stamp,
} from 'lucide-react'
import { useApp, formatTime } from '../store'
import { clampZoom, fmtRulerTime, fmtZoom, rulerStep, stepZoom, wheelZoom } from '../lib/timelineZoom'
import { parseMediaFiles, filesFromDataTransfer } from '../lib/importFiles'
import { acceptMediaDrop, readMediaDrag } from '../lib/mediaDrag'
import { desktop } from '../lib/desktop'
import {
  getPreviewBarRanges,
  getPreviewCacheRev,
  markPreviewInteractive,
  subscribePreviewCache,
} from '../lib/previewCache'
import { getLivePlayhead, setLivePlayhead, subscribeLivePlayhead } from '../lib/livePlayhead'
import { broadcastPlayheadSeek, setLocalPlayheadScrubbing, isTimelinePopout } from '../lib/storeSync'
import { subtitleTargets } from '../lib/subtitleBurn'
import { SubtitleBurnDialog } from './SubtitleBurnDialog'
import { linkedClosure } from '../lib/clipLinks'
import { ContextMenu } from './ContextMenu'
import { TimelineClip, waveformDrawWidth } from './TimelineClip'
import { PlayheadOverlay } from './PlayheadOverlay'
import { TimelineLabels } from './TimelineLabels'
import { TimelineFloatLaunch } from './TimelineFloat'
import { indexClips } from '../lib/sequenceIndex'
import { useTimelineGeometryZoom } from '../lib/useTimelineGeometryZoom'
import clsx from 'clsx'
import type { RefObject } from 'react'

type DragKind = 'move' | 'trim-in' | 'trim-out' | 'rate-in' | 'rate-out' | 'playhead' | 'pan' | 'slip' | 'marquee'

export function Timeline({
  scrollRef: scrollRefProp,
  fill = false,
}: {
  scrollRef?: RefObject<HTMLDivElement | null>
  fill?: boolean
}) {
  const sequences = useApp((s) => s.sequences)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const seq = useMemo(
    () => sequences.find((s) => s.id === activeSeqId) ?? sequences[0],
    [sequences, activeSeqId],
  )
  const fps = useApp((s) => s.settings.fps)
  const snap = useApp((s) => s.settings.snap)
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const tool = useApp((s) => s.tool)
  const timelineZoom = useApp((s) => s.timelineZoom)
  const setPlayhead = useApp((s) => s.setPlayhead)
  const selectClips = useApp((s) => s.selectClips)
  const toggleTrack = useApp((s) => s.toggleTrack)
  const setTrackHeight = useApp((s) => s.setTrackHeight)
  const setSnap = useApp((s) => s.setSnap)
  const razorAtPlayhead = useApp((s) => s.razorAtPlayhead)
  const deleteSelected = useApp((s) => s.deleteSelected)
  const linkSelected = useApp((s) => s.linkSelected)
  const unlinkSelected = useApp((s) => s.unlinkSelected)
  const trimClip = useApp((s) => s.trimClip)
  const alignSelectedClips = useApp((s) => s.alignSelectedClips)
  const snapGuide = useApp((s) => s.snapGuide)
  const trackAtY = useApp((s) => s.trackAtY)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const importMedia = useApp((s) => s.importMedia)
  const setTimelineZoom = useApp((s) => s.setTimelineZoom)
  const pushHistory = useApp((s) => s.pushHistory)
  const slipClip = useApp((s) => s.slipClip)
  const setTool = useApp((s) => s.setTool)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const tidyTimeline = useApp((s) => s.tidyTimeline)
  const levelAudioLoudness = useApp((s) => s.levelAudioLoudness)
  const clipsByTrack = useMemo(() => indexClips(seq.clips).byTrack, [seq.clips])
  const canUndo = useApp((s) => s.history.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)
  const saveProjectToFile = useApp((s) => s.saveProjectToFile)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const monitorCompose = useApp((s) => s.monitorCompose)
  const setPropTab = useApp((s) => s.setPropTab)
  const setModal = useApp((s) => s.setModal)
  const timelineH = useApp((s) => s.layout.timelineH)
  const setLayout = useApp((s) => s.setLayout)
  const popout = isTimelinePopout()

  const [ctx, setCtx] = useState<{ x: number; y: number; clipId: string } | null>(null)
  const [burnClipIds, setBurnClipIds] = useState<string[] | null>(null)
  const closeBurn = useCallback(() => setBurnClipIds(null), [])
  const [marquee, setMarquee] = useState<null | {
    x0: number; y0: number; x1: number; y1: number; additive: boolean; base: string[]
  }>(null)
  const lastAnchorId = useRef<string | null>(null)

  const localScrollRef = useRef<HTMLDivElement>(null)
  // 选中含音轨片段时滚到可见，避免 A 轨在折叠区「看起来没入轨」
  useEffect(() => {
    const audioId = selectedClipIds.find((id) => {
      const c = seq.clips.find((x) => x.id === id)
      if (!c) return false
      return seq.tracks.find((t) => t.id === c.trackId)?.kind === 'audio'
    })
    if (!audioId) return
    const clip = seq.clips.find((c) => c.id === audioId)
    if (!clip) return
    const row = document.querySelector(`[data-testid="track-row-${clip.trackId}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedClipIds, seq.clips, seq.tracks])
  const scrollRef = scrollRefProp ?? localScrollRef
  const headersRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const syncingScroll = useRef(false)
  const drag = useRef<{
    kind: DragKind
    clipId?: string
    startX: number
    startY?: number
    startScrollLeft: number
    originStarts: Record<string, number>
    slipStart?: number
    moved: boolean
    pointerId?: number
    marqueeX0?: number
    marqueeY0?: number
    marqueeAdditive?: boolean
    marqueeBase?: string[]
    lastDt?: number
    lastTrackId?: string
    moveIds?: string[]
    originTrackIds?: Record<string, string>
    primaryKind?: string
    spawn?: 'before' | 'after'
    /** 多选时点中其一未拖动 → 松手收成当前 */
    collapseOnClick?: boolean
    collapseAlt?: boolean
    /** Shift 点下未拖动 → 松手做范围多选 */
    rangeIds?: string[]
  } | null>(null)

  const pxPerSec = timelineZoom
  const { geometryZoom, finish: finishGeometryZoom } = useTimelineGeometryZoom(pxPerSec, seq.id, drag.current !== null)
  const geometryScale = pxPerSec / geometryZoom
  // A zoom while the pointer is held must also rescale the existing move
  // preview, including when the user releases without another pointermove.
  useLayoutEffect(() => {
    const d = drag.current
    if (d?.kind !== 'move' || d.lastDt == null) return
    for (const id of d.moveIds ?? []) {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-testid="clip-${id}"]`)
      if (!el) continue
      const dy = new DOMMatrix(el.style.transform).m42
      el.style.transform = `translate(${d.lastDt * geometryZoom}px, ${dy}px)`
    }
  }, [geometryZoom])

  const duration = useMemo(
    () => Math.max(seq.workOut, ...seq.clips.map((c) => c.start + c.duration), 12),
    [seq],
  )

  // 轨区高度 = 真实轨道总和，不留空白假轨道
  // 弹出窗：不吃主窗 timelineH 上限；主窗：轨道变多时自动抬高面板（有屏幕上限），超出才内滚
  const RULER_H = 28
  const CHROME_H = 58 // 工具条 + 底栏时间码
  const tracksSum = useMemo(() => seq.tracks.reduce((a, t) => a + t.height, 0), [seq.tracks])
  const lanesNatural = RULER_H + tracksSum
  const dockMaxH = typeof window !== 'undefined'
    ? Math.max(280, Math.floor(window.innerHeight * 0.72))
    : 720
  const lanesCap = Math.max(80, Math.min(dockMaxH, timelineH) - CHROME_H)
  const lanesH = popout ? lanesNatural : Math.min(lanesNatural, lanesCap)

  // 主窗：轨道变多时抬高时间轴面板，避免被旧的 timelineH 卡死
  useEffect(() => {
    if (popout || fill) return
    const need = lanesNatural + CHROME_H
    if (need <= timelineH) return
    const next = Math.min(dockMaxH, need)
    if (next > timelineH) setLayout({ timelineH: next })
  }, [popout, fill, lanesNatural, timelineH, dockMaxH, setLayout])

  // 内容至少铺满可视区；用整数像素避免略超 clientWidth 冒出多余横向滚动条
  const [bodyW, setBodyW] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => setBodyW(el.clientWidth)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const lanePx = Math.max(Math.ceil(duration * pxPerSec), bodyW)
  const layoutDur = lanePx / Math.max(1, pxPerSec)
  const needHScroll = bodyW > 0 && lanePx > bodyW + 1
  const zoomScroll = useRef<{ zoom: number; left: number } | null>(null)
  const mouseClientX = useRef<number | null>(null)
  const zoomAtPointer = useCallback((next: number, clientX?: number) => {
    const el = scrollRef.current
    const prev = useApp.getState().timelineZoom
    const zoom = clampZoom(next)
    if (!el || zoom === prev) return
    const rect = el.getBoundingClientRect()
    const pointer = clientX ?? mouseClientX.current ?? (rect.left + el.clientWidth / 2)
    const x = Math.max(0, Math.min(el.clientWidth, pointer - rect.left))
    const left = zoomScroll.current?.zoom === prev ? zoomScroll.current.left : el.scrollLeft
    const time = (left + x) / prev
    const maxScroll = Math.max(0, Math.ceil(duration * zoom) - el.clientWidth)
    zoomScroll.current = { zoom, left: Math.max(0, Math.min(maxScroll, time * zoom - x)) }
    setTimelineZoom(zoom)
  }, [duration, scrollRef, setTimelineZoom])
  // 触控板一帧能来好几格滚轮：合成一次再改缩放，避免一格一次整表重渲染
  const zoomRaf = useRef(0)
  const zoomPending = useRef<{ zoom: number; x: number } | null>(null)
  const queueWheelZoom = useCallback((deltaY: number, clientX: number) => {
    const base = zoomPending.current?.zoom ?? useApp.getState().timelineZoom
    zoomPending.current = { zoom: wheelZoom(base, deltaY), x: clientX }
    if (zoomRaf.current) return
    zoomRaf.current = requestAnimationFrame(() => {
      zoomRaf.current = 0
      const pending = zoomPending.current
      zoomPending.current = null
      if (!pending) return
      markPreviewInteractive()
      zoomAtPointer(pending.zoom, pending.x)
    })
  }, [zoomAtPointer])
  useEffect(() => () => cancelAnimationFrame(zoomRaf.current), [])
  // Apply after the new lane width reaches the DOM; doing it earlier clamps
  // scrollLeft against the old width and makes the anchor jump near the end.
  useLayoutEffect(() => {
    const pending = zoomScroll.current
    if (pending?.zoom !== timelineZoom || !scrollRef.current) return
    scrollRef.current.scrollLeft = pending.left
    zoomScroll.current = null
  }, [timelineZoom, lanePx, scrollRef])

  // 鼠标滚轮一格 100px 直接跳显得卡顿：大步长缓动过去，触控板的小步长直接跟手
  const scrollAnim = useRef<{ target: number; raf: number } | null>(null)
  const stopSmoothScroll = useCallback(() => {
    if (scrollAnim.current) cancelAnimationFrame(scrollAnim.current.raf)
    scrollAnim.current = null
  }, [])
  const smoothScrollBy = useCallback((el: HTMLElement, dx: number) => {
    const a = scrollAnim.current
    if (!a && Math.abs(dx) < 40) { el.scrollLeft += dx; return }
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    const target = Math.max(0, Math.min(max, (a ? a.target : el.scrollLeft) + dx))
    if (a) { a.target = target; return }
    const s = { target, raf: 0 }
    scrollAnim.current = s
    const step = () => {
      const cur = el.scrollLeft
      const d = s.target - cur
      const next = Math.abs(d) <= 1 ? s.target : cur + Math.sign(d) * Math.max(1, Math.abs(d) * 0.3)
      el.scrollLeft = next
      // 到位或被边界卡住就停
      if (next === s.target || el.scrollLeft === cur) { scrollAnim.current = null; return }
      s.raf = requestAnimationFrame(step)
    }
    s.raf = requestAnimationFrame(step)
  }, [])

  // 按 256px 分档更新，前后留缓冲；选中和联动片段始终渲染，供拖动预览使用。
  const VIEW_CHUNK = 256
  const [viewLeft, setViewLeft] = useState(0)
  const onBodyScroll = useCallback((el: HTMLDivElement) => {
    setViewLeft(Math.floor(el.scrollLeft / VIEW_CHUNK) * VIEW_CHUNK)
  }, [])
  const pendingLeft = zoomScroll.current?.zoom === timelineZoom ? zoomScroll.current.left : null
  const viewW = bodyW || 2000
  const viewX0 = (pendingLeft ?? viewLeft) - VIEW_CHUNK
  const viewX1 = (pendingLeft ?? viewLeft) + viewW + 2 * VIEW_CHUNK
  const visibleStart = viewX0 / pxPerSec
  const visibleEnd = viewX1 / pxPerSec
  const retainedWindow = useRef({ sequenceId: seq.id, start: visibleStart, end: visibleEnd })
  const previousWindow = retainedWindow.current
  const unionStart = Math.min(previousWindow.start, visibleStart)
  const unionEnd = Math.max(previousWindow.end, visibleEnd)
  // Keep edge clips alive across direction changes, but bound retention if the
  // user also scrolls a long distance during a burst. Reclaim immediately at rest.
  retainedWindow.current = geometryZoom !== pxPerSec && previousWindow.sequenceId === seq.id
    && unionEnd - unionStart <= (visibleEnd - visibleStart) * 3
    ? { sequenceId: seq.id, start: unionStart, end: unionEnd }
    : { sequenceId: seq.id, start: visibleStart, end: visibleEnd }
  const renderWindow = retainedWindow.current
  const pinnedClips = useMemo(
    () => new Set(selectedClipIds.length ? linkedClosure(seq.clips, selectedClipIds) : []),
    [seq.clips, selectedClipIds],
  )

  const ruler = rulerStep(pxPerSec)

  const xAt = useCallback((t: number) => t * pxPerSec, [pxPerSec])

  const timeAtX = useCallback((x: number) => {
    const t = x / pxPerSec
    return snap ? Math.round(t * fps) / fps : t
  }, [pxPerSec, snap, fps])

  const timeFromEvent = useCallback((clientX: number) => {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    return Math.max(0, timeAtX(x))
  }, [timeAtX])

  /** 拖播放头：按住 Shift 吸到附近片段切口 / 标记（和拖片段对齐切口一样） */
  const playheadTimeFromEvent = useCallback((e: { clientX: number; shiftKey: boolean }) => {
    const st = useApp.getState()
    const raw = timeFromEvent(e.clientX)
    if (e.shiftKey) return st.snapPlayheadTime(raw, pxPerSec)
    st.setSnapGuide(null)
    return raw
  }, [timeFromEvent, pxPerSec])

  const clearMovePreview = useCallback((ids: string[]) => {
    const body = bodyRef.current
    if (!body) return
    for (const id of ids) {
      const el = body.querySelector(`[data-testid="clip-${id}"]`) as HTMLElement | null
      if (!el) continue
      el.style.removeProperty('transform')
      el.style.removeProperty('z-index')
    }
  }, [])

  /** 按指针 Y 命中轨道；拖离同 kind 区域时返回 spawn 以新建轨道 */
  const trackFromEvent = useCallback((clientY: number, kind?: string): {
    trackId: string | null
    spawn?: 'before' | 'after'
  } => {
    const body = bodyRef.current
    if (!body) return { trackId: null }
    const kindTracks = seq.tracks.filter((t) => !kind || t.kind === kind)
    const rows = kindTracks
      .map((t) => {
        const el = body.querySelector(`[data-testid="track-row-${t.id}"]`) as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { id: t.id, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, height: r.height }
      })
      .filter(Boolean) as { id: string; top: number; bottom: number; mid: number; height: number }[]

    if (!rows.length) {
      const rect = body.getBoundingClientRect()
      return { trackId: trackAtY(clientY - rect.top) }
    }

    const hit = rows.find((r) => clientY >= r.top && clientY < r.bottom)
    if (hit) return { trackId: hit.id }

    const margin = Math.max(12, rows[0].height * 0.35)
    if (clientY < rows[0].top - margin) return { trackId: null, spawn: 'before' }
    if (clientY >= rows[rows.length - 1].bottom + margin) return { trackId: null, spawn: 'after' }

    // 缝隙：落到最近轨道
    let best = rows[0]
    let bestDist = Math.abs(clientY - rows[0].mid)
    for (const r of rows) {
      const dist = Math.abs(clientY - r.mid)
      if (dist < bestDist) { bestDist = dist; best = r }
    }
    return { trackId: best.id }
  }, [seq.tracks, trackAtY])

  useEffect(() => {
    const api = desktop()
    if (!api?.onMediaDrop) return
    return api.onMediaDrop(({ mediaId, x, y }) => {
      if (!acceptMediaDrop(mediaId)) return
      addClipFromMedia(mediaId, trackFromEvent(y).trackId ?? undefined, timeFromEvent(x))
    })
  }, [addClipFromMedia, timeFromEvent, trackFromEvent])

  // 撤销/重做后清掉拖拽预览，避免盖住 React 计算的 left
  useEffect(() => {
    if (drag.current?.kind === 'move') return
    const body = bodyRef.current
    if (!body) return
    body.querySelectorAll('[data-testid^="clip-"]').forEach((node) => {
      const el = node as HTMLElement
      el.style.removeProperty('transform')
      el.style.removeProperty('z-index')
    })
  }, [sequences])

  useEffect(() => {
    let pendingPh: number | null = null

    const endPlayheadScrub = (commit: boolean) => {
      if (drag.current?.kind !== 'playhead') return
      const t = pendingPh
      const moved = drag.current.moved
      pendingPh = null
      setLocalPlayheadScrubbing(false)
      drag.current = null
      useApp.getState().setSnapGuide(null)
      if (commit && t != null) {
        useApp.getState().setPlayhead(t, { exact: true })
        broadcastPlayheadSeek(t)
      }
      // 点空白轨（未拖播放头）→ 清空片段选中，才能再单独点选
      if (!moved) useApp.getState().selectClips([])
    }

    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      // 只跟启动拖拽的那根指针；避免空格/失焦后另一指针串台
      if (d.pointerId != null && e.pointerId !== d.pointerId) return

      const st = useApp.getState()
      if (d.kind === 'pan') {
        // 中键松开后 buttons 不再含 4；左键平移同理
        if (d.pointerId != null && e.buttons === 0) {
          drag.current = null
          return
        }
        const el = scrollRef.current
        if (el) el.scrollLeft = d.startScrollLeft - (e.clientX - d.startX)
        return
      }
      if (d.kind === 'playhead') {
        // 未按住主键：立刻结束 scrub，杜绝「空格后仍粘鼠标」
        if ((e.buttons & 1) === 0) {
          endPlayheadScrub(true)
          return
        }
        d.moved = true
        const t = playheadTimeFromEvent(e)
        markPreviewInteractive()
        // 拖动中只改 live 时钟（播放头/监视器订阅），不写 Zustand、不广播——避免掉帧
        setLivePlayhead(t)
        pendingPh = t
        const el = scrollRef.current
        if (el) {
          const x = t * pxPerSec
          const m = 64
          if (x < el.scrollLeft + m) el.scrollLeft = Math.max(0, x - m)
          else if (x > el.scrollLeft + el.clientWidth - m) el.scrollLeft = x - el.clientWidth + m
        }
        return
      }
      if (d.kind === 'trim-in' && d.clipId) {
        if ((e.buttons & 1) === 0) { drag.current = null; return }
        d.moved = true
        st.trimClip(d.clipId, 'in', timeFromEvent(e.clientX), { record: false, free: e.altKey, strong: e.shiftKey, pxPerSec })
        return
      }
      if (d.kind === 'trim-out' && d.clipId) {
        if ((e.buttons & 1) === 0) { drag.current = null; return }
        d.moved = true
        st.trimClip(d.clipId, 'out', timeFromEvent(e.clientX), { record: false, free: e.altKey, strong: e.shiftKey, pxPerSec })
        return
      }
      if ((d.kind === 'rate-in' || d.kind === 'rate-out') && d.clipId) {
        if ((e.buttons & 1) === 0) { drag.current = null; return }
        d.moved = true
        st.rateStretchClip(d.clipId, d.kind === 'rate-in' ? 'in' : 'out', timeFromEvent(e.clientX), { record: false, free: e.altKey, strong: e.shiftKey, pxPerSec })
        return
      }
      if (d.kind === 'move' && d.clipId) {
        if ((e.buttons & 1) === 0) {
          if (d.moved && d.moveIds?.length) {
            useApp.getState().dragMoveClips(
              d.moveIds, d.originStarts, d.lastDt ?? 0, d.lastTrackId,
              { primaryId: d.clipId, alt: true, spawn: d.spawn },
            )
            clearMovePreview(d.moveIds)
          }
          drag.current = null
          return
        }
        const dx = e.clientX - d.startX
        const startY = d.startY ?? e.clientY
        if (Math.abs(dx) > 2 || Math.abs(e.clientY - startY) > 2) d.moved = true
        const dt = dx / pxPerSec
        const ids = d.moveIds?.length ? d.moveIds : [d.clipId]
        const kind = d.primaryKind
          ?? st.seq().tracks.find((t) => t.id === st.seq().clips.find((c) => c.id === d.clipId)?.trackId)?.kind
        const place = trackFromEvent(e.clientY, kind)
        const trackId = place.trackId ?? undefined
        const appliedDt = st.previewDragDt(ids, d.originStarts, dt, {
          shift: e.shiftKey,
          alt: e.altKey,
          primaryId: d.clipId,
          pxPerSec,
          trackId,
        })
        d.lastDt = appliedDt
        d.lastTrackId = trackId
        d.spawn = place.spawn
        // 禁止中途改成 selectedClipIds（否则会拖上全体）
        d.moveIds = ids
        const body = bodyRef.current
        if (body) {
          const dxPx = appliedDt * pxPerSec
          // 与 store.flushDragMove 一致：同 kind 片段按主片段的轨道偏移整体平移，保持上下间距
          const kindTracks = kind ? st.seq().tracks.filter((t) => t.kind === kind) : []
          const rowRects = kindTracks.map((t) =>
            body.querySelector(`[data-testid="track-row-${t.id}"]`)?.getBoundingClientRect())
          const laneOf = (id: string) => {
            const tid = d.originTrackIds?.[id] ?? st.seq().clips.find((c) => c.id === id)?.trackId
            return kindTracks.findIndex((t) => t.id === tid)
          }
          const pIdx = laneOf(d.clipId)
          const destIdx = place.spawn === 'before' ? -1
            : place.spawn === 'after' ? kindTracks.length
              : kindTracks.findIndex((t) => t.id === trackId)
          const delta = pIdx >= 0 && (place.spawn || destIdx >= 0) ? destIdx - pIdx : 0
          const rowTop = (i: number) => {
            const first = rowRects[0], last = rowRects[rowRects.length - 1]
            if (!first || !last) return undefined
            if (i < 0) return first.top + i * first.height
            if (i >= rowRects.length) return last.bottom + (i - rowRects.length) * last.height
            return rowRects[i]?.top
          }
          for (const id of ids) {
            const el = body.querySelector(`[data-testid="clip-${id}"]`) as HTMLElement | null
            if (!el) continue
            const src = laneOf(id)
            let dyPx = 0
            if (delta && src >= 0) {
              const from = rowTop(src), to = rowTop(src + delta)
              if (from != null && to != null) dyPx = to - from
            }
            el.style.zIndex = '40'
            el.style.transform = (dxPx || dyPx) ? `translate(${dxPx}px, ${dyPx}px)` : ''
          }
        }
        return
      }
      if (d.kind === 'marquee') {
        if ((e.buttons & 1) === 0) {
          drag.current = null
          setMarquee(null)
          return
        }
        const body = bodyRef.current
        if (!body) return
        const rect = body.getBoundingClientRect()
        // 任意方向：始终用内容坐标 + min/max 归一化，不依赖拖拽象限
        const x1 = e.clientX - rect.left
        const y1 = e.clientY - rect.top
        const x0 = d.marqueeX0 ?? x1
        const y0 = d.marqueeY0 ?? y1
        d.moved = Math.abs(x1 - x0) > 3 || Math.abs(y1 - y0) > 3
        const additive = !!d.marqueeAdditive
        const base = d.marqueeBase ?? []
        setMarquee({ x0, y0, x1, y1, additive, base })
        const left = Math.min(x0, x1)
        const right = Math.max(x0, x1)
        const top = Math.min(y0, y1)
        const bottom = Math.max(y0, y1)
        const cur = st.sequences.find((s) => s.id === st.activeSeqId) ?? st.sequences[0]
        const hits: string[] = []
        let y = 0
        for (const track of cur.tracks) {
          for (const clip of cur.clips.filter((c) => c.trackId === track.id)) {
            const cx0 = clip.start * pxPerSec
            const cx1 = (clip.start + clip.duration) * pxPerSec
            const cy0 = y
            const cy1 = y + track.height
            if (cx1 >= left && cx0 <= right && cy1 >= top && cy0 <= bottom) hits.push(clip.id)
          }
          y += track.height
        }
        const next = additive ? [...new Set([...base, ...hits])] : hits
        const prev = st.selectedClipIds
        if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
          st.selectClips(next)
        }
        return
      }
      if (d.kind === 'slip' && d.clipId) {
        if ((e.buttons & 1) === 0) { drag.current = null; return }
        const dx = e.clientX - d.startX
        if (Math.abs(dx) > 2) d.moved = true
        d.slipStart = (d.slipStart ?? 0) + dx
        d.startX = e.clientX
        st.slipClip(dx / pxPerSec, { record: false })
      }
    }

    const onUp = (e: PointerEvent) => {
      const d = drag.current
      if (d?.pointerId != null && e.pointerId !== d.pointerId) return
      if (d?.kind === 'playhead') {
        endPlayheadScrub(true)
        return
      }
      if (d?.kind === 'marquee' && !d.moved && !d.marqueeAdditive) {
        useApp.getState().selectClips([])
      }
      if (d?.kind === 'move' && d.clipId) {
        if (d.moved && d.moveIds?.length) {
          useApp.getState().dragMoveClips(
            d.moveIds,
            d.originStarts,
            d.lastDt ?? 0,
            d.lastTrackId,
            { primaryId: d.clipId, alt: true, spawn: d.spawn },
          )
          clearMovePreview(d.moveIds)
        } else if (d.rangeIds) {
          useApp.getState().selectClips(d.rangeIds)
        } else if (d.collapseOnClick) {
          // 多选中单击未拖 → 收成当前片段（+链接 A/V）
          const st = useApp.getState()
          const cur = st.sequences.find((s) => s.id === st.activeSeqId) ?? st.sequences[0]
          st.selectClips(d.collapseAlt ? [d.clipId] : linkedClosure(cur.clips, [d.clipId]))
        }
      }
      drag.current = null
      setMarquee(null)
      useApp.getState().setSnapGuide(null)
    }

    const onCancel = (e: PointerEvent) => {
      if (drag.current?.pointerId != null && e.pointerId !== drag.current.pointerId) return
      if (drag.current?.kind === 'playhead') {
        endPlayheadScrub(true)
        return
      }
      if (drag.current?.kind === 'move' && drag.current.moveIds) clearMovePreview(drag.current.moveIds)
      drag.current = null
      setMarquee(null)
      useApp.getState().setSnapGuide(null)
      setLocalPlayheadScrubbing(false)
      pendingPh = null
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('lostpointercapture', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('lostpointercapture', onCancel)
    }
  }, [pxPerSec, timeFromEvent, playheadTimeFromEvent, trackFromEvent, clearMovePreview])

  function onRulerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (tool === 'hand') return
    if (tool === 'razor') {
      // 剃刀：在当前选中帧（播放头）切开，不跟鼠标 X、不挪播放头
      razorAtPlayhead()
      return
    }
    const t = timeFromEvent(e.clientX)
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    setPlayhead(t)
  }

  function onRulerPointerDown(e: React.PointerEvent) {
    // 中键 / Alt+左键 / 抓手：平移时间线
    if (e.button === 1 || tool === 'hand' || (e.button === 0 && e.altKey)) {
      e.preventDefault()
    drag.current = {
      kind: 'pan', startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
      originStarts: {}, moved: false, pointerId: e.pointerId,
    }
      return
    }
    if (e.button !== 0) return
    // 刀片工具：标尺点击由 onRulerClick 处理，勿进入 scrub 把播放头拽走
    if (tool === 'razor') return
    // scrub 时停播，避免空格播放与拖拽抢 playhead
    if (useApp.getState().playing) useApp.setState({ playing: false })
    setLocalPlayheadScrubbing(true)
    const t = playheadTimeFromEvent(e)
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    useApp.getState().setPlayhead(t, { exact: true })
    drag.current = {
      kind: 'playhead',
      startX: e.clientX,
      startScrollLeft: 0,
      originStarts: {},
      moved: false,
      pointerId: e.pointerId,
    }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* */ }
  }

  function expandLinkedAv(clipIds: string[], withLinked: boolean) {
    if (!withLinked) return [...clipIds]
    return linkedClosure(seq.clips, clipIds)
  }

  function onClipPointerDown(e: React.PointerEvent, clipId: string, trackLocked: boolean) {
    // 中键或 Alt+左键：平移时间线（Alt 不再占用「只选当前」）
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
    drag.current = {
      kind: 'pan', startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
      originStarts: {}, moved: false, pointerId: e.pointerId,
    }
      return
    }
    if (trackLocked || tool === 'hand') return
    e.preventDefault()
    e.stopPropagation()
    if (tool === 'razor') {
      razorAtPlayhead()
      return
    }
    if (tool === 'trim' || tool === 'roll' || tool === 'slide') {
      selectClips([clipId])
      return
    }
    let ids: string[]
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+单击切换选中；Ctrl+拖动任意方向加选框选
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const base = [...selectedClipIds]
      let boxed = false
      const onMove = (ev: PointerEvent) => {
        if (boxed) return
        if (Math.abs(ev.clientX - startX) <= 4 && Math.abs(ev.clientY - startY) <= 4) return
        boxed = true
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        const body = bodyRef.current
        if (!body) return
        const rect = body.getBoundingClientRect()
        const x0 = startX - rect.left
        const y0 = startY - rect.top
        drag.current = {
          kind: 'marquee',
          startX,
          startScrollLeft: 0,
          originStarts: {},
          moved: true,
          pointerId: e.pointerId,
          marqueeX0: x0,
          marqueeY0: y0,
          marqueeAdditive: true,
          marqueeBase: base,
        }
        setMarquee({ x0, y0, x1: x0, y1: y0, additive: true, base })
        try { body.setPointerCapture(e.pointerId) } catch { /* */ }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (!boxed) {
          const next = base.includes(clipId)
            ? base.filter((id) => id !== clipId)
            : [...base, clipId]
          lastAnchorId.current = clipId
          selectClips(next)
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    // Shift：点一下不拖 = 范围多选（松手时生效）；按住拖 = 移动当前片段并强吸附到附近切口
    let rangeIds: string[] | undefined
    if (e.shiftKey && lastAnchorId.current) {
      const ordered = [...seq.clips].sort(
        (a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId),
      )
      const a = ordered.findIndex((c) => c.id === lastAnchorId.current)
      const b = ordered.findIndex((c) => c.id === clipId)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        rangeIds = ordered.slice(lo, hi + 1).map((c) => c.id)
      } else {
        rangeIds = [...new Set([...selectedClipIds, clipId])]
      }
    } else {
      lastAnchorId.current = clipId
    }
    // 普通单击：只选当前（+链接 A/V）。多选后点其中之一再拖才整组移动；
    // 若点下未拖动，松手时收成当前（见 onUp），避免「永远拖全体」。
    const keepMulti = selectedClipIds.includes(clipId) && selectedClipIds.length > 1
    ids = keepMulti ? [...selectedClipIds] : [clipId]
    // Alt：只动当前，不带链接音画
    ids = expandLinkedAv(ids, !e.altKey)
    selectClips(ids)

    if (tool === 'slip') {
      drag.current = {
        kind: 'slip', clipId, startX: e.clientX, startScrollLeft: 0,
        originStarts: {}, slipStart: 0, moved: false,
      }
      return
    }
    const starts: Record<string, number> = {}
    const originTrackIds: Record<string, string> = {}
    for (const id of ids) {
      const c = seq.clips.find((x) => x.id === id)
      if (c) {
        starts[id] = c.start
        originTrackIds[id] = c.trackId
      }
    }
    const primary = seq.clips.find((c) => c.id === clipId)
    const primaryKind = seq.tracks.find((t) => t.id === primary?.trackId)?.kind
    pushHistory()
    drag.current = {
      kind: 'move', clipId, startX: e.clientX, startY: e.clientY, startScrollLeft: 0,
      originStarts: starts, originTrackIds, primaryKind, moved: false, moveIds: ids,
      pointerId: e.pointerId,
      // 多选时单击未拖：松手收成当前
      collapseOnClick: keepMulti,
      collapseAlt: e.altKey,
      rangeIds,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onTrimPointerDown(e: React.PointerEvent, clipId: string, edge: 'in' | 'out') {
    e.stopPropagation()
    pushHistory()
    drag.current = {
      kind: tool === 'rate' ? (edge === 'in' ? 'rate-in' : 'rate-out') : (edge === 'in' ? 'trim-in' : 'trim-out'),
      clipId, startX: e.clientX, startScrollLeft: 0, originStarts: {}, moved: false,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const t = timeFromEvent(e.clientX)
    const trackId = trackFromEvent(e.clientY).trackId ?? undefined
    const mediaId = readMediaDrag(e.dataTransfer)
    if (mediaId) {
      if (acceptMediaDrop(mediaId)) addClipFromMedia(mediaId, trackId, t)
      return
    }
    const files = filesFromDataTransfer(e.dataTransfer)
    if (!files.length) return
    const parsed = await parseMediaFiles(files)
    const ids = importMedia(parsed)
    if (ids[0]) addClipFromMedia(ids[0], trackId, t)
  }


  function onBodyPointerDown(e: React.PointerEvent) {
    // 中键 / Alt+左键 / 抓手：平移
    if (e.button === 1 || tool === 'hand' || (e.button === 0 && e.altKey)) {
      e.preventDefault()
    drag.current = {
      kind: 'pan', startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
      originStarts: {}, moved: false, pointerId: e.pointerId,
    }
      return
    }
    if (e.button !== 0) return
    // 剃刀：空白处点击 = 在当前帧切开（不挪播放头）
    if (tool === 'razor') {
      razorAtPlayhead()
      return
    }
    // Ctrl/Cmd：任意方向框选；否则空白处点击/拖动 = 播放头跟随
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      const x0 = e.clientX - rect.left
      const y0 = e.clientY - rect.top
      drag.current = {
        kind: 'marquee',
        startX: e.clientX,
        startScrollLeft: 0,
        originStarts: {},
        moved: false,
        pointerId: e.pointerId,
        marqueeX0: x0,
        marqueeY0: y0,
        marqueeAdditive: true,
        marqueeBase: [...selectedClipIds],
      }
      setMarquee({ x0, y0, x1: x0, y1: y0, additive: true, base: [...selectedClipIds] })
      try { body.setPointerCapture(e.pointerId) } catch { /* */ }
      return
    }
    setLocalPlayheadScrubbing(true)
    if (useApp.getState().playing) useApp.setState({ playing: false })
    const t = timeFromEvent(e.clientX)
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    useApp.getState().setPlayhead(t, { exact: true })
    drag.current = {
      kind: 'playhead',
      startX: e.clientX,
      startScrollLeft: 0,
      originStarts: {},
      moved: false,
      pointerId: e.pointerId,
    }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* */ }
  }

  // Alt+滚轮缩放；Ctrl / Shift+滚轮（或手型工具）左右移动。须用非被动的原生监听才拦得住页面缩放
  const wheelRef = useRef({ tool, queueWheelZoom })
  wheelRef.current = { tool, queueWheelZoom }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault()
        if (e.deltaY === 0) return
        stopSmoothScroll()
        wheelRef.current.queueWheelZoom(e.deltaY, e.clientX)
      } else if (e.ctrlKey || e.shiftKey || wheelRef.current.tool === 'hand') {
        e.preventDefault()
        smoothScrollBy(el, e.deltaY || e.deltaX)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); stopSmoothScroll() }
  }, [setTimelineZoom, smoothScrollBy, stopSmoothScroll])

  // 片段回调保持同一引用，TimelineClip 的 memo 才生效：缩放 / 滚动时没变的片段不重渲染
  const clipHandlers = useRef({ onClipPointerDown, onTrimPointerDown, selectedClipIds })
  clipHandlers.current = { onClipPointerDown, onTrimPointerDown, selectedClipIds }
  const clipEvents = useMemo(() => ({
    down: (e: React.PointerEvent, id: string, locked: boolean) => clipHandlers.current.onClipPointerDown(e, id, locked),
    trim: (e: React.PointerEvent, id: string, edge: 'in' | 'out', locked: boolean) => {
      if (!locked) clipHandlers.current.onTrimPointerDown(e, id, edge)
    },
    menu: (e: React.MouseEvent, id: string) => {
      e.preventDefault()
      if (!clipHandlers.current.selectedClipIds.includes(id)) useApp.getState().selectClips([id])
      setCtx({ x: e.clientX, y: e.clientY, clipId: id })
    },
  }), [])

  const rulerFrom = Math.max(0, Math.floor(viewX0 / pxPerSec / ruler))
  const rulerTo = Math.min(Math.floor(layoutDur / ruler), Math.ceil(viewX1 / pxPerSec / ruler))

  return (
    <section
      className={clsx(
        'panel nle-timeline flex flex-col min-h-0 min-w-0 w-full overflow-hidden rounded-none border-x-0 border-b-0 select-none',
        fill ? 'flex-1 h-full' : 'shrink-0',
      )}
      style={popout || fill ? undefined : { height: 'auto', maxHeight: Math.min(dockMaxH, timelineH) }}
      data-testid="timeline"
      data-tool={tool}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 px-2 py-1 border-b shrink-0 relative overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
        <button className="icon-btn" data-testid="btn-drafts" onClick={() => setModal('drafts')} title="项目"><FolderOpen size={12} /></button>
        <button className="icon-btn" data-testid="btn-save" onClick={() => { void saveProjectToFile() }} title="保存 Ctrl+S"><Save size={12} /></button>
        <button className="icon-btn" data-testid="btn-undo" onClick={undo} disabled={!canUndo} title="撤销 Ctrl+Z" style={{ opacity: canUndo ? 1 : 0.35 }}><Undo2 size={12} /></button>
        <button className="icon-btn" data-testid="btn-redo" onClick={redo} disabled={!canRedo} title="重做 Ctrl+Shift+Z" style={{ opacity: canRedo ? 1 : 0.35 }}><Redo2 size={12} /></button>
        <button className="btn shrink-0 text-[10px] flex items-center gap-1" data-testid="btn-tidy-timeline" onClick={tidyTimeline}
          title="将可合并的片段整理到更少轨道，保持时间与上下层关系；跳过锁定、隐藏、静音和独奏轨道，可撤销">
          <ListCollapse size={12} />一键整理
        </button>
        <button
          className="btn shrink-0 text-[10px] flex items-center gap-1"
          data-testid="btn-loudness"
          onClick={() => { void levelAudioLoudness() }}
          title="一键调音：把音频响度统一到约 -16 LUFS。有选中则只调选中，否则整条时间线；可撤销"
        >
          <AudioLines size={12} />一键调音
        </button>
        <button
          className="btn shrink-0 text-[10px] flex items-center gap-1"
          data-testid="btn-watermark"
          onClick={() => setModal('watermark')}
          title="设计水印：改文案、字号、排版，应用到时间线或存进媒体库"
        >
          <Stamp size={12} />水印
        </button>
        <button
          className="btn shrink-0 text-[10px] flex items-center gap-1"
          data-testid="btn-douyin"
          onClick={() => setModal('douyin')}
          title="投放到抖音发布台（inbox），打开发布页填稿；不点发作品"
        >
          抖音
        </button>
        <div className="w-px h-4 shrink-0" style={{ background: 'var(--border)' }} />
        <button
          className={clsx('icon-btn text-[10px] font-semibold', monitorCompose === '3d' && 'active')}
          data-testid="tl-compose-3d"
          title="3D 摄像机"
          onClick={() => { setMonitorCompose(monitorCompose === '3d' ? '2d' : '3d'); setPropTab('scene3d') }}
        >
          3D
        </button>
        <div className="flex items-center gap-0.5 p-0.5 rounded-md shrink-0" style={{ background: 'var(--surface-2)' }}>
          {([
            ['select', MousePointer2, '选择 (V)'],
            ['razor', Scissors, '剃刀剪切 (C)'],
            ['rate', Gauge, '比率拉伸 (R，鼠标在时间轴上时)：拖片段边缘，缩短加速、拉长减速'],
            ['hand', Hand, '手型 (H)'],
          ] as const).map(([id, Icon, tip]) => (
            <button key={id} className={clsx('icon-btn', tool === id && 'active')} style={{ width: 26, height: 26 }} data-testid={`tool-${id}`} onClick={() => setTool(id)} title={tip}>
              <Icon size={13} strokeWidth={1.75} />
            </button>
          ))}
        </div>
        <button className={clsx('icon-btn', snap && 'active')} data-testid="tl-snap" onClick={() => setSnap(!snap)} title="吸附"><Magnet size={12} /></button>
        <button className="icon-btn" data-testid="tl-split" onClick={razorAtPlayhead} title="分割"><Scissors size={12} /></button>
        <button className="icon-btn" data-testid="tl-delete" onClick={() => deleteSelected(true)} title="删除"><Trash2 size={12} /></button>
        <div className="w-px h-4 shrink-0" style={{ background: 'var(--border)' }} />
        <button className="icon-btn" data-testid="tl-zoom-out" onClick={() => zoomAtPointer(stepZoom(timelineZoom, -1))} title="以鼠标位置为中心缩小"><ZoomOut size={12} /></button>
        <span className="text-[10px] tabular-nums w-7 text-center" style={{ color: 'var(--text-muted)' }}>{fmtZoom(timelineZoom)}</span>
        <button className="icon-btn" data-testid="tl-zoom-in" onClick={() => zoomAtPointer(stepZoom(timelineZoom, 1))} title="以鼠标位置为中心放大"><ZoomIn size={12} /></button>
        <span className="text-[11px] tabular-nums ml-1 truncate max-w-[10ch]" style={{ color: 'var(--text-muted)' }}>{seq.name}</span>
        <div className="flex-1" />
        <TimelineFloatLaunch />
        <button
          className="btn btn-ghost shrink-0"
          data-testid="tl-more"
          onClick={() => setModal('more')}
        >
          <MoreHorizontal size={12} />更多
        </button>
        <button className="icon-btn shrink-0" data-testid="btn-export" onClick={() => setModal('export')} title="导出成片" aria-label="导出"><Download size={13} /></button>
      </div>

      <div
        className="flex shrink-0 min-h-0"
        style={{ height: lanesH, maxHeight: fill ? '100%' : undefined }}
      >
        {/* 左侧轨头：顶部留出与标尺同高的占位，否则轨名会整体上移一行对不齐 */}
        <div
          ref={headersRef}
          className="shrink-0 w-[76px] border-r overflow-y-auto overflow-x-hidden"
          style={{ borderColor: 'var(--border)' }}
          data-testid="track-headers"
          onScroll={(e) => {
            const body = scrollRef.current
            if (!body || syncingScroll.current) return
            syncingScroll.current = true
            body.scrollTop = (e.target as HTMLDivElement).scrollTop
            requestAnimationFrame(() => { syncingScroll.current = false })
          }}
        >
          <div className="sticky top-0 z-10 h-7 border-b shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }} />
          {seq.tracks.map((t) => (
            <div
              key={t.id}
              className="relative flex items-center justify-center gap-0.5 px-1 border-b"
              style={{ height: t.height, borderColor: 'var(--border)' }}
              title={`${t.name} · 拖底边调高度`}
              data-testid={`track-header-${t.id}`}
            >
              <span className="absolute left-0.5 top-0 text-[8px] leading-none pointer-events-none" style={{ color: 'var(--text-muted)' }}>{t.name}</span>
              <button className={clsx('icon-btn', t.locked && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-lock-${t.id}`} onClick={() => toggleTrack(t.id, 'locked')} title={`${t.name} · 锁定`}><Lock size={11} /></button>
              <button className={clsx('icon-btn', t.muted && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-mute-${t.id}`} onClick={() => toggleTrack(t.id, 'muted')} title={`${t.name} · 静音`}><VolumeX size={11} /></button>
              <button className={clsx('icon-btn', t.hidden && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-hide-${t.id}`} onClick={() => toggleTrack(t.id, 'hidden')} title={`${t.name} · 隐藏`}><EyeOff size={11} /></button>
              <div
                className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize z-10 hover:bg-[var(--accent)]/35"
                data-testid={`track-resize-${t.id}`}
                title="拖动调节轨道高度"
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  const startY = e.clientY
                  const origin = t.height
                  const el = e.currentTarget
                  el.setPointerCapture(e.pointerId)
                  const onMove = (ev: PointerEvent) => {
                    setTrackHeight(t.id, origin + (ev.clientY - startY))
                  }
                  const onUp = () => {
                    el.removeEventListener('pointermove', onMove)
                    el.removeEventListener('pointerup', onUp)
                    try { el.releasePointerCapture(e.pointerId) } catch { /* */ }
                  }
                  el.addEventListener('pointermove', onMove)
                  el.addEventListener('pointerup', onUp)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  const def = t.kind === 'audio' ? 40 : t.kind === 'subtitle' ? 28 : 48
                  setTrackHeight(t.id, def)
                }}
              />
            </div>
          ))}
        </div>

        <div
          ref={scrollRef}
          className={clsx('flex-1 min-w-0 relative overflow-y-auto', needHScroll ? 'overflow-x-auto' : 'overflow-x-hidden')}
          data-testid="timeline-body"
          onPointerDownCapture={() => {
            if (geometryZoom !== pxPerSec) flushSync(finishGeometryZoom)
          }}
          onPointerMove={(e) => { mouseClientX.current = e.clientX }}
          onScroll={(e) => {
            onBodyScroll(e.currentTarget)
            const headers = headersRef.current
            if (!headers || syncingScroll.current) return
            syncingScroll.current = true
            headers.scrollTop = (e.target as HTMLDivElement).scrollTop
            requestAnimationFrame(() => { syncingScroll.current = false })
          }}
        >
          <div
            className="sticky top-0 z-10 h-7 border-b cursor-pointer select-none relative"
            style={{ width: lanePx, borderColor: 'var(--border)', background: 'var(--surface-2)' }}
            onClick={onRulerClick}
            onPointerDown={onRulerPointerDown}
            data-testid="timeline-ruler"
          >
            {Array.from({ length: Math.max(0, rulerTo - rulerFrom + 1) }, (_, k) => {
              const i = rulerFrom + k
              return <span key={i} className="absolute text-[9px] tabular-nums" style={{ left: xAt(i * ruler) + 2, top: 3, color: 'var(--text-muted)' }}>{fmtRulerTime(i * ruler, ruler)}</span>
            })}
            {seq.markers.map((m) => (
              <div key={m.id} className="absolute top-0 bottom-0 w-0.5" style={{ left: xAt(m.t), background: m.color }} title={m.label} />
            ))}
            <div className="absolute top-0 bottom-0 w-0.5 z-20" style={{ left: xAt(seq.workIn), background: 'var(--accent)', opacity: 0.35 }} />
            <div className="absolute top-0 bottom-0 w-0.5 z-20" style={{ left: xAt(seq.workOut), background: 'var(--accent)', opacity: 0.35 }} />
            {/* 预览已缓存区间 */}
            <PreviewCacheBar fps={fps} pxPerSec={pxPerSec} />
          </div>

          <div ref={bodyRef} className="relative" style={{ width: lanePx, overflow: 'clip' }} onPointerDown={onBodyPointerDown} data-testid="timeline-tracks">
            <div data-testid="timeline-geometry" style={{
              width: Math.max(duration * geometryZoom, bodyW / geometryScale),
              transform: `scaleX(${geometryScale})`, transformOrigin: 'left top',
            }}>
            {seq.tracks.map((track) => (
              <div
                key={track.id}
                className="relative border-b"
                style={{ height: track.height, borderColor: 'var(--border)', background: track.hidden ? 'var(--surface-2)' : 'transparent' }}
                data-testid={`track-row-${track.id}`}
              >
                {(clipsByTrack.get(track.id) ?? []).map((clip) => {
                  if ((clip.start + clip.duration < renderWindow.start || clip.start > renderWindow.end) && !pinnedClips.has(clip.id)) return null
                  return (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      track={track}
                      selected={selectedClipIds.includes(clip.id)}
                      tool={tool}
                      geometryZoom={geometryZoom}
                      trimmable={clip.duration * geometryZoom >= 12}
                      waveW={track.kind === 'audio' ? waveformDrawWidth(clip.duration * geometryZoom) : 0}
                      onPointerDown={clipEvents.down}
                      onTrim={clipEvents.trim}
                      onContextMenu={clipEvents.menu}
                    />
                  )
                })}
                <div
                  className="absolute left-0 right-0 bottom-0 h-1 cursor-ns-resize z-20"
                  data-testid={`track-row-resize-${track.id}`}
                  title="拖动调节轨道高度"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    const startY = e.clientY
                    const origin = track.height
                    const el = e.currentTarget
                    el.setPointerCapture(e.pointerId)
                    const onMove = (ev: PointerEvent) => {
                      setTrackHeight(track.id, origin + (ev.clientY - startY))
                    }
                    const onUp = () => {
                      el.removeEventListener('pointermove', onMove)
                      el.removeEventListener('pointerup', onUp)
                      try { el.releasePointerCapture(e.pointerId) } catch { /* */ }
                    }
                    el.addEventListener('pointermove', onMove)
                    el.addEventListener('pointerup', onUp)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    const def = track.kind === 'audio' ? 40 : track.kind === 'subtitle' ? 28 : 48
                    setTrackHeight(track.id, def)
                  }}
                />
              </div>
            ))}
            </div>

            <TimelineLabels seq={seq} pxPerSec={pxPerSec} scrollRef={scrollRef} viewportWidth={bodyW} />
            {marquee && (
              <div
                data-testid="marquee-rect"
                className="absolute z-40 pointer-events-none border border-dashed"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                  borderColor: 'var(--accent)',
                  background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
                }}
              />
            )}
            {snapGuide != null && (
              <div
                data-testid="tl-snap-guide"
                className="absolute top-0 bottom-0 z-30 pointer-events-none"
                style={{ left: xAt(snapGuide), width: 1, background: 'var(--accent)', boxShadow: '0 0 0 0.5px var(--accent)' }}
              />
            )}
            <PlayheadOverlay xAt={xAt} />
          </div>
        </div>
      </div>

      <div className="px-2 py-1 border-t text-[10px] tabular-nums shrink-0 select-none" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
        <TimelineTimecode fps={fps} duration={duration} />
      </div>

      {ctx && (() => {
        const subs = subtitleTargets(selectedClipIds)
        const burnItem = subs.audio.length ? [{
          id: 'burn-subtitles',
          label: subs.burnable.length > 1 ? `烧录字幕（${subs.burnable.length} 段）` : '烧录字幕',
          disabled: !subs.burnable.length,
          onClick: () => setBurnClipIds(subs.burnable.map((b) => b.clip.id)),
        }] : []
        const sel = new Set(selectedClipIds)
        const hasLink = seq.clips.some((c) => c.linkedId && (sel.has(c.id) || sel.has(c.linkedId)))
        return (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            ...burnItem,
            { id: 'align-start', label: '头对齐', disabled: selectedClipIds.length < 2, onClick: () => alignSelectedClips('start') },
            { id: 'align-end', label: '尾对齐', disabled: selectedClipIds.length < 2, onClick: () => alignSelectedClips('end') },
            { id: 'link', label: '链接', disabled: selectedClipIds.length < 2, onClick: linkSelected },
            { id: 'unlink', label: '解链', disabled: !hasLink, onClick: unlinkSelected },
          ]}
        />
        )
      })()}
      {burnClipIds && <SubtitleBurnDialog clipIds={burnClipIds} onClose={closeBurn} />}
    </section>
  )
}

function PreviewCacheBar({ fps, pxPerSec }: { fps: number; pxPerSec: number }) {
  const rev = useSyncExternalStore(subscribePreviewCache, getPreviewCacheRev, getPreviewCacheRev)
  const ranges = useMemo(() => getPreviewBarRanges(Math.max(1, fps)), [rev, fps])
  return (
    <div className="absolute left-0 right-0 bottom-0 h-[3px] pointer-events-none"
      data-testid="preview-cache-bar" title={ranges.length ? '绿色：已缓存预览' : '播放后将在此显示缓存进度'}>
      {ranges.map((r, i) => <div key={`${r.start}-${r.end}-${i}`} className="absolute top-0 bottom-0"
        style={{ left: r.start * pxPerSec, width: Math.max(2, (r.end - r.start) * pxPerSec), background: 'hsl(145 55% 42%)', opacity: 0.9 }} />)}
    </div>
  )
}

function TimelineTimecode({ fps, duration }: { fps: number; duration: number }) {
  const t = useSyncExternalStore(subscribeLivePlayhead, getLivePlayhead, getLivePlayhead)
  return (
    <span
      data-testid="timecode-timeline"
      className="select-none pointer-events-none"
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      {formatTime(t, fps)} / {formatTime(duration, fps)}
    </span>
  )
}
