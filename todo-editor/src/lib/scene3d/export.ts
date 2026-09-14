import type { Prefs } from '../../types'
import { proxyMaxEdge } from './math'

/** 根据性能档位限制预览纹理边长（导出时用原图） */
export function previewTextureLimit(prefs: Prefs): number {
  return proxyMaxEdge(prefs.performance)
}

/**
 * 简易 3D 导出：抓取当前 3D canvas 帧序列占位。
 * 正式离线渲染可后续换 OffscreenCanvas + FFmpeg 管道。
 */
export async function exportSceneFrames(opts: {
  fps: number
  duration: number
  capture: () => string
  onProgress?: (p: number) => void
  maxFrames?: number
}): Promise<string[]> {
  const frames: string[] = []
  const total = Math.max(1, Math.min(opts.maxFrames ?? 90, Math.ceil(opts.duration * opts.fps)))
  for (let i = 0; i < total; i++) {
    frames.push(opts.capture())
    opts.onProgress?.(Math.round(((i + 1) / total) * 100))
    // 让出主线程，避免卡死 UI
    await new Promise((r) => setTimeout(r, 0))
  }
  return frames
}
