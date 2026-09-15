/**
 * 音轨波形：只信任 ffmpeg 整段 PCM（或按媒体时长均匀 seek）。
 * 禁止把半截 decode 横向拉满——那会造成「前半对不上、后半空白」。
 */

import { desktop } from './desktop'

export type PeakSet = { peaks: Float32Array; duration: number }

const peakCache = new Map<string, PeakSet>()
const inflight = new Map<string, Promise<PeakSet | null>>()
const CACHE_VER = 'v6'

function cacheKey(mediaId: string, url: string, pathHint?: string) {
  return `${CACHE_VER}:${mediaId}:${pathHint || url}`
}

export function fileUrlToPath(url: string): string | undefined {
  if (!url || !/^file:/i.test(url)) return undefined
  try {
    let p = decodeURIComponent(url.replace(/^file:\/\//i, ''))
    if (p.startsWith('/') && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    if (/^[A-Za-z]:/.test(p)) return p.replace(/\//g, '\\')
    return p.startsWith('/') ? p : `/${p}`
  } catch {
    return undefined
  }
}

function binsForDuration(sec: number) {
  return Math.min(4096, Math.max(256, Math.ceil(Math.max(1, sec) * 60)))
}

async function peaksViaFfmpegPath(filePath: string, bins: number): Promise<PeakSet | null> {
  const d = desktop()
  if (!d?.waveformPeaks) return null
  try {
    const r = await d.waveformPeaks(filePath, bins)
    if (!r?.ok || !r.peaks?.length || !(r.duration! > 0)) return null
    return { peaks: Float32Array.from(r.peaks), duration: r.duration! }
  } catch {
    return null
  }
}

async function peaksViaFfmpegBuffer(
  data: ArrayBuffer,
  bins: number,
  ext: string,
): Promise<PeakSet | null> {
  const d = desktop()
  if (!d?.waveformPeaksBuffer) return null
  try {
    const r = await d.waveformPeaksBuffer(data, { bins, ext })
    if (!r?.ok || !r.peaks?.length || !(r.duration! > 0)) return null
    return { peaks: Float32Array.from(r.peaks), duration: r.duration! }
  } catch {
    return null
  }
}

/**
 * 按「媒体时长」均匀 seek 取样（与预览 HTMLAudio 同一解码器）。
 * duration 字段固定为 durationHint，保证和视频时间轴 1:1。
 */
async function peaksViaElement(
  url: string,
  durationHint: number,
  bins: number,
): Promise<PeakSet | null> {
  const el = document.createElement('audio')
  el.preload = 'auto'
  el.muted = true
  el.src = url

  try {
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => reject(new Error('meta')), { once: true })
      window.setTimeout(() => reject(new Error('meta-timeout')), 10000)
    })
  } catch {
    el.remove()
    return null
  }

  const mediaDur = durationHint > 0.05
    ? durationHint
    : (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0)
  if (!(mediaDur > 0.05)) {
    el.remove()
    return null
  }

  const seekMax = Number.isFinite(el.duration) && el.duration > 0
    ? Math.max(0, el.duration - 0.05)
    : mediaDur

  const ac = new AudioContext()
  try {
    if (ac.state === 'suspended') await ac.resume().catch(() => {})
    const src = ac.createMediaElementSource(el)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 2048
    const mute = ac.createGain()
    mute.gain.value = 0
    src.connect(analyser)
    analyser.connect(mute)
    mute.connect(ac.destination)
    const buf = new Float32Array(analyser.fftSize)
    const peaks = new Float32Array(bins)

    for (let i = 0; i < bins; i++) {
      // 严格按媒体时间轴取样，和视频对齐
      const mediaT = ((i + 0.5) / bins) * mediaDur
      el.currentTime = Math.min(seekMax, Math.max(0, mediaT))
      await new Promise<void>((resolve) => {
        el.addEventListener('seeked', () => resolve(), { once: true })
        window.setTimeout(() => resolve(), 240)
      })
      try { await el.play() } catch { /* */ }
      await new Promise((r) => window.setTimeout(r, 64))
      analyser.getFloatTimeDomainData(buf)
      el.pause()
      let peak = 0
      for (let j = 0; j < buf.length; j++) {
        const v = Math.abs(buf[j] ?? 0)
        if (v > peak) peak = v
      }
      peaks[i] = peak
    }
    return { peaks, duration: mediaDur }
  } catch {
    return null
  } finally {
    void ac.close()
    el.removeAttribute('src')
    el.load()
    el.remove()
  }
}

function extFromUrl(url: string, pathHint?: string) {
  const s = pathHint || url
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(s)
  return (m?.[1] || 'mp4').toLowerCase()
}

export async function loadWaveformPeaks(
  mediaId: string,
  url: string,
  opts?: { path?: string; durationHint?: number },
): Promise<PeakSet | null> {
  if (!mediaId || !url) return null
  const localPath = opts?.path || fileUrlToPath(url)
  const key = cacheKey(mediaId, url, localPath)
  const hit = peakCache.get(key)
  if (hit) return hit
  const pending = inflight.get(key)
  if (pending) return pending

  const hint = opts?.durationHint && opts.durationHint > 0 ? opts.durationHint : 5
  const bins = binsForDuration(hint)

  const job = (async () => {
    try {
      if (localPath) {
        const ff = await peaksViaFfmpegPath(localPath, bins)
        if (ff) {
          // 仅当与媒体时长几乎一致时用 hint 对齐标尺；绝不用长 hint 去「拉长」短峰值
          const duration =
            hint > 0 && Math.abs(hint - ff.duration) / Math.max(hint, ff.duration) < 0.12
              ? hint
              : ff.duration
          const out = { peaks: ff.peaks, duration }
          peakCache.set(key, out)
          return out
        }
      }

      // 无 path / ffmpeg 失败：整文件丢给主进程抽（blob 也能用）
      if (desktop()?.waveformPeaksBuffer) {
        try {
          const res = await fetch(url)
          if (res.ok) {
            const data = await res.arrayBuffer()
            if (data.byteLength > 0 && data.byteLength < 400_000_000) {
              const ff = await peaksViaFfmpegBuffer(data, bins, extFromUrl(url, localPath))
              if (ff) {
                const duration =
                  hint > 0 && Math.abs(hint - ff.duration) / Math.max(hint, ff.duration) < 0.12
                    ? hint
                    : ff.duration
                const out = { peaks: ff.peaks, duration }
                peakCache.set(key, out)
                return out
              }
            }
          }
        } catch { /* */ }
      }

      // 最后：按媒体时长 seek（对得上视频，可能较慢）
      const viaEl = await peaksViaElement(url, hint, Math.min(bins, 220))
      if (viaEl) {
        peakCache.set(key, viaEl)
        return viaEl
      }
      return null
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, job)
  return job
}

/**
 * 按媒体时间 [inPoint, outPoint] 取样；柱铺满片段宽度。
 * 对本段峰值归一并留头顶余量，避免轨内「顶满爆表」。
 */
export function slicePeaks(
  set: PeakSet,
  inPoint: number,
  outPoint: number,
  bars: number,
): number[] {
  const { peaks, duration } = set
  const n = peaks.length
  if (!n || bars <= 0 || !(duration > 0)) return []
  const span = Math.max(1e-4, outPoint - inPoint)
  const raw: number[] = []

  for (let i = 0; i < bars; i++) {
    const t0 = inPoint + (i / bars) * span
    const t1 = inPoint + ((i + 1) / bars) * span
    if (t1 <= 0 || t0 >= duration) {
      raw.push(0)
      continue
    }
    const f0 = Math.max(0, Math.min(1, t0 / duration))
    const f1 = Math.max(f0 + 1e-6, Math.min(1, t1 / duration))
    const i0 = Math.floor(f0 * n)
    const i1 = Math.max(i0 + 1, Math.ceil(f1 * n))
    let peak = 0
    for (let j = i0; j < i1 && j < n; j++) peak = Math.max(peak, peaks[j] ?? 0)
    raw.push(peak)
  }

  let max = 0
  for (const v of raw) if (v > max) max = v
  // 最高柱约占轨高 72%，留余量；弱电平用轻开方，不强拉满
  const HEADROOM = 0.72
  const inv = max > 1e-5 ? HEADROOM / max : 0
  return raw.map((v) => {
    if (inv <= 0) return 0
    const nrm = v * inv
    return Math.min(HEADROOM, Math.sqrt(nrm) * Math.sqrt(HEADROOM))
  })
}

export function clearWaveformCache() {
  peakCache.clear()
}
