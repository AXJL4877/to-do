/** 媒体音量峰值：优先 ffmpeg（与预览同源），其次 WebAudio；按真实采样时长切片 */

import { desktop } from './desktop'

export type PeakSet = { peaks: Float32Array; duration: number }

const peakCache = new Map<string, PeakSet>()
const inflight = new Map<string, Promise<PeakSet | null>>()

const CACHE_VER = 'v3'

function cacheKey(mediaId: string, url: string, pathHint?: string) {
  return `${CACHE_VER}:${mediaId}:${pathHint || url}`
}

function peaksFromBuffer(audio: AudioBuffer): PeakSet {
  const len = audio.length
  const duration = Math.max(1e-3, len / audio.sampleRate)
  const bins = Math.min(4096, Math.max(256, Math.ceil(duration * 48)))
  const peaks = new Float32Array(bins)
  const channels = audio.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const ch = audio.getChannelData(c)
    for (let i = 0; i < bins; i++) {
      const start = Math.floor((i / bins) * len)
      const end = Math.max(start + 1, Math.floor(((i + 1) / bins) * len))
      let peak = 0
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j])
        if (v > peak) peak = v
      }
      if (peak > peaks[i]) peaks[i] = peak
    }
  }
  return { peaks, duration }
}

/** 后 30% 近乎静音而前段有能量 → decodeAudioData 常见「半截」假静音 */
function hasDeadTail(set: PeakSet, durationHint?: number): boolean {
  const { peaks, duration } = set
  const n = peaks.length
  if (n < 16) return false
  if (durationHint && durationHint > duration * 1.08) return true
  let maxHead = 0
  let maxTail = 0
  const hEnd = Math.floor(n * 0.35)
  const tStart = Math.floor(n * 0.65)
  for (let i = 0; i < hEnd; i++) maxHead = Math.max(maxHead, peaks[i] ?? 0)
  for (let i = tStart; i < n; i++) maxTail = Math.max(maxTail, peaks[i] ?? 0)
  return maxHead > 0.02 && maxTail < maxHead * 0.04
}

async function peaksViaFfmpeg(filePath: string, bins = 1024): Promise<PeakSet | null> {
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

async function peaksViaDecode(url: string): Promise<PeakSet | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = await res.arrayBuffer()
    const ac = new AudioContext()
    try {
      const audio = await ac.decodeAudioData(raw.slice(0))
      return peaksFromBuffer(audio)
    } finally {
      void ac.close()
    }
  } catch {
    return null
  }
}

/** 与节目预览同一 HTMLAudio 解码路径：按时长 seek 采样（偏慢，作回退） */
async function peaksViaElement(url: string, durationHint: number, bins = 192): Promise<PeakSet | null> {
  const el = document.createElement('audio')
  el.preload = 'auto'
  el.muted = true
  el.crossOrigin = 'anonymous'
  el.src = url

  try {
    await new Promise<void>((resolve, reject) => {
      const ok = () => resolve()
      const bad = () => reject(new Error('meta'))
      el.addEventListener('loadedmetadata', ok, { once: true })
      el.addEventListener('error', bad, { once: true })
    })
  } catch {
    el.remove()
    return null
  }

  const dur =
    Number.isFinite(el.duration) && el.duration > 0 ? el.duration : durationHint
  if (!(dur > 0.05)) {
    el.remove()
    return null
  }

  const ac = new AudioContext()
  try {
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
      const t = Math.min(Math.max(0, dur - 0.05), ((i + 0.5) / bins) * dur)
      el.currentTime = t
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        el.addEventListener('seeked', done, { once: true })
        window.setTimeout(done, 180)
      })
      try {
        await el.play()
      } catch { /* autoplay */ }
      await new Promise((r) => window.setTimeout(r, 40))
      analyser.getFloatTimeDomainData(buf)
      el.pause()
      let peak = 0
      for (let j = 0; j < buf.length; j++) {
        const v = Math.abs(buf[j] ?? 0)
        if (v > peak) peak = v
      }
      peaks[i] = peak
    }
    return { peaks, duration: dur }
  } catch {
    return null
  } finally {
    void ac.close()
    el.removeAttribute('src')
    el.load()
    el.remove()
  }
}

export async function loadWaveformPeaks(
  mediaId: string,
  url: string,
  opts?: { path?: string; durationHint?: number },
): Promise<PeakSet | null> {
  if (!mediaId || !url) return null
  const key = cacheKey(mediaId, url, opts?.path)
  const hit = peakCache.get(key)
  if (hit) return hit
  const pending = inflight.get(key)
  if (pending) return pending

  const job = (async () => {
    try {
      const hint = opts?.durationHint && opts.durationHint > 0 ? opts.durationHint : undefined

      if (opts?.path) {
        const ff = await peaksViaFfmpeg(opts.path)
        if (ff && !hasDeadTail(ff, hint)) {
          peakCache.set(key, ff)
          return ff
        }
      }

      const decoded = await peaksViaDecode(url)
      if (decoded && !hasDeadTail(decoded, hint)) {
        peakCache.set(key, decoded)
        return decoded
      }

      const viaEl = await peaksViaElement(url, hint ?? decoded?.duration ?? 5)
      if (viaEl) {
        peakCache.set(key, viaEl)
        return viaEl
      }

      if (decoded) {
        peakCache.set(key, decoded)
        return decoded
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
 * 按片段 in/out（媒体时间）取样；柱 i 对应时间轴从左到右。
 * 媒体时间超出已解码峰值时长时该柱为 0（完整峰值应覆盖整段）。
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
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    const t0 = inPoint + (i / bars) * span
    const t1 = inPoint + ((i + 1) / bars) * span
    if (t1 <= 0 || t0 >= duration) {
      out.push(0)
      continue
    }
    const f0 = Math.max(0, Math.min(1, t0 / duration))
    const f1 = Math.max(f0 + 1e-6, Math.min(1, t1 / duration))
    const i0 = Math.floor(f0 * n)
    const i1 = Math.max(i0 + 1, Math.ceil(f1 * n))
    let peak = 0
    for (let j = i0; j < i1 && j < n; j++) peak = Math.max(peak, peaks[j] ?? 0)
    out.push(Math.min(1, peak * 1.35))
  }
  return out
}
