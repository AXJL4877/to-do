/**
 * 预览帧成本实测（浏览器侧）：真实工程的序列喂给 renderProgramFrame，逐帧计时。
 * 关键指标：一帧要多少 ms。工程 30fps → 单帧预算 33.3ms，超了就必然冻帧/音画脱同步。
 */
import { useApp } from '../src/store'
import { getPreviewSize, renderProgramFrame } from '../src/lib/monitorDraw'
import { pictureClipsAt } from '../src/lib/programPlayer'
import { syncProduction } from '../src/lib/productionTimeline'
import type { Production } from '../src/lib/production'
import { defaultScene3d, type MediaItem, type ProjectSettings, type Sequence, type Track } from '../src/types'

const win = window as unknown as {
  __PROJECT__?: Record<string, unknown>
  __PRODUCTION__?: Production
  __TIMES__?: number[]
  __PERF__?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const prod = win.__PRODUCTION__
  if (prod) {
    // 按成片文档重建时间轴（和 APP 里 syncProduction 走同一条路）
    const track = (id: string, kind: Track['kind']): Track => ({
      id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48,
    })
    useApp.setState({
      started: true,
      media: [],
      folders: [],
      sequences: [{
        id: 'perf', name: 'perf',
        tracks: [track('v1', 'video'), track('v2', 'video'), track('v3', 'video'), track('v4', 'video'),
          track('a1', 'audio'), track('a2', 'audio'), track('s1', 'subtitle')],
        clips: [], markers: [], workIn: 0, workOut: 40, scene3d: defaultScene3d(),
      }],
      activeSeqId: 'perf',
      settings: {
        ...useApp.getState().settings, width: 1920, height: 1080, fps: 30,
        aiProductions: { [prod.id]: { t0: 0, auto: true, placed: {}, createdAt: 0 } },
      },
    })
    syncProduction(prod)
  } else {
    const proj = win.__PROJECT__ as {
      media?: MediaItem[]
      sequences?: Sequence[]
      activeSeqId?: string
      settings?: ProjectSettings
    }
    if (!proj?.sequences?.length) throw new Error('工程没有 sequence')
    useApp.setState({
      started: true,
      media: proj.media ?? [],
      folders: [],
      sequences: proj.sequences,
      activeSeqId: proj.activeSeqId || proj.sequences[0].id,
      settings: { ...useApp.getState().settings, ...(proj.settings ?? {}) },
    })
  }

  const st = useApp.getState()
  const seq = st.seq()
  const media = st.media
  const { w, h } = getPreviewSize(st.settings, 'balanced')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const imgCache = new Map<string, HTMLImageElement>()

  // 预热所有图片（真实 App 也有这条缓存）
  const t0 = performance.now()
  await Promise.all(media.filter((m) => m.kind === 'image' || m.kind === 'sticker').map((m) => new Promise<void>((done) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { imgCache.set(m.id, img); done() }
    img.onerror = () => done()
    img.src = m.url
  })))
  const warmMs = Math.round(performance.now() - t0)

  const byId = new Map(media.map((m) => [m.id, m]))
  const rows: Record<string, unknown>[] = []
  for (const t of win.__TIMES__ ?? [0]) {
    const active = pictureClipsAt(seq, t)
    const videos = active.filter((c) => byId.get(c.mediaId)?.kind === 'video')
    const audios = seq.clips.filter((c) => c.start <= t && t < c.start + c.duration && byId.get(c.mediaId)?.kind === 'audio')
    // 先让视频槽有机会出帧，再量稳定态
    renderProgramFrame(canvas, seq, media, st.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
    await sleep(500)
    const samples: number[] = []
    for (let i = 0; i < 12; i++) {
      const s = performance.now()
      renderProgramFrame(canvas, seq, media, st.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
      samples.push(performance.now() - s)
    }
    samples.sort((a, b) => a - b)
    rows.push({
      t,
      frameMs: {
        min: +samples[0].toFixed(1),
        median: +samples[Math.floor(samples.length / 2)].toFixed(1),
        max: +samples[samples.length - 1].toFixed(1),
      },
      active: active.length,
      videos: videos.length,
      audios: audios.length,
      videoCodecs: [...new Set(videos.map((c) => {
        const m = byId.get(c.mediaId)!
        return `${m.name.slice(-14)}${m.alpha ? '(alpha)' : ''}`
      }))].slice(0, 4),
      clipNames: active.map((c) => `${c.name || ''}`.slice(0, 12)).slice(0, 6),
    })
  }

  win.__PERF__ = { ok: true, size: `${w}x${h}`, warmMs, images: imgCache.size, rows, playback: await playback(seq, media, st.settings, canvas, ctx, w, h, imgCache) }
}

/** 播放仿真：按 30fps 推播放头，记录每步耗时 + 视频槽实际出帧时间（冻帧/脱同步会在这里现形） */
async function playback(
  seq: Sequence, media: MediaItem[], settings: ProjectSettings,
  canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number,
  imgCache: Map<string, HTMLImageElement>,
) {
  const { shownVideoTime } = await import('../src/lib/videoCache')
  const { mediaTimeAt } = await import('../src/lib/programPlayer')
  const byId = new Map(media.map((m) => [m.id, m]))
  const from = Number((win as unknown as { __PLAY_FROM__?: number }).__PLAY_FROM__ ?? 4.2)
  const secs = Number((win as unknown as { __PLAY_SECS__?: number }).__PLAY_SECS__ ?? 2.2)
  const fps = settings.fps || 30
  const steps: Record<string, unknown>[] = []
  const n = Math.round(secs * fps)
  for (let i = 0; i < n; i++) {
    const t = from + i / fps
    const s = performance.now()
    renderProgramFrame(canvas, seq, media, settings, t, imgCache, w, h, [], undefined, false, undefined, true)
    const ms = performance.now() - s
    const vids = pictureClipsAt(seq, t).filter((c) => byId.get(c.mediaId)?.kind === 'video')
    const detail = vids.map((c) => {
      const shown = shownVideoTime(c.id)
      const want = mediaTimeAt(c, t, fps)
      return {
        name: (c.name || '').slice(-14),
        shown: shown == null ? null : +shown.toFixed(3),
        want: +want.toFixed(3),
        lag: shown == null ? null : +(want - shown).toFixed(3),
      }
    })
    steps.push({ t: +t.toFixed(3), ms: +ms.toFixed(1), videos: detail })
    await sleep(1000 / fps)
  }
  const lags = steps.flatMap((s) => (s.videos as { lag: number | null }[]).map((v) => v.lag)).filter((x): x is number => x != null)
  const nulls = steps.flatMap((s) => (s.videos as { lag: number | null }[]).map((v) => v.lag)).filter((x) => x == null).length
  lags.sort((a, b) => a - b)
  const ms = steps.map((s) => s.ms as number).sort((a, b) => a - b)
  return {
    window: `${from}~${(from + secs).toFixed(2)}s`, steps: steps.length,
    frameMs: { median: +ms[Math.floor(ms.length / 2)].toFixed(1), max: +ms[ms.length - 1].toFixed(1) },
    videoLag: { samples: lags.length, neverShown: nulls, median: lags.length ? +lags[Math.floor(lags.length / 2)].toFixed(3) : null, max: lags.length ? +lags[lags.length - 1].toFixed(3) : null },
    sample: steps.filter((_, i) => i % 12 === 0).slice(0, 8),
  }
}

void main().catch((e) => { win.__PERF__ = { failed: true, error: String(e && e.stack ? e.stack : e) } })
