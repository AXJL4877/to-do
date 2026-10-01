/** 字幕烧录进行中：按音频 clipId 订阅，时间轴画动效用 */
type Listener = () => void

const pending = new Map<string, string>() // clipId → jobId
const listeners = new Set<Listener>()
let rev = 0

function emit() {
  rev++
  for (const l of listeners) l()
}

export function markSubtitleBurnPending(clipId: string, jobId: string) {
  if (!clipId || !jobId) return
  if (pending.get(clipId) === jobId) return
  pending.set(clipId, jobId)
  emit()
}

export function clearSubtitleBurnPending(clipId: string) {
  if (!pending.delete(clipId)) return
  emit()
}

export function clearSubtitleBurnPendingByJob(jobId: string) {
  let changed = false
  for (const [clipId, jid] of pending) {
    if (jid === jobId) {
      pending.delete(clipId)
      changed = true
    }
  }
  if (changed) emit()
}

export function isSubtitleBurnPending(clipId: string) {
  return pending.has(clipId)
}

export function getSubtitleBurnPendingRev() {
  return rev
}

export function subscribeSubtitleBurnPending(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 当前所有烧录中的音频片段 id（调试 / 批量用） */
export function listSubtitleBurnPendingClipIds() {
  return [...pending.keys()]
}
