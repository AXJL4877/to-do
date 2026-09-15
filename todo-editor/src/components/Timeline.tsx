import { useMemo, useRef, useEffect, useCallback, useState, useSyncExternalStore } from 'react'
import {
  Lock, VolumeX, EyeOff, Magnet, Scissors, Trash2, ZoomIn, ZoomOut,
  MousePointer2, Hand, Undo2, Redo2, Save, FolderOpen, Download, MoreHorizontal,
} from 'lucide-react'
import { useApp, formatTime } from '../store'
import { parseMediaFiles, filesFromDataTransfer } from '../lib/importFiles'
import { acceptMediaDrop, readMediaDrag } from '../lib/mediaDrag'
import { desktop } from '../lib/desktop'
import {
  getPreviewBarRanges,
  getPreviewCacheRev,
  subscribePreviewCache,
} from '../lib/previewCache'
import { getLivePlayhead, setLivePlayhead, subscribeLivePlayhead } from '../lib/livePlayhead'
import { broadcastPlayheadSeek, setLocalPlayheadScrubbing } from '../lib/storeSync'
import { ContextMenu } from './ContextMenu'
import { TimelineClip } from './TimelineClip'
import { PlayheadOverlay } from './PlayheadOverlay'
import { TimelineFloatLaunch } from './TimelineFloat'
import clsx from 'clsx'
import type { RefObject } from 'react'

type DragKind = 'move' | 'trim-in' | 'trim-out' | 'playhead' | 'pan' | 'slip' | 'marquee'

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
  const previewCacheRev = useSyncExternalStore(subscribePreviewCache, getPreviewCacheRev, getPreviewCacheRev)
  const cacheRanges = useMemo(
    () => getPreviewBarRanges(Math.max(1, fps)),
    [previewCacheRev, fps],
  )
  const snap = useApp((s) => s.settings.snap)
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const tool = useApp((s) => s.tool)
  const timelineZoom = useApp((s) => s.timelineZoom)
  const setPlayhead = useApp((s) => s.setPlayhead)
  const selectClips = useApp((s) => s.selectClips)
  const toggleTrack = useApp((s) => s.toggleTrack)
  const setSnap = useApp((s) => s.setSnap)
  const razorAtPlayhead = useApp((s) => s.razorAtPlayhead)
  const deleteSelected = useApp((s) => s.deleteSelected)
  const linkSelected = useApp((s) => s.linkSelected)
  const unlinkSelected = useApp((s) => s.unlinkSelected)
  const trimClip = useApp((s) => s.trimClip)
  const trackAtY = useApp((s) => s.trackAtY)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const importMedia = useApp((s) => s.importMedia)
  const setTimelineZoom = useApp((s) => s.setTimelineZoom)
  const pushHistory = useApp((s) => s.pushHistory)
  const slipClip = useApp((s) => s.slipClip)
  const duplicateSelected = useApp((s) => s.duplicateSelected)
  const toggleClipEnabled = useApp((s) => s.toggleClipEnabled)
  const matchFrame = useApp((s) => s.matchFrame)
  const liftExtract = useApp((s) => s.liftExtract)
  const nestSelected = useApp((s) => s.nestSelected)
  const pasteAttributes = useApp((s) => s.pasteAttributes)
  const copyAttributes = useApp((s) => s.copyAttributes)
  const extractAudio = useApp((s) => s.extractAudio)
  const setTool = useApp((s) => s.setTool)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const canUndo = useApp((s) => s.history.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)
  const saveProjectToFile = useApp((s) => s.saveProjectToFile)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const monitorCompose = useApp((s) => s.monitorCompose)
  const setPropTab = useApp((s) => s.setPropTab)
  const setModal = useApp((s) => s.setModal)

  const [ctx, setCtx] = useState<{ x: number; y: number; clipId: string } | null>(null)
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
    startScrollLeft: number
    originStarts: Record<string, number>
    slipStart?: number
    moved: boolean
    marqueeX0?: number
    marqueeY0?: number
    marqueeAdditive?: boolean
    marqueeBase?: string[]
    lastDt?: number
    lastTrackId?: string
    moveIds?: string[]
  } | null>(null)

  const pxPerSec = timelineZoom

  const duration = useMemo(
    () => Math.max(seq.workOut, ...seq.clips.map((c) => c.start + c.duration), 12),
    [seq],
  )

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

  const trackFromEvent = useCallback((clientY: number) => {
    const el = bodyRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // body 随父级滚动，clientY-rect.top 已是内容坐标，勿再加 scrollTop
    return trackAtY(clientY - rect.top)
  }, [trackAtY])

  const clearMovePreview = useCallback((ids: string[]) => {
    const body = bodyRef.current
    if (!body) return
    for (const id of ids) {
      const el = body.querySelector(`[data-testid="clip-${id}"]`) as HTMLElement | null
      el?.style.removeProperty('transform')
    }
  }, [])

  useEffect(() => {
    const api = desktop()
    if (!api?.onMediaDrop) return
    return api.onMediaDrop(({ mediaId, x, y }) => {
      if (!acceptMediaDrop(mediaId)) return
      addClipFromMedia(mediaId, trackFromEvent(y) ?? undefined, timeFromEvent(x))
    })
  }, [addClipFromMedia, timeFromEvent, trackFromEvent])

  // 撤销/重做后清掉拖拽预览，避免盖住 React 计算的 left
  useEffect(() => {
    if (drag.current?.kind === 'move') return
    const body = bodyRef.current
    if (!body) return
    body.querySelectorAll('[data-testid^="clip-"]').forEach((node) => {
      (node as HTMLElement).style.removeProperty('transform')
    })
  }, [sequences])

  useEffect(() => {
    let phRaf = 0
    let pendingPh: number | null = null
    const flushPlayhead = () => {
      phRaf = 0
      if (pendingPh == null) return
      const t = pendingPh
      pendingPh = null
      useApp.getState().setPlayhead(t, { exact: true })
    }

    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const st = useApp.getState()
      if (d.kind === 'pan') {
        const el = scrollRef.current
        if (el) el.scrollLeft = d.startScrollLeft - (e.clientX - d.startX)
        return
      }
      if (d.kind === 'playhead') {
        d.moved = true
        const t = timeFromEvent(e.clientX)
        setLivePlayhead(t)
        broadcastPlayheadSeek(t)
        pendingPh = t
        if (!phRaf) phRaf = requestAnimationFrame(flushPlayhead)
        const el = scrollRef.current
        if (el) {
          const x = t * pxPerSec
          const m = 48
          if (x < el.scrollLeft + m) el.scrollLeft = Math.max(0, x - m)
          else if (x > el.scrollLeft + el.clientWidth - m) el.scrollLeft = x - el.clientWidth + m
        }
        return
      }
      if (d.kind === 'trim-in' && d.clipId) {
        d.moved = true
        st.trimClip(d.clipId, 'in', timeFromEvent(e.clientX), { record: false })
        return
      }
      if (d.kind === 'trim-out' && d.clipId) {
        d.moved = true
        st.trimClip(d.clipId, 'out', timeFromEvent(e.clientX), { record: false })
        return
      }
      if (d.kind === 'move' && d.clipId) {
        const dx = e.clientX - d.startX
        if (Math.abs(dx) > 2) d.moved = true
        const dt = dx / pxPerSec
        // 用按下时锁定的 moveIds，勿跟 selectedClipIds 漂移
        const ids = d.moveIds?.length ? d.moveIds : (st.selectedClipIds.length ? st.selectedClipIds : [d.clipId])
        const trackId = trackFromEvent(e.clientY) ?? undefined
        const appliedDt = st.previewDragDt(ids, d.originStarts, dt, {
          shift: e.shiftKey,
          alt: e.altKey,
          primaryId: d.clipId,
        })
        d.lastDt = appliedDt
        d.lastTrackId = trackId
        d.moveIds = ids
        const body = bodyRef.current
        if (body) {
          const dxPx = appliedDt * pxPerSec
          for (const id of ids) {
            const el = body.querySelector(`[data-testid="clip-${id}"]`) as HTMLElement | null
            if (!el) continue
            // 用 transform 预览，勿改 left——React 重绘会把 style.left 盖回 store 位置导致乱跳
            el.style.transform = dxPx ? `translateX(${dxPx}px)` : ''
          }
        }
        return
      }
      if (d.kind === 'marquee') {
        const body = bodyRef.current
        if (!body) return
        const rect = body.getBoundingClientRect()
        const x1 = e.clientX - rect.left
        const y1 = e.clientY - rect.top
        d.moved = Math.abs(x1 - (d.marqueeX0 ?? x1)) > 3 || Math.abs(y1 - (d.marqueeY0 ?? y1)) > 3
        const x0 = d.marqueeX0 ?? x1
        const y0 = d.marqueeY0 ?? y1
        const additive = !!d.marqueeAdditive
        const base = d.marqueeBase ?? []
        setMarquee({ x0, y0, x1, y1, additive, base })
        const left = Math.min(x0, x1)
        const right = Math.max(x0, x1)
        const top = Math.min(y0, y1)
        const bottom = Math.max(y0, y1)
        const cur = st.sequences.find((s) => s.id === st.activeSeqId) ?? st.sequences[0]
        const hits: string[] = []
        // 与 trackAtY / 轨行布局一致：顶部 CAM 占 22px
        let y = 22
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
        st.selectClips(additive ? [...new Set([...base, ...hits])] : hits)
        return
      }
      if (d.kind === 'slip' && d.clipId) {
        const dx = e.clientX - d.startX
        if (Math.abs(dx) > 2) d.moved = true
        d.slipStart = (d.slipStart ?? 0) + dx
        d.startX = e.clientX
        st.slipClip(dx / pxPerSec, { record: false })
      }
    }

    const onUp = () => {
      if (phRaf) {
        cancelAnimationFrame(phRaf)
        flushPlayhead()
      }
      if (drag.current?.kind === 'playhead') {
        setLocalPlayheadScrubbing(false)
      }
      const d = drag.current
      if (d?.kind === 'marquee' && !d.moved && !d.marqueeAdditive) {
        useApp.getState().selectClips([])
      }
      if (d?.kind === 'move' && d.moved && d.clipId && d.moveIds?.length) {
        // lastDt 已含吸附结果，alt 跳过二次吸附
        useApp.getState().dragMoveClips(
          d.moveIds,
          d.originStarts,
          d.lastDt ?? 0,
          d.lastTrackId,
          { primaryId: d.clipId, alt: true },
        )
        clearMovePreview(d.moveIds)
      }
      drag.current = null
      setMarquee(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (phRaf) cancelAnimationFrame(phRaf)
    }
  }, [pxPerSec, timeFromEvent, trackFromEvent, clearMovePreview])

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
        originStarts: {}, moved: false,
      }
      return
    }
    if (e.button !== 0) return
    // 刀片工具：标尺点击由 onRulerClick 处理，勿进入 scrub 把播放头拽走
    if (tool === 'razor') return
    setLocalPlayheadScrubbing(true)
    const t = timeFromEvent(e.clientX)
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    useApp.getState().setPlayhead(t, { exact: true })
    drag.current = { kind: 'playhead', startX: e.clientX, startScrollLeft: 0, originStarts: {}, moved: false }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onClipPointerDown(e: React.PointerEvent, clipId: string, trackLocked: boolean) {
    // 中键或 Alt+左键：平移时间线（Alt 不再占用「只选当前」）
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
      drag.current = {
        kind: 'pan', startX: e.clientX, startScrollLeft: scrollRef.current?.scrollLeft ?? 0,
        originStarts: {}, moved: false,
      }
      return
    }
    if (trackLocked || tool === 'hand') return
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
      // Ctrl+单击切换选中；Ctrl+拖动加选框选
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
          marqueeX0: x0,
          marqueeY0: y0,
          marqueeAdditive: true,
          marqueeBase: base,
        }
        setMarquee({ x0, y0, x1: x0, y1: y0, additive: true, base })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (!boxed) {
          const ids = base.includes(clipId)
            ? base.filter((id) => id !== clipId)
            : [...base, clipId]
          lastAnchorId.current = clipId
          selectClips(ids)
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    if (e.shiftKey && lastAnchorId.current) {
      const ordered = [...seq.clips].sort(
        (a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId),
      )
      const a = ordered.findIndex((c) => c.id === lastAnchorId.current)
      const b = ordered.findIndex((c) => c.id === clipId)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        ids = ordered.slice(lo, hi + 1).map((c) => c.id)
      } else {
        ids = [...new Set([...selectedClipIds, clipId])]
      }
      selectClips(ids)
      return
    }
    lastAnchorId.current = clipId
    ids = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId]
    // 默认带着链接的 A/V 一起动，避免音画时间线错位（Alt 只动当前）
    if (!e.altKey) {
      const linked = new Set(ids)
      for (const id of ids) {
        const c = seq.clips.find((x) => x.id === id)
        if (c?.linkedId) linked.add(c.linkedId)
        for (const o of seq.clips) {
          if (o.linkedId === id) linked.add(o.id)
        }
      }
      ids = [...linked]
    }
    selectClips(ids)

    if (tool === 'slip') {
      drag.current = {
        kind: 'slip', clipId, startX: e.clientX, startScrollLeft: 0,
        originStarts: {}, slipStart: 0, moved: false,
      }
      return
    }
    const starts: Record<string, number> = {}
    for (const id of ids) {
      const c = seq.clips.find((x) => x.id === id)
      if (c) starts[id] = c.start
    }
    drag.current = {
      kind: 'move', clipId, startX: e.clientX, startScrollLeft: 0,
      originStarts: starts, moved: false, moveIds: ids,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onTrimPointerDown(e: React.PointerEvent, clipId: string, edge: 'in' | 'out') {
    e.stopPropagation()
    pushHistory()
    drag.current = {
      kind: edge === 'in' ? 'trim-in' : 'trim-out',
      clipId, startX: e.clientX, startScrollLeft: 0, originStarts: {}, moved: false,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const t = timeFromEvent(e.clientX)
    const trackId = trackFromEvent(e.clientY) ?? undefined
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
        originStarts: {}, moved: false,
      }
      return
    }
    if (e.button !== 0) return
    // 剃刀：空白处点击 = 在当前帧切开（不挪播放头）
    if (tool === 'razor') {
      razorAtPlayhead()
      return
    }
    // Ctrl/Cmd：框选；否则空白处点击/拖动 = 播放头跟随
    if (e.ctrlKey || e.metaKey) {
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
        marqueeX0: x0,
        marqueeY0: y0,
        marqueeAdditive: true,
        marqueeBase: [...selectedClipIds],
      }
      setMarquee({ x0, y0, x1: x0, y1: y0, additive: true, base: [...selectedClipIds] })
      return
    }
    setLocalPlayheadScrubbing(true)
    const t = timeFromEvent(e.clientX)
    setLivePlayhead(t)
    broadcastPlayheadSeek(t)
    useApp.getState().setPlayhead(t, { exact: true })
    drag.current = { kind: 'playhead', startX: e.clientX, startScrollLeft: 0, originStarts: {}, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onWheel(e: React.WheelEvent) {
    // 用 Alt+滚轮缩放时间线，不拦截 Ctrl+滚轮（留给浏览器页面缩放）
    if (e.altKey) {
      e.preventDefault()
      setTimelineZoom(timelineZoom + (e.deltaY < 0 ? 8 : -8))
    } else if (tool === 'hand' || e.shiftKey) {
      scrollRef.current!.scrollLeft += e.deltaY
    }
  }

  return (
    <section
      className={clsx(
        'panel nle-timeline flex flex-col min-h-0 min-w-0 w-full overflow-hidden rounded-none border-x-0 border-b-0',
        fill ? 'flex-1 h-full' : 'shrink-0',
      )}
      style={fill ? undefined : { height: 'var(--timeline-h)' }}
      data-testid="timeline"
      data-tool={tool}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 px-2 py-1 border-b shrink-0 relative overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
        <button className="icon-btn" data-testid="btn-drafts" onClick={() => setModal('drafts')} title="草稿"><FolderOpen size={12} /></button>
        <button className="icon-btn" data-testid="btn-save" onClick={() => { void saveProjectToFile() }} title="保存 Ctrl+S"><Save size={12} /></button>
        <button className="icon-btn" data-testid="btn-undo" onClick={undo} disabled={!canUndo} title="撤销 Ctrl+Z" style={{ opacity: canUndo ? 1 : 0.35 }}><Undo2 size={12} /></button>
        <button className="icon-btn" data-testid="btn-redo" onClick={redo} disabled={!canRedo} title="重做 Ctrl+Shift+Z" style={{ opacity: canRedo ? 1 : 0.35 }}><Redo2 size={12} /></button>
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
        <button className="icon-btn" data-testid="tl-zoom-out" onClick={() => setTimelineZoom(timelineZoom - 10)} title="缩小"><ZoomOut size={12} /></button>
        <span className="text-[10px] tabular-nums w-7 text-center" style={{ color: 'var(--text-muted)' }}>{timelineZoom}</span>
        <button className="icon-btn" data-testid="tl-zoom-in" onClick={() => setTimelineZoom(timelineZoom + 10)} title="放大"><ZoomIn size={12} /></button>
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

      <div className="flex flex-1 min-h-0">
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
          <div
            className="flex items-center gap-0.5 px-1 border-b cursor-pointer"
            style={{ height: 22, borderColor: 'var(--border)', background: monitorCompose === '3d' ? 'var(--accent-dim)' : undefined }}
            data-testid="track-header-camera"
            onClick={() => { setPropTab('scene3d'); setMonitorCompose('3d') }}
            title="虚拟相机"
          >
            <span className="text-[10px] font-medium w-full truncate">CAM</span>
          </div>
          {seq.tracks.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-center gap-0.5 px-1 border-b"
              style={{ height: t.height, borderColor: 'var(--border)' }}
              title={t.name}
            >
              <button className={clsx('icon-btn', t.locked && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-lock-${t.id}`} onClick={() => toggleTrack(t.id, 'locked')} title={`${t.name} · 锁定`}><Lock size={11} /></button>
              <button className={clsx('icon-btn', t.muted && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-mute-${t.id}`} onClick={() => toggleTrack(t.id, 'muted')} title={`${t.name} · 静音`}><VolumeX size={11} /></button>
              <button className={clsx('icon-btn', t.hidden && 'active')} style={{ width: 22, height: 22 }} data-testid={`track-hide-${t.id}`} onClick={() => toggleTrack(t.id, 'hidden')} title={`${t.name} · 隐藏`}><EyeOff size={11} /></button>
            </div>
          ))}
        </div>

        <div
          ref={scrollRef}
          className={clsx('flex-1 min-w-0 relative overflow-y-auto', needHScroll ? 'overflow-x-auto' : 'overflow-x-hidden')}
          data-testid="timeline-body"
          onWheel={onWheel}
          onScroll={(e) => {
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
            {Array.from({ length: Math.ceil(layoutDur) + 1 }, (_, i) => (
              <span key={i} className="absolute text-[9px] tabular-nums" style={{ left: xAt(i) + 2, top: 3, color: 'var(--text-muted)' }}>{i}s</span>
            ))}
            {seq.markers.map((m) => (
              <div key={m.id} className="absolute top-0 bottom-0 w-0.5" style={{ left: xAt(m.t), background: m.color }} title={m.label} />
            ))}
            <div className="absolute top-0 bottom-0 w-0.5 z-20" style={{ left: xAt(seq.workIn), background: 'var(--accent)', opacity: 0.35 }} />
            <div className="absolute top-0 bottom-0 w-0.5 z-20" style={{ left: xAt(seq.workOut), background: 'var(--accent)', opacity: 0.35 }} />
            {/* 预览已缓存区间 */}
            <div
              className="absolute left-0 right-0 bottom-0 h-[3px] pointer-events-none"
              data-testid="preview-cache-bar"
              title={cacheRanges.length ? '绿色：已缓存预览' : '播放后将在此显示缓存进度'}
            >
              {cacheRanges.map((r, i) => (
                <div
                  key={`${r.start}-${r.end}-${i}`}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: xAt(r.start),
                    width: Math.max(2, xAt(r.end) - xAt(r.start)),
                    background: 'hsl(145 55% 42%)',
                    opacity: 0.9,
                  }}
                />
              ))}
            </div>
          </div>

          <div ref={bodyRef} className="relative" style={{ width: lanePx }} onPointerDown={onBodyPointerDown} data-testid="timeline-tracks">
            <div
              className="relative border-b"
              style={{ height: 22, borderColor: 'var(--border)', background: 'hsl(18 40% 50% / 0.08)' }}
              data-testid="track-row-camera"
              onClick={() => { setPropTab('scene3d'); setMonitorCompose('3d') }}
            >
              {Object.entries(seq.scene3d?.camera?.keyframes ?? {}).flatMap(([prop, kfs]) =>
                (kfs ?? []).map((k) => (
                  <span
                    key={`${prop}-${k.id}`}
                    className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rotate-45"
                    style={{ left: xAt(k.t) - 4, background: 'var(--accent)' }}
                    title={`${prop} @ ${k.t.toFixed(2)}s`}
                  />
                )),
              )}
            </div>
            {seq.tracks.map((track) => (
              <div
                key={track.id}
                className="relative border-b"
                style={{ height: track.height, borderColor: 'var(--border)', background: track.hidden ? 'var(--surface-2)' : 'transparent' }}
                data-testid={`track-row-${track.id}`}
              >
                {seq.clips.filter((c) => c.trackId === track.id).map((clip) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    track={track}
                    selected={selectedClipIds.includes(clip.id)}
                    tool={tool}
                    left={xAt(clip.start)}
                    width={xAt(clip.duration)}
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, track.locked)}
                    onTrimIn={(e) => !track.locked && onTrimPointerDown(e, clip.id, 'in')}
                    onTrimOut={(e) => !track.locked && onTrimPointerDown(e, clip.id, 'out')}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      selectClips([clip.id])
                      setCtx({ x: e.clientX, y: e.clientY, clipId: clip.id })
                    }}
                  />
                ))}
              </div>
            ))}


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
            <PlayheadOverlay xAt={xAt} />
          </div>
        </div>
      </div>

      <div className="px-2 py-1 border-t text-[10px] tabular-nums shrink-0 flex gap-3" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
        <TimelineTimecode fps={fps} duration={duration} />
        <span>选中后：1 静态 · 2 K帧 · 3 转场 · Tab 轮盘</span>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            { id: 'props', label: '静态属性（监视器）', shortcut: '1', onClick: () => useApp.getState().openPropWheelOnMonitor('static') },
            { id: 'split', label: '分割', shortcut: 'Ctrl+K', onClick: razorAtPlayhead },
            { id: 'dup', label: '复制', shortcut: 'Ctrl+D', onClick: duplicateSelected },
            { id: 'lift', label: '提升 (Lift)', onClick: () => liftExtract(false) },
            { id: 'extract', label: '抽出 (Extract)', onClick: () => liftExtract(true) },
            { id: 'nest', label: '嵌套复合片段', onClick: nestSelected },
            { id: 'copy-attrs', label: '复制属性', onClick: copyAttributes },
            { id: 'paste-attrs', label: '粘贴属性', onClick: pasteAttributes },
            { id: 'extract-audio', label: '提取音频', onClick: extractAudio },
            { id: 'del', label: '删除', shortcut: 'Del', danger: true, onClick: () => deleteSelected(true) },
            { id: 'enable', label: '启用/禁用', onClick: toggleClipEnabled },
            { id: 'match', label: '匹配帧', onClick: matchFrame },
            { id: 'link', label: '链接', onClick: linkSelected },
            { id: 'unlink', label: '解链', onClick: unlinkSelected },
          ]}
        />
      )}
    </section>
  )
}

function TimelineTimecode({ fps, duration }: { fps: number; duration: number }) {
  const t = useSyncExternalStore(subscribeLivePlayhead, getLivePlayhead, getLivePlayhead)
  return (
    <span data-testid="timecode-timeline">{formatTime(t, fps)} / {formatTime(duration, fps)}</span>
  )
}
