import { useApp } from '../store'
import { desktop } from './desktop'
import { setLivePlayhead } from './livePlayhead'
import {
  cachedTimeRanges,
  getProgramPreviewCache,
  setRemotePreviewBarRanges,
  subscribePreviewCache,
} from './previewCache'

const CHANNEL = 'todo-editor-store-sync'

/** 跨窗口同步的编辑态字段（足够时间轴/K帧独立窗口工作） */
const SYNC_KEYS = [
  'sequences',
  'activeSeqId',
  'selectedClipIds',
  'playhead',
  'playing',
  'loop',
  'settings',
  'timelineZoom',
  'tool',
  'media',
  'prefs',
  'projectId',
  'projectName',
  'autoKeyframe',
  'monitorCompose',
  'timelineFloat',
  'timelineFloatKind',
  'aiRefDataUrl',
  'aiGenMode',
  'folders',
  'presets',
  'fonts',
  'selectedMediaId',
  'layout',
  'exportQueue',
  'sourceMediaId',
  'sourceIn',
  'sourceOut',
  'editMode',
] as const

/** 仅主窗可权威写入；弹窗改这些字段时发 authority-request，由主窗落盘再广播 */
const AUTHORITY_KEYS = [
  'sequences',
  'activeSeqId',
  'selectedClipIds',
  'media',
  'settings',
  'projectId',
  'projectName',
  'prefs',
  'autoKeyframe',
  'monitorCompose',
  'aiRefDataUrl',
  'aiGenMode',
  'folders',
  'presets',
  'fonts',
  'selectedMediaId',
  'layout',
  'exportQueue',
  'sourceMediaId',
  'sourceIn',
  'sourceOut',
  'editMode',
] as const

type SyncKey = (typeof SYNC_KEYS)[number]
type AuthorityKey = (typeof AUTHORITY_KEYS)[number]
type SyncPatch = Partial<Record<SyncKey, unknown>>
type SyncMsg =
  | { type: 'hello'; origin: string }
  | { type: 'patch'; origin: string; patch: SyncPatch }
  | { type: 'authority-request'; origin: string; patch: SyncPatch }
  | { type: 'live'; origin: string; t: number }
  | { type: 'seek'; origin: string; t: number }
  | { type: 'request-capture'; origin: string }
  | { type: 'preview-cache'; origin: string; ranges: { start: number; end: number }[] }

function isAuthorityKey(k: string): k is AuthorityKey {
  return (AUTHORITY_KEYS as readonly string[]).includes(k)
}

function pickSync(state: Record<string, unknown>): SyncPatch {
  const patch: SyncPatch = {}
  for (const k of SYNC_KEYS) patch[k] = state[k]
  return patch
}

function currentPreviewRanges() {
  const fps = Math.max(1, useApp.getState().settings.fps)
  return cachedTimeRanges(getProgramPreviewCache(), fps)
}

function broadcastPreviewRanges() {
  if (!started || isAnyPopout()) return
  postOutgoing({ type: 'preview-cache', origin, ranges: currentPreviewRanges() })
}

let started = false
let applying = false
/** 本窗正在拖 scrub：忽略对端 live，避免主窗播放把播放头抢回去 */
let localScrubbing = false
const origin = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

let postOutgoing: (msg: SyncMsg) => void = () => {}

function handleIncoming(data: SyncMsg) {
  if (!data || data.origin === origin) return
  if (data.type === 'hello') {
    // 仅权威窗回答全量快照
    if (isAnyPopout()) return
    postOutgoing({ type: 'patch', origin, patch: pickSync(useApp.getState() as unknown as Record<string, unknown>) })
    broadcastPreviewRanges()
    return
  }
  if (data.type === 'live') {
    if (localScrubbing) return
    setLivePlayhead(data.t)
    return
  }
  if (data.type === 'seek') {
    applying = true
    useApp.setState({ playhead: data.t, playing: false })
    applying = false
    setLivePlayhead(data.t)
    return
  }
  if (data.type === 'request-capture') {
    if (isAnyPopout()) return
    useApp.getState().captureFrame()
    return
  }
  if (data.type === 'preview-cache') {
    if (!isTimelinePopout()) return
    setRemotePreviewBarRanges(data.ranges ?? [])
    return
  }
  if (data.type === 'authority-request') {
    // 只有主窗受理工程权威写入
    if (isAnyPopout() || !data.patch) return
    applying = true
    useApp.setState(data.patch as Parameters<typeof useApp.setState>[0])
    applying = false
    // 主动广播权威结果（subscribe 在 applying 期间被抑制）
    postOutgoing({ type: 'patch', origin, patch: data.patch })
    return
  }
  if (data.type === 'patch' && data.patch) {
    // 弹窗不接受另一弹窗的权威字段；主窗可收工具类字段
    const patch = { ...data.patch } as SyncPatch
    if (isAnyPopout()) {
      // 弹窗全量接受主窗 patch
    } else {
      // 主窗忽略从弹窗误发的权威字段（应走 authority-request）
      for (const k of Object.keys(patch)) {
        if (isAuthorityKey(k)) delete (patch as Record<string, unknown>)[k]
      }
      if (!Object.keys(patch).length) return
    }
    applying = true
    useApp.setState(patch as Parameters<typeof useApp.setState>[0])
    applying = false
    if (typeof patch.playhead === 'number' && !localScrubbing) {
      setLivePlayhead(patch.playhead)
    }
  }
}

/** 开始/结束本窗拖动改时间（标尺 / K帧空白 / 播放头） */
export function setLocalPlayheadScrubbing(on: boolean) {
  localScrubbing = on
  if (on && useApp.getState().playing) {
    useApp.setState({ playing: false })
  }
}

/** 主窗播放时把 live 播放头推到独立窗（不写 Zustand） */
export function broadcastLivePlayhead(t: number) {
  if (!started || localScrubbing) return
  postOutgoing({ type: 'live', origin, t })
}

/** 用户主动 seek：让另一窗口的状态和 live 时钟同时落到目标时间 */
export function broadcastPlayheadSeek(t: number) {
  if (!started) return
  postOutgoing({ type: 'seek', origin, t })
}

/** 主窗口 ↔ 时间轴独立窗口 双向同步 */
export function initStoreSync() {
  if (started) return () => {}
  started = true

  const d = desktop()
  const cleanups: Array<() => void> = []

  if (d?.postStoreSync && d.onStoreSync) {
    postOutgoing = (msg) => d.postStoreSync!(msg)
    cleanups.push(d.onStoreSync((msg) => handleIncoming(msg as SyncMsg)))
  } else if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CHANNEL)
    postOutgoing = (msg) => ch.postMessage(msg)
    ch.onmessage = (ev) => handleIncoming(ev.data as SyncMsg)
    cleanups.push(() => ch.close())
  } else {
    started = false
    return () => {}
  }

  const unsub = useApp.subscribe((state, previous) => {
    if (applying) return
    const authPatch: SyncPatch = {}
    const mirrorPatch: SyncPatch = {}
    for (const key of SYNC_KEYS) {
      if (state[key] === previous[key]) continue
      if (isAuthorityKey(key)) authPatch[key] = state[key]
      else mirrorPatch[key] = state[key]
    }
    if (isAnyPopout()) {
      if (Object.keys(authPatch).length) {
        postOutgoing({ type: 'authority-request', origin, patch: authPatch })
      }
      if (Object.keys(mirrorPatch).length) {
        postOutgoing({ type: 'patch', origin, patch: mirrorPatch })
      }
      return
    }
    const patch = { ...authPatch, ...mirrorPatch }
    if (Object.keys(patch).length) {
      postOutgoing({ type: 'patch', origin, patch })
    }
  })
  cleanups.push(unsub)

  if (!isAnyPopout()) {
    cleanups.push(subscribePreviewCache(() => broadcastPreviewRanges()))
  }

  if (isTimelinePopout() || isAiPopout()) {
    postOutgoing({ type: 'hello', origin })
    setLivePlayhead(useApp.getState().playhead)
  }

  return () => {
    for (const c of cleanups) c()
    started = false
  }
}

/** AI 独立窗请求主窗截帧 */
export function requestAiCapture() {
  if (!started) return
  postOutgoing({ type: 'request-capture', origin })
}

export function isTimelinePopout() {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('popout') === 'timeline'
}

export function isAiPopout() {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('popout') === 'ai'
}

export function isAnyPopout() {
  return isTimelinePopout() || isAiPopout()
}

export function isStoreAuthority() {
  return !isAnyPopout()
}

export function popoutUrl() {
  const u = new URL(location.href)
  u.searchParams.set('popout', 'timeline')
  return u.toString()
}

export function aiPopoutUrl() {
  const u = new URL(location.href)
  u.searchParams.set('popout', 'ai')
  return u.toString()
}
