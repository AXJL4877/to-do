import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Repeat, Camera } from 'lucide-react'
import { useApp, formatTime } from '../store'
import { resolveClipTransform, patchClipXY } from '../lib/keyframeEval'
import {
  autoCacheProgramFrames,
  cancelPrefetchProgramFrames,
  ensurePreviewFingerprint,
  getProgramPreviewCache,
  presentCachedProgramFrame,
  fingerprintOf,
  markPreviewInteractive,
  readAheadFromDisk,
  stableCacheSize,
} from '../lib/previewCache'
import { getPreviewSize, hitTestMotionPathKf, hitTestProgramClips, renderProgramFrame, renderProgramOverlay, renderSourceFrame } from '../lib/monitorDraw'
import { cancelComposeUpgrade } from '../lib/composePreview'
import { pictureClipsAt } from '../lib/programPlayer'
import { indexClips, indexMedia } from '../lib/sequenceIndex'
import { clipHalfNorm, snapWithGuides, type SnapGuide } from '../lib/monitorSnap'
import { useImageCache } from '../hooks/useImageCache'
import { getLivePlayhead, setLivePlayhead, subscribeLivePlayhead } from '../lib/livePlayhead'
import { setVideoSeekQuiet } from '../lib/videoCache'
import { stopNativePlaySession } from '../lib/nativePlayBridge'
import { broadcastLivePlayhead } from '../lib/storeSync'
import { syncProgramAudio, stopProgramAudio } from '../lib/programAudio'
import { Monitor3dViewport } from './Monitor3dViewport'
import { webglOk } from '../lib/scene3d'
import {
  isNativePreviewActive,
  pushTimeline,
  reportPreviewRect,
  seekToPlayhead,
  startNativePreview,
  stopNativePreview,
} from '../lib/nativePreviewBridge'
import clsx from 'clsx'

/** 画布缓冲坐标：object-fit:contain 时要把 letterbox 算进去 */
function clientToNorm(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return { nx: 0, ny: 0 }
  }
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const dw = canvas.width * scale
  const dh = canvas.height * scale
  const ox = rect.left + (rect.width - dw) / 2
  const oy = rect.top + (rect.height - dh) / 2
  if (dw <= 0 || dh <= 0) return { nx: 0, ny: 0 }
  const nx = ((clientX - ox) / dw) * 2 - 1
  const ny = ((clientY - oy) / dh) * 2 - 1
  return { nx, ny }
}

export function Monitor({ mode, compact = false }: { mode: 'source' | 'program' | 'edit'; compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const localPlayhead = useRef(0)
  const dragRef = useRef<null | {
    kind: 'clip' | 'path-kf'
    ids: string[]
    origin: Record<string, { x: number; y: number }>
    startNx: number
    startNy: number
    axis: 'free' | 'x' | 'y'
    moved: boolean
    pending?: Record<string, { x: number; y: number }>
    pathT?: number
    pathOrigin?: { x: number; y: number }
    primaryId?: string
  }>(null)
  /** 视口 CSS 像素（3D 用）；2D 用 object-fit 铺满视口 */
  const [display, setDisplay] = useState({ w: 0, h: 0 })
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const viewZoomRef = useRef(1)
  const viewPanRef = useRef({ x: 0, y: 0 })
  const notifiedCache = useRef('')
  const paintRef = useRef<(
    t: number,
    transformOverrides?: Record<string, { x: number; y: number }>,
    opts?: { playing?: boolean; guides?: SnapGuide[] },
  ) => void>(() => {})

  const media = useApp((s) => s.media)
  const settings = useApp((s) => s.settings)
  const prefs = useApp((s) => s.prefs)
  const playing = useApp((s) => s.playing)
  const loop = useApp((s) => s.loop)
  const sourceMediaId = useApp((s) => s.sourceMediaId)
  const sourceIn = useApp((s) => s.sourceIn)
  const sourceOut = useApp((s) => s.sourceOut)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const sequences = useApp((s) => s.sequences)
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const autoKeyframe = useApp((s) => s.autoKeyframe)
  const togglePlay = useApp((s) => s.togglePlay)
  const stepFrame = useApp((s) => s.stepFrame)
  const setPlayhead = useApp((s) => s.setPlayhead)
  const setLoop = useApp((s) => s.setLoop)
  const setSourceIO = useApp((s) => s.setSourceIO)
  const setFullscreen = useApp((s) => s.setFullscreen)
  const fullscreen = useApp((s) => s.fullscreen)
  const threePointEdit = useApp((s) => s.threePointEdit)
  const updateSettings = useApp((s) => s.updateSettings)
  const selectClips = useApp((s) => s.selectClips)
  const pushHistory = useApp((s) => s.pushHistory)
  const monitorCompose = useApp((s) => s.monitorCompose)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const captureFrame = useApp((s) => s.captureFrame)
  const monitorView = useApp((s) => s.monitorView)

  const isSeq = mode === 'program' || mode === 'edit'
  const isEdit = mode === 'edit'
  const isProgram = mode === 'program'
  // 双窗时只由节目窗推墙钟+音频，编辑窗跟 live 画，避免双循环
  const drivesClock = isProgram || (isEdit && monitorView !== 'dual')

  const { cache: imgCache, version: imgVersion } = useImageCache(media)
  const preview = getPreviewSize(settings, prefs.performance)
  const use3d = isEdit && monitorCompose === '3d' && webglOk()

  const on3dFallback = useCallback(() => {
    setMonitorCompose('2d')
    useApp.getState().setToast('WebGL 不可用，已回退 2D 监视器')
  }, [setMonitorCompose])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    // 2D canvas scales with CSS; only the 3D viewport needs React dimensions.
    if (!use3d) return
    const measure = (entries?: ResizeObserverEntry[]) => {
      const rect = entries?.[0]?.contentRect
      const w = Math.round(rect?.width ?? el.clientWidth), h = Math.round(rect?.height ?? el.clientHeight)
      setDisplay(prev => prev.w === w && prev.h === h ? prev : { w, h })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [use3d])

  /** B2：节目窗上报 CSS 矩形；nativePreview 时隐藏 canvas 绘制 */
  const nativePreview = settings.nativePreview
  const [nativeOn, setNativeOn] = useState(false)
  useEffect(() => {
    if (!isProgram) return
    let alive = true
    if (nativePreview && !fullscreen) {
      void startNativePreview().then((ok) => { if (alive) setNativeOn(ok && isNativePreviewActive()) })
    } else {
      void stopNativePreview().then(() => { if (alive) setNativeOn(false) })
    }
    return () => { alive = false }
  }, [isProgram, nativePreview, fullscreen])

  useEffect(() => {
    if (!isProgram || !nativeOn) return
    const el = viewportRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      reportPreviewRect({ x: r.x, y: r.y, w: r.width, h: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('scroll', report, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', report, true)
    }
  }, [isProgram, nativeOn])

  useEffect(() => {
    if (!isProgram || !nativeOn) return
    void pushTimeline()
    void seekToPlayhead()
    return useApp.subscribe((s, p) => { if (s.playhead !== p.playhead) void seekToPlayhead() })
  }, [isProgram, nativeOn, activeSeqId, sequences, media, playing])

  useEffect(() => {
    if (!isSeq) return
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - el.clientWidth / 2
      const cy = e.clientY - rect.top - el.clientHeight / 2
      const z = viewZoomRef.current
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const next = Math.min(4, Math.max(0.25, Math.round(z * factor * 100) / 100))
      if (next === z || !z) return
      const k = next / z
      const p = viewPanRef.current
      const pan = { x: cx * (1 - k) + p.x * k, y: cy * (1 - k) + p.y * k }
      viewZoomRef.current = next
      viewPanRef.current = pan
      setViewZoom(next)
      setViewPan(pan)
    }
    const blockMid = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('mousedown', blockMid)
    el.addEventListener('auxclick', blockMid)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('mousedown', blockMid)
      el.removeEventListener('auxclick', blockMid)
    }
  }, [isSeq])

  function resetView() {
    viewZoomRef.current = 1
    viewPanRef.current = { x: 0, y: 0 }
    setViewZoom(1)
    setViewPan({ x: 0, y: 0 })
  }

  function onViewportPointerDown(e: React.PointerEvent) {
    if (!isSeq || e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const ox = viewPanRef.current.x
    const oy = viewPanRef.current.y
    const onMove = (ev: PointerEvent) => {
      const next = { x: ox + (ev.clientX - startX), y: oy + (ev.clientY - startY) }
      viewPanRef.current = next
      setViewPan(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const viewDirty = viewZoom !== 1 || viewPan.x !== 0 || viewPan.y !== 0
  const viewTransform =
    isSeq && viewDirty
      ? `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`
      : undefined

  const autoCacheTimer = useRef(0)
  const scheduleAutoCache = useCallback((frame: number) => {
    window.clearTimeout(autoCacheTimer.current)
    autoCacheTimer.current = window.setTimeout(() => {
      autoCacheTimer.current = 0
      const st = useApp.getState()
      if (st.playing) return
      const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
      autoCacheProgramFrames({
        cache: getProgramPreviewCache(),
        fromFrame: frame,
        fps: Math.max(1, st.settings.fps),
        seq,
        media: st.media,
        settings: st.settings,
        imgCache: imgCache.current,
        maxEdge: st.prefs.previewCacheMaxEdge ?? 720,
      })
    }, 180)
  }, [imgCache])
  useEffect(() => () => window.clearTimeout(autoCacheTimer.current), [])

  const paint = useCallback((t: number, transformOverrides?: Record<string, { x: number; y: number }>, opts?: { playing?: boolean; guides?: SnapGuide[] }) => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (mode === 'source') {
      canvas.width = preview.w
      canvas.height = preview.h
      const m = media.find((x) => x.id === sourceMediaId)
      const sub = m ? `${m.kind} · ${formatTime(sourceIn)} — ${formatTime(sourceOut)}` : undefined
      renderSourceFrame(canvas, media, sourceMediaId, imgCache.current, m ? `${m.name}${sub ? `\n${sub}` : ''}` : '未选择素材')
      return
    }
    const st = useApp.getState()
    const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
    const w = preview.w
    const h = preview.h
    const fps = Math.max(1, st.settings.fps)
    const frame = Math.max(0, Math.floor(t * fps + 1e-6))
    const maxEdge = st.prefs.previewCacheMaxEdge ?? 720

    // 拖动中：编辑窗必须带 override，不能走缓存
    if (isEdit && transformOverrides) {
      renderProgramFrame(
        canvas, seq, media, settings, t, imgCache.current, w, h,
        st.selectedClipIds, transformOverrides, st.autoKeyframe, opts?.guides, false,
      )
      return
    }

    // 节目底图：驱动钟可合成；跟窗只贴共享帧/缓存，禁止双窗抢解码
    presentCachedProgramFrame(
      getProgramPreviewCache(), frame, fps, canvas, seq, media, settings,
      imgCache.current, w, h, maxEdge,
      {
        playing: !!(opts?.playing || st.playing),
        followOnly: !!(st.playing && !drivesClock),
      },
    )

    if (isEdit) {
      renderProgramOverlay(
        canvas, seq, settings, t, w, h,
        st.selectedClipIds, st.autoKeyframe, opts?.guides,
      )
    }

    // 静止时后台自动缓存整条序列；拖播放头/缩放时先别开，合成会和预览抢主线程
    if (!st.playing && !opts?.playing) scheduleAutoCache(frame)
  }, [mode, isProgram, isEdit, drivesClock, media, settings, sourceMediaId, sourceIn, sourceOut, preview.w, preview.h, imgCache, imgVersion, selectedClipIds, autoKeyframe, scheduleAutoCache])

  paintRef.current = paint

  // 拖播放头/连续改动时一帧只画一次，指针事件比刷新率密得多
  const paintRaf = useRef(0)
  const paintT = useRef(0)
  const schedulePaint = useCallback((t: number) => {
    markPreviewInteractive()
    paintT.current = t
    if (paintRaf.current) return
    paintRaf.current = requestAnimationFrame(() => {
      paintRaf.current = 0
      paintRef.current(paintT.current)
    })
  }, [])
  const cancelScheduledPaint = useCallback(() => {
    cancelAnimationFrame(paintRaf.current)
    paintRaf.current = 0
  }, [])
  useEffect(() => cancelScheduledPaint, [cancelScheduledPaint])

  // 只订阅 store.playhead 变化，不让整个监视器随播放头重渲染；勿在媒体缓存 bump 时把 live 拽回旧时间
  useEffect(() => {
    if (use3d) return
    if (isSeq && playing) return
    const sync = (t: number) => {
      if (dragRef.current) return
      localPlayhead.current = t
      setLivePlayhead(t)
      schedulePaint(t)
    }
    sync(useApp.getState().playhead)
    return useApp.subscribe((s, p) => { if (s.playhead !== p.playhead) sync(s.playhead) })
  }, [playing, mode, use3d, isSeq, schedulePaint])

  // 素材/选中/序列变化：按当前 live 重画，不改播放头
  useEffect(() => {
    if (use3d) return
    if (isSeq && playing) return
    if (dragRef.current) return
    schedulePaint(getLivePlayhead())
  }, [paint, selectedClipIds, sequences, activeSeqId, autoKeyframe, use3d, mode, playing, isSeq, schedulePaint])

  // 跟 live：非驱动钟的编辑窗在双窗播放时也要画；驱动钟自己在 tick 里画
  useEffect(() => {
    if (use3d || !isSeq) return
    if (drivesClock && playing) return
    return subscribeLivePlayhead(() => {
      if (dragRef.current) return
      const t = getLivePlayhead()
      if (Math.abs(t - localPlayhead.current) < 1e-4) return
      const fps = Math.max(1, useApp.getState().settings.fps)
      if (playing && Math.floor(t * fps) === Math.floor(localPlayhead.current * fps)) return
      localPlayhead.current = t
      schedulePaint(t)
    })
  }, [use3d, isSeq, playing, drivesClock, schedulePaint])

  // 墙钟播放环：仅 drivesClock 的窗负责推进 + 音频
  // 注意：deps 不含 media/paint——代理生成会换 media 引用，重建循环会闪一下并重置墙钟
  useEffect(() => {
    if (use3d || !drivesClock || !playing) return
    window.clearTimeout(autoCacheTimer.current)
    autoCacheTimer.current = 0
    cancelScheduledPaint()
    cancelPrefetchProgramFrames()
    cancelComposeUpgrade()
    void stopNativePlaySession()
    setVideoSeekQuiet(true)
    let raf = 0
    const st0 = useApp.getState()
    const fps = Math.max(1, st0.settings.fps)
    const tStart = st0.playhead
    const wall0 = performance.now()
    let lastShown = -1
    // 叠层缺代理的素材停播后再转码：播放中起 ffmpeg 会和多路解码抢 CPU
    const proxyWanted = new Set<string>()
    const cache = getProgramPreviewCache()
    const maxEdge = st0.prefs.previewCacheMaxEdge ?? 720
    const { w: cw0, h: ch0 } = stableCacheSize(settings, maxEdge)
    const seq0 = st0.sequences.find((q) => q.id === st0.activeSeqId) ?? st0.sequences[0]
    ensurePreviewFingerprint(cache, fingerprintOf(seq0, settings, cw0, ch0, st0.media), cw0, ch0)
    notifiedCache.current = ''
    localPlayhead.current = tStart
    setLivePlayhead(tStart)
    broadcastLivePlayhead(tStart)

    const seqEnd = (seq: typeof st0.sequences[0]) =>
      Math.max(seq.workOut, indexClips(seq.clips).end, 5)

    const tick = (now: number) => {
      const st = useApp.getState()
      const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
      const canvas = canvasRef.current
      if (!canvas) {
        raf = requestAnimationFrame(tick)
        return
      }

      const end = seqEnd(seq)
      // UI clock follows the display refresh rate; only video presentation is frame-quantized.
      let t = tStart + (now - wall0) / 1000
      if (t >= end) {
        if (st.loop) {
          const span = Math.max(0.05, end - seq.workIn)
          t = seq.workIn + ((t - seq.workIn) % span)
        } else {
          void stopNativePlaySession()
          const mediaNow = st.media
          presentCachedProgramFrame(
            cache, Math.max(0, Math.floor(end * fps + 1e-6)), fps, canvas, seq, mediaNow, st.settings,
            imgCache.current, preview.w, preview.h, maxEdge, { playing: true },
          )
          setLivePlayhead(end)
          broadcastLivePlayhead(end)
          useApp.setState({ playing: false, playhead: end })
          return
        }
      }

      const frame = Math.max(0, Math.floor(t * fps + 1e-6))
      localPlayhead.current = t

      if (frame !== lastShown) {
        lastShown = frame
        const mediaNow = st.media
        const mediaById = indexMedia(mediaNow)
        const videoClips = pictureClipsAt(seq, t).filter(c => mediaById.get(c.mediaId ?? '')?.kind === 'video')
        for (const c of videoClips) if (c.mediaId) proxyWanted.add(c.mediaId)
        const dw = preview.w
        const dh = preview.h

        presentCachedProgramFrame(
          cache, frame, fps, canvas, seq, mediaNow, st.settings,
          imgCache.current, dw, dh, maxEdge, { playing: true },
        )
        readAheadFromDisk(cache, frame, fps)
        if (isEdit) {
          renderProgramOverlay(
            canvas, seq, st.settings, t, dw, dh,
            st.selectedClipIds, st.autoKeyframe,
          )
        }
        if (frame % 2 === 0) broadcastLivePlayhead(t)
      }

      setLivePlayhead(t)
      syncProgramAudio(seq, st.media, t, true, fps)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelPrefetchProgramFrames()
      cancelComposeUpgrade()
      stopProgramAudio()
      setVideoSeekQuiet(false)
      cancelAnimationFrame(raf)
      void stopNativePlaySession()
      if (proxyWanted.size) useApp.getState().ensureStackProxies([...proxyWanted])
      const current = useApp.getState().playhead
      const endT = Math.abs(current - tStart) < 1e-4 ? localPlayhead.current : current
      if (Math.abs(current - tStart) < 1e-4) {
        useApp.setState({ playhead: endT })
      }
      setLivePlayhead(endT)
      requestAnimationFrame(() => paintRef.current(endT))
    }
  }, [playing, drivesClock, loop, activeSeqId, use3d, preview.w, preview.h, isEdit])

  // 编辑窗：拖拽时本地绘制，松手再写 store
  useEffect(() => {
    if (!isEdit) return
    let raf = 0
    let pending: Record<string, { x: number; y: number }> | null = null
    let pendingGuides: SnapGuide[] = []

    const schedulePaint = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (pending) paint(localPlayhead.current, pending, { guides: pendingGuides })
      })
    }

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      const canvas = canvasRef.current
      if (!d || !canvas) return
      const { nx, ny } = clientToNorm(canvas, e.clientX, e.clientY)
      let ddx = nx - d.startNx
      let ddy = ny - d.startNy
      if (e.altKey || (d.axis !== 'free' && !e.shiftKey)) {
        if (d.axis === 'free') d.axis = Math.abs(ddx) >= Math.abs(ddy) ? 'x' : 'y'
        if (d.axis === 'x') ddy = 0
        else ddx = 0
      } else if (e.shiftKey) {
        d.axis = 'free'
      }
      if (Math.abs(ddx) > 0.002 || Math.abs(ddy) > 0.002) d.moved = true

      if (d.kind === 'path-kf' && d.pathT != null && d.pathOrigin && d.ids[0]) {
        let x = Math.max(-1, Math.min(1, d.pathOrigin.x + ddx))
        let y = Math.max(-1, Math.min(1, d.pathOrigin.y + ddy))
        const st = useApp.getState()
        const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
        const clip = seq.clips.find((c) => c.id === d.ids[0])
        let guides: SnapGuide[] = []
        if (e.shiftKey && clip) {
          const moving = clipHalfNorm(clip, st.playhead, { x, y })
          const others = seq.clips
            .filter((c) => c.id !== clip.id && c.enabled
              && st.playhead >= c.start && st.playhead < c.start + c.duration)
            .map((c) => clipHalfNorm(c, st.playhead))
          const sn = snapWithGuides(x, y, moving, others, { showFrameGrid: true })
          x = sn.x
          y = sn.y
          guides = sn.guides
        } else if (st.settings.snap || e.ctrlKey) {
          if (Math.abs(x) < 0.04) x = 0
          if (Math.abs(y) < 0.04) y = 0
        }
        const clipId = d.ids[0]
        const localT = d.pathT
        useApp.setState((s) => {
          const sq = s.sequences.find((q) => q.id === s.activeSeqId) ?? s.sequences[0]
          return {
            sequences: s.sequences.map((q) => {
              if (q.id !== sq.id) return q
              return {
                ...q,
                clips: q.clips.map((c) => {
                  if (c.id !== clipId) return c
                  const near = (k: { t: number }) => Math.abs(k.t - localT) < 1e-4
                  const xs = [...(c.keyframes.x ?? [])]
                  const ys = [...(c.keyframes.y ?? [])]
                  const xi = xs.findIndex(near)
                  const yi = ys.findIndex(near)
                  if (xi >= 0) xs[xi] = { ...xs[xi], value: x }
                  else xs.push({ id: `kf_${Date.now()}_x`, t: localT, value: x, ease: 'linear' })
                  if (yi >= 0) ys[yi] = { ...ys[yi], value: y }
                  else ys.push({ id: `kf_${Date.now()}_y`, t: localT, value: y, ease: 'linear' })
                  xs.sort((a, b) => a.t - b.t)
                  ys.sort((a, b) => a.t - b.t)
                  return { ...c, keyframes: { ...c.keyframes, x: xs, y: ys } }
                }),
              }
            }),
          }
        })
        paint(localPlayhead.current, undefined, { guides })
        return
      }

      const st = useApp.getState()
      const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
      const ph = localPlayhead.current
      const primaryId = d.ids[0]
      const primary = seq.clips.find((c) => c.id === primaryId)
      let guides: SnapGuide[] = []

      if (e.shiftKey && primary) {
        let px = (d.origin[primaryId]?.x ?? 0) + ddx
        let py = (d.origin[primaryId]?.y ?? 0) + ddy
        const moving = clipHalfNorm(primary, ph, { x: px, y: py })
        const idSet = new Set(d.ids)
        const others = seq.clips
          .filter((c) => !idSet.has(c.id) && c.enabled
            && ph >= c.start && ph < c.start + c.duration)
          .map((c) => clipHalfNorm(c, ph))
        const sn = snapWithGuides(px, py, moving, others, { showFrameGrid: true })
        ddx = sn.x - (d.origin[primaryId]?.x ?? 0)
        ddy = sn.y - (d.origin[primaryId]?.y ?? 0)
        guides = sn.guides
      }

      const snapOn = !e.shiftKey && (st.settings.snap || e.ctrlKey)
      const overrides: Record<string, { x: number; y: number }> = {}
      for (const id of d.ids) {
        let x = Math.max(-1.2, Math.min(1.2, (d.origin[id]?.x ?? 0) + ddx))
        let y = Math.max(-1.2, Math.min(1.2, (d.origin[id]?.y ?? 0) + ddy))
        if (snapOn) {
          if (Math.abs(x) < 0.04) x = 0
          if (Math.abs(y) < 0.04) y = 0
        }
        overrides[id] = { x, y }
      }
      pending = overrides
      pendingGuides = guides
      d.pending = overrides
      schedulePaint()
    }

    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      pendingGuides = []
      if (d?.kind === 'path-kf') {
        pending = null
        paint(localPlayhead.current)
        return
      }
      const overrides = d?.pending
      pending = null
      if (d?.kind === 'clip' && d.moved && overrides) {
        const idSet = new Set(d.ids)
        const st = useApp.getState()
        const ph = st.playhead
        const forceKf = st.autoKeyframe
        useApp.setState((s) => {
          const seq = s.sequences.find((q) => q.id === s.activeSeqId) ?? s.sequences[0]
          return {
            sequences: s.sequences.map((q) => {
              if (q.id !== seq.id) return q
              return {
                ...q,
                clips: q.clips.map((c) => {
                  if (!idSet.has(c.id)) return c
                  const o = overrides[c.id]
                  if (!o) return c
                  return patchClipXY(c, ph, o.x, o.y, { forceKf })
                }),
              }
            }),
          }
        })
      } else if (d?.kind === 'clip' && !d.moved && d.ids.length > 1 && d.primaryId) {
        selectClips([d.primaryId])
      }
      paint(localPlayhead.current)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [isEdit, paint])

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // 节目窗禁止点选/拖动元素
    if (!isEdit || e.button !== 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const st = useApp.getState()
    const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
    const { nx, ny } = clientToNorm(canvas, e.clientX, e.clientY)

    for (const id of st.selectedClipIds) {
      const clip = seq.clips.find((c) => c.id === id)
      if (!clip) continue
      const pathHit = hitTestMotionPathKf(clip, nx, ny)
      if (pathHit) {
        e.preventDefault()
        setPlayhead(clip.start + pathHit.t, { exact: true })
        pushHistory()
        dragRef.current = {
          kind: 'path-kf',
          ids: [clip.id],
          origin: {},
          startNx: nx,
          startNy: ny,
          axis: 'free',
          moved: false,
          pathT: pathHit.t,
          pathOrigin: { x: pathHit.x, y: pathHit.y },
        }
        canvas.setPointerCapture(e.pointerId)
        return
      }
    }

    const hit = hitTestProgramClips(seq, st.playhead, nx, ny, st.selectedClipIds)
    if (!hit) {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) selectClips([])
      return
    }
    // 普通点击只选当前；多选里点中再拖才整组动；Shift/Ctrl 加选
    let ids: string[]
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      ids = st.selectedClipIds.includes(hit)
        ? st.selectedClipIds
        : [...st.selectedClipIds, hit]
    } else if (st.selectedClipIds.includes(hit) && st.selectedClipIds.length > 1) {
      ids = [...st.selectedClipIds]
    } else {
      ids = [hit]
    }
    selectClips(ids)
    const origin: Record<string, { x: number; y: number }> = {}
    for (const c of seq.clips) {
      if (ids.includes(c.id)) {
        const eff = resolveClipTransform(c, st.playhead)
        origin[c.id] = { x: eff.x, y: eff.y }
      }
    }
    pushHistory()
    dragRef.current = {
      kind: 'clip',
      ids, origin, startNx: nx, startNy: ny, axis: 'free', moved: false,
      primaryId: hit,
    }
    canvas.setPointerCapture(e.pointerId)
  }

  const title =
    mode === 'source' ? '源监视器'
      : mode === 'edit' ? '编辑窗'
        : '节目窗'

  return (
    <section className="panel panel-ink h-full min-h-0" data-testid={`${mode}-monitor`}>
      <div className={clsx('flex items-center justify-between border-b shrink-0', compact ? 'px-2 py-0.5' : 'px-3 py-1')} style={{ borderColor: 'var(--border-ink)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="eyebrow shrink-0" style={{ color: 'var(--text-on-ink-muted)', fontSize: compact ? 9 : undefined }}>
            {title}
          </span>
          {isEdit && !compact && selectedClipIds.length > 0 && (
            <span
              className="text-[10px] tabular-nums truncate"
              style={{ color: autoKeyframe ? 'var(--accent)' : 'var(--text-on-ink-muted)' }}
              title="选中后拖位置；Shift 智能标尺吸附；Alt 轴向锁定"
              data-testid="monitor-prop-hint"
            >
              {autoKeyframe ? 'K帧 · S缩放 · R旋转 · T透明' : 'S缩放 · R旋转 · 2 K帧 · 3 转场'}
            </span>
          )}
          {isProgram && !compact && (
            <span className="text-[10px] truncate" style={{ color: 'var(--text-on-ink-muted)' }} title="与导出同一合成结果，不可拖元素">
              导出外观
            </span>
          )}
        </div>
        {isEdit && !compact && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className={clsx('icon-btn', monitorCompose === '2d' && 'active')}
              style={{ width: 26, height: 26, color: 'var(--text-on-ink)' }}
              data-testid="btn-compose-2d"
              title="GPU 合成预览（EditGraph=导出规则）"
              aria-label="GPU 合成预览"
              onClick={() => setMonitorCompose('2d')}
            >
              <span className="text-[10px] font-bold">GPU</span>
            </button>
            <button
              className={clsx('icon-btn', monitorCompose === '3d' && 'active')}
              style={{ width: 26, height: 26, color: 'var(--text-on-ink)' }}
              data-testid="btn-compose-3d"
              title="3D 虚拟摄像机合成（Alt+拖旋转 · Alt+滚轮推拉）"
              aria-label="3D 虚拟摄像机"
              onClick={() => setMonitorCompose('3d')}
            >
              <span className="text-[10px] font-bold">3D</span>
            </button>
            <button
              className={clsx('icon-btn', settings.safeFrame && 'active')}
              style={{ width: 26, height: 26, color: 'var(--text-on-ink)' }}
              data-testid="btn-safe-frame"
              title="安全框（仅编辑窗）"
              aria-label="安全框"
              onClick={() => updateSettings({ safeFrame: !settings.safeFrame })}
            >
              <span className="text-[10px]">▢</span>
            </button>
            {viewDirty && (
              <button
                className="icon-btn text-[10px] tabular-nums"
                style={{ width: 'auto', minWidth: 26, height: 26, padding: '0 6px', color: 'var(--text-on-ink)' }}
                data-testid="btn-monitor-zoom-reset"
                title="重置视口缩放/平移"
                onClick={resetView}
              >
                {Math.round(viewZoom * 100)}%
              </button>
            )}
          </div>
        )}
        {isProgram && !compact && viewDirty && (
          <button
            className="icon-btn text-[10px] tabular-nums"
            style={{ width: 'auto', minWidth: 26, height: 26, padding: '0 6px', color: 'var(--text-on-ink)' }}
            data-testid="btn-monitor-zoom-reset"
            title="重置视口缩放/平移"
            onClick={resetView}
          >
            {Math.round(viewZoom * 100)}%
          </button>
        )}
      </div>

      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 w-full overflow-hidden bg-black"
        data-testid={mode === 'source' ? 'source-viewport' : isEdit ? 'edit-viewport' : 'program-viewport'}
        title={isSeq ? 'Ctrl+滚轮缩放 · 中键拖移视口' : undefined}
        onPointerDown={onViewportPointerDown}
      >
        {use3d ? (
          <div
            className="absolute inset-0"
            style={{ transform: viewTransform, transformOrigin: 'center center' }}
          >
            <Monitor3dViewport width={display.w} height={display.h} onFallback={on3dFallback} />
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            id={isProgram ? 'program-canvas' : isEdit ? 'edit-canvas' : 'source-canvas'}
            data-testid={isProgram ? 'program-canvas' : isEdit ? 'edit-canvas' : 'source-canvas'}
            width={preview.w}
            height={preview.h}
            className="absolute inset-0"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: viewTransform,
              transformOrigin: 'center center',
              cursor: isEdit ? 'move' : 'default',
              touchAction: 'none',
              background: '#000000',
              visibility: isProgram && nativeOn ? 'hidden' : 'visible',
            }}
            onPointerDown={onCanvasPointerDown}
          />
        )}
        {isProgram && nativeOn && (
          <div
            className="pointer-events-none absolute inset-0 flex items-end justify-end p-1"
            data-testid="native-preview-badge"
            aria-hidden
          >
            <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(0,0,0,0.45)', color: '#e2e2e2' }}>NATIVE</span>
          </div>
        )}
      </div>

      <div className={clsx('flex items-center justify-center gap-1 border-t shrink-0', compact ? 'px-1 py-1' : 'px-2 py-1.5')} style={{ borderColor: 'var(--border-ink)' }}>
        {mode === 'source' ? (
          <>
            <button className={clsx(compact ? 'btn btn-ink text-[10px] h-6 px-2' : 'btn btn-ink')} data-testid="btn-mark-in" onClick={() => setSourceIO(useApp.getState().playhead, sourceOut)} title="入点 (I)">I</button>
            <button className={clsx(compact ? 'btn btn-ink text-[10px] h-6 px-2' : 'btn btn-ink')} data-testid="btn-mark-out" onClick={() => setSourceIO(sourceIn, Math.max(sourceIn + 0.1, useApp.getState().playhead))} title="出点 (O)">O</button>
            {!compact && <button className="btn btn-primary" data-testid="btn-three-point" onClick={threePointEdit}>三点剪辑</button>}
          </>
        ) : (
          <>
            <button className="icon-btn" style={{ color: 'var(--text-on-ink)' }} data-testid="btn-step-back" onClick={() => stepFrame(-1)} title="上一帧 (J)" aria-label="上一帧"><SkipBack size={14} /></button>
            <button className="icon-btn" style={{ width: 34, height: 34, color: 'var(--text-on-ink)', background: 'var(--surface-ink-3)' }} data-testid="btn-play" onClick={togglePlay} title="播放/暂停 (Space)" aria-label="播放">
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button className="icon-btn" style={{ color: 'var(--text-on-ink)' }} data-testid="btn-step-fwd" onClick={() => stepFrame(1)} title="下一帧 (L)" aria-label="下一帧"><SkipForward size={14} /></button>
            <button className="icon-btn" style={{ color: 'var(--text-on-ink)' }} data-testid="btn-capture-frame-monitor" onClick={captureFrame} title="AI 截帧 → 参考图（SQLite，不入库）" aria-label="截帧"><Camera size={13} /></button>
            <button className={clsx('icon-btn', loop && 'active')} style={{ color: 'var(--text-on-ink)' }} data-testid="btn-loop" onClick={() => setLoop(!loop)} title="循环播放" aria-label="循环"><Repeat size={13} /></button>
            <button className="icon-btn" style={{ color: 'var(--text-on-ink)' }} data-testid="btn-fullscreen-monitor" onClick={() => setFullscreen(true)} title="全屏预览" aria-label="全屏">⛶</button>
          </>
        )}
      </div>
    </section>
  )
}
