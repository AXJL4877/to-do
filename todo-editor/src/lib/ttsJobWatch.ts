/**
 * 配音任务完成后入库并入轨。
 * 不依赖配音页或 AI 页还开着：口播稿关掉之后，这条监听仍然负责把音频放到时间轴。
 */
import { aiFetch } from './aiFetch'
import { importAiJob, shouldImport, type ImportableAiJob } from './aiJobImport'

type JobRow = ImportableAiJob & { status: string; error?: string | null; phase?: string | null }

export type TtsWatchUpdate = { status: string; error?: string | null; phase?: string | null }

const watches = new Map<string, number>()
const MAX_MS = 20 * 60 * 1000
let pollMs = 2000

export function setTtsWatchPollMs(ms: number) {
  pollMs = ms
}

export function watchTtsJob(jobId: string, onUpdate?: (update: TtsWatchUpdate) => void) {
  if (watches.has(jobId)) return
  const started = Date.now()
  const stop = () => {
    const timer = watches.get(jobId)
    if (timer) window.clearInterval(timer)
    watches.delete(jobId)
  }
  const timer = window.setInterval(() => {
    void (async () => {
      if (Date.now() - started > MAX_MS) {
        stop()
        onUpdate?.({ status: 'error', error: '配音等待超时，可到配音页查看任务' })
        return
      }
      try {
        const r = await aiFetch('/api/ai-jobs?limit=40')
        const data = await r.json()
        const item = (data.items as JobRow[] | undefined)?.find((j) => j.id === jobId)
        if (!item) return
        if (item.status === 'error') {
          stop()
          onUpdate?.({ status: 'error', error: item.error || '配音失败', phase: item.phase })
          return
        }
        if (item.status === 'running' || item.status === 'queued') {
          onUpdate?.({ status: item.status, phase: item.phase })
          return
        }
        if ((item.status === 'done' || item.status === 'imported') && item.resultUrl) {
          try {
            if (shouldImport(item)) await importAiJob(item)
          } catch (e) {
            onUpdate?.({ status: 'error', error: e instanceof Error ? e.message : String(e) })
            return
          }
          stop()
          onUpdate?.({ status: 'imported', phase: item.phase })
        }
      } catch { /* 网络抖动时下一轮再问，不把已入队的任务当成失败 */ }
    })()
  }, pollMs)
  watches.set(jobId, timer)
}

export function stopAllTtsWatches() {
  for (const timer of watches.values()) window.clearInterval(timer)
  watches.clear()
}
