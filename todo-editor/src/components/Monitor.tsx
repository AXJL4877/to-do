import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Repeat, Camera } from 'lucide-react'
import { useApp, formatTime } from '../store'
import { resolveClipTransform, patchClipXY } from '../lib/keyframeEval'
import { getPreviewSize, hitTestMotionPathKf, hitTestProgramClips, renderProgramFrame, renderSourceFrame } from '../lib/monitorDraw'
import { cancelComposeUpgrade } from '../lib/composePreview'
import { clipHalfNorm, snapWithGuides, type SnapGuide } from '../lib/monitorSnap'
import {
  blitCachedFrame,
  cachePixelSize,
  ensurePreviewFingerprint,
  getCachedFrame,
  getProgramPreviewCache,
  previewFingerprint,
  putCachedFrame,
  renderAndCacheFrame,
} from '../lib/previewCache'
import { useImageCache } from '../hooks/useImageCache'
import { getLivePlayhead, setLivePlayhead, subscribeLivePlayhead } from '../lib/livePlayhead'
import { setVideoSeekQuiet } from '../lib/videoCache'
import { stopNativePlaySession } from '../lib/nativePlayBridge'
import { broadcastLivePlayhead } from '../lib/storeSync'
import { syncProgramAudio, stopProgramAudio } from '../lib/programAudio'
import { Monitor3dViewport } from './Monitor3dViewport'
import { webglOk } from '../lib/scene3d'
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

export function Monitor({ mode, compact = false }: { mode: 'source' | 'program'; compact?: boolean }) {
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
  }>(null)
  /** 视口 CSS 像素（3D 用）；2D 用 object-fit 铺满视口 */
  const [display, setDisplay] = useState({ w: 0, h: 0 })
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const viewPanRef = useRef({ x: 0, y: 0 })
  const notifiedCache = useRef('')

  const media = useApp((s) => s.media)
  const settings = useApp((s) => s.settings)
  const prefs = useApp((s) => s.prefs)
  const playhead = useApp((s) => s.playhead)
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
  const threePointEdit = useApp((s) => s.threePointEdit)
  const updateSettings = useApp((s) => s.updateSettings)
  const selectClips = useApp((s) => s.selectClips)
  const pushHistory = useApp((s) => s.pushHistory)
  const monitorCompose = useApp((s) => s.monitorCompose)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const captureFrame = useApp((s) => s.captureFrame)

  const { cache: imgCache, version: imgVersion } = useImageCache(media)
  const preview = getPreviewSize(settings, prefs.performance)
  const use3d = mode === 'program' && monitorCompose === '3d' && webglOk()

  const on3dFallback = useCallback(() => {
    setMonitorCompose('2d')
    useApp.getState().setToast('WebGL 不可用，已回退 2D 监视器')
  }, [setMonitorCompose])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setDisplay({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (mode !== 'program') return
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      setViewZoom((z) => Math.min(4, Math.max(0.25, Math.round(z * factor * 100) / 100)))
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
  }, [mode])

  function resetView() {
    setViewZoom(1)
    viewPanRef.current = { x: 0, y: 0 }
    setViewPan({ x: 0, y: 0 })
  }

  function onViewportPointerDown(e: React.PointerEvent) {
    if (mode !== 'program' || e.button !== 1) return
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
    mode === 'program' && viewDirty
      ? `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`
      : undefined

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
    const { w: cw, h: ch } = cachePixelSize(w, h, st.prefs.previewCacheMaxEdge ?? 720)
    const fp = previewFingerprint(seq, settings, cw, ch)
    const ram = getProgramPreviewCache()
    ensurePreviewFingerprint(ram, fp, cw, ch)

    const scrubbing = !opts?.playing
    if (opts?.playing && !transformOverrides) {
      const hasVisibleClip = seq.clips.some((c) => {
        if (!c.enabled || t < c.start || t >= c.start + c.duration) return false
        const track = seq.tracks.find((tr) => tr.id === c.trackId)
        return !!track && !track.hidden && track.kind !== 'audio'
      })
      if (!hasVisibleClip) {
        renderProgramFrame(canvas, seq, media, settings, t, imgCache.current, w, h, [], undefined, false)
        return
      }
      const hit = getCachedFrame(ram, frame)
      if (hit) {
        blitCachedFrame(canvas, hit, w, h)
        return
      }
      renderAndCacheFrame(ram, frame, fps, canvas, seq, media, settings, imgCache.current, w, h)
      return
    }

    // scrub / 暂停：只走 Canvas2D（compose 升级会异步盖黑）
    if (scrubbing && !transformOverrides) {
      renderProgramFrame(
        canvas, seq, media, settings, t, imgCache.current, w, h,
        st.selectedClipIds, undefined, scrubbing && st.autoKeyframe, opts?.guides,
      )
      return
    }

    renderProgramFrame(
      canvas, seq, media, settings, t, imgCache.current, w, h,
      scrubbing ? st.selectedClipIds : [],
      transformOverrides,
      scrubbing && st.autoKeyframe,
      opts?.guides,
    )
  }, [mode, media, settings, sourceMediaId, sourceIn, sourceOut, preview.w, preview.h, imgCache, imgVersion, selectedClipIds, autoKeyframe])

  useEffect(() => {
    if (use3d) return
    if (mode === 'program' && playing) return
    if (dragRef.current) return
    // 仅当 store.playhead 本身变化时同步 live；勿在媒体缓存 bump 时把 live 拽回旧时间
    localPlayhead.current = playhead
    setLivePlayhead(playhead)
    paint(playhead)
  }, [playhead, playing, mode, use3d]) // eslint-disable-line react-hooks/exhaustive-deps

  // 素材/选中/序列变化：按当前 live 重画，不改播放头
  useEffect(() => {
    if (use3d) return
    if (mode === 'program' && playing) return
    if (dragRef.current) return
    paint(getLivePlayhead())
  }, [paint, selectedClipIds, sequences, activeSeqId, autoKeyframe, use3d, mode, playing])

  // 拖 scrub / 跨窗 seek：跟 live 即时画
  useEffect(() => {
    if (use3d || mode !== 'program' || playing) return
    return subscribeLivePlayhead(() => {
      if (dragRef.current) return
      const t = getLivePlayhead()
      if (Math.abs(t - localPlayhead.current) < 1e-4) return
      localPlayhead.current = t
      paint(t)
    })
  }, [use3d, mode, playing, paint])

  useEffect(() => {
    if (use3d || mode !== 'program' || !playing) return
    cancelComposeUpgrade()
    void stopNativePlaySession()
    setVideoSeekQuiet(true)
    let raf = 0
    const st0 = useApp.getState()
    const fps = Math.max(1, st0.settings.fps)
    const tStart = st0.playhead
    const wall0 = performance.now()
    let lastShown = -1
    let lastSeq: typeof st0.sequences[0] | null = null
    let fp = ''
    const cache = getProgramPreviewCache()
    notifiedCache.current = ''
    localPlayhead.current = tStart
    setLivePlayhead(tStart)
    broadcastLivePlayhead(tStart)

    const seqEnd = (seq: typeof st0.sequences[0]) =>
      Math.max(seq.workOut, ...seq.clips.map((c) => c.start + c.duration), 5)

    const videoIds = new Set(media.filter((m) => m.kind === 'video').map((m) => m.id))
    const clipUsesVideo = (seq: typeof st0.sequences[0], t: number) =>
      seq.clips.some((c) =>
        !!c.mediaId && videoIds.has(c.mediaId)
        && t >= c.start && t < c.start + c.duration,
      )

    const tick = (now: number) => {
      const st = useApp.getState()
      const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
      const canvas = canvasRef.current
      if (!canvas) {
        raf = requestAnimationFrame(tick)
        return
      }

      const end = seqEnd(seq)
      let t = tStart + (now - wall0) / 1000
      if (t >= end) {
        if (st.loop) {
          const span = Math.max(0.05, end - seq.workIn)
          t = seq.workIn + ((t - seq.workIn) % span)
        } else {
          void stopNativePlaySession()
          paint(end, undefined, { playing: true })
          setLivePlayhead(end)
          broadcastLivePlayhead(end)
          useApp.setState({ playing: false, playhead: end })
          return
        }
      }

      const frame = Math.max(0, Math.floor(t * fps + 1e-6))
      const hasVisibleClip = seq.clips.some((c) => {
        if (!c.enabled || t < c.start || t >= c.start + c.duration) return false
        const track = seq.tracks.find((tr) => tr.id === c.trackId)
        return !!track && !track.hidden && track.kind !== 'audio'
      })
      localPlayhead.current = t
      setLivePlayhead(t)
      if (frame % 2 === 0) broadcastLivePlayhead(t)

      // 无片段：强制合成空画面，绝不复用上一时刻缓存
      if (!hasVisibleClip) {
        lastShown = frame
        renderProgramFrame(
          canvas, seq, media, settings, t, imgCache.current, preview.w, preview.h,
          [], undefined, false,
        )
        syncProgramAudio(seq, media, t, true)
        raf = requestAnimationFrame(tick)
        return
      }

      // 有视频：HTMLVideo + Canvas2D 跟手；勿每帧 pump 原生 BMP / WebGL 上传
      if (clipUsesVideo(seq, t)) {
        lastShown = frame
        renderProgramFrame(
          canvas, seq, media, settings, t, imgCache.current, preview.w, preview.h,
          [], undefined, false,
        )
        // 每 4 帧写一次 RAM；时间线条合并空隙仍显示实心绿
        if (frame % 4 === 0) {
          const { w: cw, h: ch } = cachePixelSize(preview.w, preview.h, st.prefs.previewCacheMaxEdge ?? 720)
          if (seq !== lastSeq) {
            lastSeq = seq
            fp = previewFingerprint(seq, settings, cw, ch)
            ensurePreviewFingerprint(cache, fp, cw, ch)
          }
          putCachedFrame(cache, frame, canvas, frame)
        }
        syncProgramAudio(seq, media, t, true)
        raf = requestAnimationFrame(tick)
        return
      }

      if (frame !== lastShown) {
        lastShown = frame
        const { w: cw, h: ch } = cachePixelSize(preview.w, preview.h, st.prefs.previewCacheMaxEdge ?? 720)
        if (seq !== lastSeq) {
          lastSeq = seq
          fp = previewFingerprint(seq, settings, cw, ch)
          ensurePreviewFingerprint(cache, fp, cw, ch)
        }
        const hit = cache.frames.get(frame)
        if (hit) blitCachedFrame(canvas, hit, preview.w, preview.h)
        else {
          renderAndCacheFrame(
            cache, frame, fps, canvas, seq, media, settings, imgCache.current, preview.w, preview.h,
          )
        }
      }
      syncProgramAudio(seq, media, t, true)

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelComposeUpgrade()
      stopProgramAudio()
      setVideoSeekQuiet(false)
      cancelAnimationFrame(raf)
      void stopNativePlaySession()
      const current = useApp.getState().playhead
      // 普通暂停时 store 仍停在播放起点，提交最后播放帧；
      // 若 scrub/跨窗 seek 已写入新时间，不能再用旧播放循环覆盖。
      const endT = Math.abs(current - tStart) < 1e-4 ? localPlayhead.current : current
      if (Math.abs(current - tStart) < 1e-4) {
        useApp.setState({ playhead: endT })
      }
      // 暂停后视频已 pause，下一 tick 强制 Canvas2D 重画，避免黑屏
      requestAnimationFrame(() => paint(endT))
    }
  }, [playing, mode, loop, activeSeqId, paint, use3d, media, settings, preview.w, preview.h, imgCache])

  // 节目监视器：拖拽时本地绘制，松手再写 store（避免每帧重渲染时间线）
  useEffect(() => {
    if (mode !== 'program') return
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
      // Alt：轴向锁定；Shift：智能标尺吸附（二者可并存：先轴向再吸附）
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
      const playhead = localPlayhead.current
      const primaryId = d.ids[0]
      const primary = seq.clips.find((c) => c.id === primaryId)
      let guides: SnapGuide[] = []

      if (e.shiftKey && primary) {
        let px = (d.origin[primaryId]?.x ?? 0) + ddx
        let py = (d.origin[primaryId]?.y ?? 0) + ddy
        const moving = clipHalfNorm(primary, playhead, { x: px, y: py })
        const idSet = new Set(d.ids)
        const others = seq.clips
          .filter((c) => !idSet.has(c.id) && c.enabled
            && playhead >= c.start && playhead < c.start + c.duration)
          .map((c) => clipHalfNorm(c, playhead))
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
      if (d?.moved && overrides) {
        const idSet = new Set(d.ids)
        const st = useApp.getState()
        const playhead = st.playhead
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
                  return patchClipXY(c, playhead, o.x, o.y, { forceKf })
                }),
              }
            }),
          }
        })
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
  }, [mode, paint])

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== 'program' || e.button !== 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const st = useApp.getState()
    const seq = st.sequences.find((q) => q.id === st.activeSeqId) ?? st.sequences[0]
    const { nx, ny } = clientToNorm(canvas, e.clientX, e.clientY)

    // 优先命中选中片段的运动路径关键帧点
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
    const ids = e.shiftKey || e.ctrlKey || e.metaKey
      ? (st.selectedClipIds.includes(hit)
          ? st.selectedClipIds
          : [...st.selectedClipIds, hit])
      : (st.selectedClipIds.includes(hit) ? st.selectedClipIds : [hit])
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
    }
    canvas.setPointerCapture(e.pointerId)
  }

  return (
    <section className="panel panel-ink h-full min-h-0" data-testid={`${mode}-monitor`}>
      <div className={clsx('flex items-center justify-between border-b shrink-0', compact ? 'px-2 py-0.5' : 'px-3 py-1')} style={{ borderColor: 'var(--border-ink)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="eyebrow shrink-0" style={{ color: 'var(--text-on-ink-muted)', fontSize: compact ? 9 : undefined }}>
            {mode === 'source' ? '源监视器' : '节目监视器'}
          </span>
          {mode === 'program' && !compact && selectedClipIds.length > 0 && (
            <span
              className="text-[10px] tabular-nums truncate"
              style={{ color: autoKeyframe ? 'var(--accent)' : 'var(--text-on-ink-muted)' }}
              title="选中后拖位置；Shift 智能标尺吸附；Alt 轴向锁定"
              data-testid="monitor-prop-hint"
            >
              {autoKeyframe ? 'K帧 · S缩放 · T透明' : '1 静态 · 2 K帧 · 3 转场'}
            </span>
          )}
        </div>
        {mode === 'program' && !compact && (
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
              title="安全框"
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
      </div>

      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 w-full overflow-hidden bg-black"
        data-testid={mode === 'program' ? 'program-viewport' : 'source-viewport'}
        title={mode === 'program' ? 'Ctrl+滚轮缩放 · 中键拖移视口' : undefined}
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
            id={mode === 'program' ? 'program-canvas' : 'source-canvas'}
            data-testid={mode === 'program' ? 'program-canvas' : 'source-canvas'}
            width={preview.w}
            height={preview.h}
            className="absolute inset-0"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: viewTransform,
              transformOrigin: 'center center',
              cursor: mode === 'program' ? 'move' : 'default',
              touchAction: 'none',
              background: '#000',
            }}
            onPointerDown={onCanvasPointerDown}
          />
        )}
      </div>

      <div className={clsx('flex items-center justify-center gap-1 border-t shrink-0', compact ? 'px-1 py-1' : 'px-2 py-1.5')} style={{ borderColor: 'var(--border-ink)' }}>
        {mode === 'source' ? (
          <>
            <button className={clsx(compact ? 'btn btn-ink text-[10px] h-6 px-2' : 'btn btn-ink')} data-testid="btn-mark-in" onClick={() => setSourceIO(playhead, sourceOut)} title="入点 (I)">I</button>
            <button className={clsx(compact ? 'btn btn-ink text-[10px] h-6 px-2' : 'btn btn-ink')} data-testid="btn-mark-out" onClick={() => setSourceIO(sourceIn, Math.max(sourceIn + 0.1, playhead))} title="出点 (O)">O</button>
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
