/**
 * B2：节目监视器 ↔ todo-preview-engine 桥接。
 * settings.nativePreview=false 时不 spawn；崩溃回退 canvas。
 */
import { useApp } from '../store'
import { buildEditGraph } from './editGraph'
import { desktop } from './desktop'
import { frameIndex } from './programPlayer'

let started = false
let active = false
let unsubEvent: (() => void) | null = null
let unsubCrash: (() => void) | null = null
let lastFp = ''

export function isNativePreviewActive() {
  return active
}

export async function startNativePreview(): Promise<boolean> {
  const api = desktop()
  if (!api?.previewInit) return false
  const st = useApp.getState()
  if (!st.settings.nativePreview) return false
  if (st.fullscreen) return false
  if (started) {
    active = true
    return true
  }
  const r = await api.previewInit({ fps: st.settings.fps, budgetMB: 512, adapterLuid: null })
  if (!r.ok) {
    console.warn('[nativePreview] init failed', r)
    return false
  }
  started = true
  active = true
  unsubEvent = api.onPreviewEvent?.((ev) => {
    if (ev.ev === 'unsupported') {
      /* B2: solid fill only — log for now */
      if (Array.isArray(ev.clipIds) && ev.clipIds.length) {
        console.info('[nativePreview] unsupported', ev.clipIds)
      }
    }
  }) ?? null
  unsubCrash = api.onPreviewCrashed?.(() => {
    console.warn('[nativePreview] engine crashed — fallback canvas')
    active = false
    started = false
    useApp.getState().setToast('原生预览已退出，已回退画布')
  }) ?? null
  await pushTimeline()
  await seekToPlayhead()
  return true
}

export async function stopNativePreview() {
  const api = desktop()
  active = false
  started = false
  unsubEvent?.()
  unsubCrash?.()
  unsubEvent = null
  unsubCrash = null
  lastFp = ''
  await api?.previewStop?.()
}

export async function pushTimeline() {
  const api = desktop()
  if (!api?.previewTimeline || !active) return
  const st = useApp.getState()
  const seq = st.seq()
  const graph = buildEditGraph({
    clips: seq.clips,
    tracks: seq.tracks,
    media: st.media,
    settings: st.settings,
    workIn: seq.workIn,
    workOut: seq.workOut,
  })
  const json = JSON.stringify(graph)
  const fp = `${json.length}:${seq.clips.length}:${st.settings.fps}`
  if (fp === lastFp) return
  lastFp = fp
  await api.previewTimeline(json)
}

export async function seekToPlayhead() {
  const api = desktop()
  if (!api?.previewSeek || !active) return
  const st = useApp.getState()
  const frame = frameIndex(st.playhead, st.settings.fps)
  await api.previewSeek(frame)
}

export async function syncPlayState() {
  const api = desktop()
  if (!active || !api) return
  if (useApp.getState().playing) await api.previewPlay?.()
  else await api.previewPause?.()
}

export function reportPreviewRect(css: { x: number; y: number; w: number; h: number }) {
  if (!active) return
  void desktop()?.previewRect?.(css)
}

/** 订阅 store：开关 / 全屏 / 播放头 */
export function bindNativePreviewLifecycle() {
  let prevNative = useApp.getState().settings.nativePreview
  let prevFull = useApp.getState().fullscreen
  let prevPlaying = useApp.getState().playing
  let prevHead = useApp.getState().playhead
  if (prevNative && !prevFull) void startNativePreview()
  return useApp.subscribe((s) => {
    const native = s.settings.nativePreview
    const full = s.fullscreen
    if (native !== prevNative || full !== prevFull) {
      prevNative = native
      prevFull = full
      if (native && !full) void startNativePreview()
      else void stopNativePreview()
    }
    if (!active) return
    if (s.playing !== prevPlaying) {
      prevPlaying = s.playing
      void syncPlayState()
    }
    if (s.playhead !== prevHead && !s.playing) {
      prevHead = s.playhead
      void seekToPlayhead()
    } else {
      prevHead = s.playhead
    }
  })
}
