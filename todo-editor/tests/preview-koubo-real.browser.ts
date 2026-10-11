/**
 * 真实分层成片 → 入轨 → 用宿主 renderProgramFrame 逐帧取样。
 * 判定黑屏：整帧近黑（#0b0d10 容差内）占比高 = 预览黑屏。
 */
import { useApp } from '../src/store'
import { syncProduction } from '../src/lib/productionTimeline'
import { getPreviewSize, renderProgramFrame } from '../src/lib/monitorDraw'
import type { Production } from '../src/lib/production'
import { defaultScene3d, type Track } from '../src/types'

const win = window as unknown as {
  spongebobProductionFixture?: Production
  __TIMES__?: number[]
  kouboPreviewResult?: unknown
}

const track = (id: string, kind: Track['kind']): Track => ({
  id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48,
})

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`img fail ${url}`))
    img.src = url
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const fixture = win.spongebobProductionFixture
  if (!fixture) throw new Error('缺少 production fixture')
  const PID = fixture.id
  const times = win.__TIMES__ || [0.5, 2, 4.4, 5.2, 7, 12]

  useApp.setState({
    started: true,
    media: [],
    folders: [],
    sequences: [{
      id: 'koubo-preview',
      name: 'preview',
      tracks: [track('v1', 'video'), track('v2', 'video'), track('v3', 'video'), track('v4', 'video'),
        track('a1', 'audio'), track('a2', 'audio'), track('s1', 'subtitle')],
      clips: [], markers: [], workIn: 0, workOut: 20, scene3d: defaultScene3d(),
    }],
    activeSeqId: 'koubo-preview',
    settings: {
      ...useApp.getState().settings,
      width: 1920, height: 1080, fps: 30,
      aiProductions: { [PID]: { t0: 0, auto: true, placed: {}, createdAt: 0 } },
    },
  })

  const changed = syncProduction(fixture)
  const st = useApp.getState()
  const seq = st.seq()
  const media = st.media
  const clips = seq.clips
    .filter((c) => c.meta?.source?.jobId === PID)
    .map((c) => {
      const m = media.find((x) => x.id === c.mediaId)
      return {
        key: String(c.meta?.source?.key || ''),
        name: c.name || '',
        start: Math.round(c.start * 1000) / 1000,
        duration: Math.round(c.duration * 1000) / 1000,
        media: m?.name || '',
        kind: m?.kind || '',
        alpha: !!m?.alpha,
        chromaKey: m?.chromaKey || '',
        url: m?.url || '',
        track: seq.tracks.find((t) => t.id === c.trackId)?.kind || '',
      }
    })
    .sort((a, b) => a.start - b.start)

  // 预热图片
  const imgCache = new Map<string, HTMLImageElement>()
  await Promise.all(media
    .filter((m) => m.kind === 'image' || m.kind === 'sticker')
    .map(async (m) => {
      try { imgCache.set(m.id, await loadImage(m.url)) } catch { /* 缺图就是缺图 */ }
    }))

  const { w, h } = getPreviewSize(st.settings, 'balanced')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!

  const mediaAlphaState = media
    .filter((m) => m.kind === 'video')
    .map((m) => ({ name: m.name, alpha: !!m.alpha, chromaKey: m.chromaKey || '' }))

  async function sample(times: number[], tag: string) {
    const outFrames: Record<string, unknown>[] = []
    const mNow = useApp.getState().media
    const sNow = useApp.getState()
    const seqNow = sNow.seq()
    for (const t of times) {
      renderProgramFrame(canvas, seqNow, mNow, sNow.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
      await sleep(900)
      renderProgramFrame(canvas, seqNow, mNow, sNow.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
      await sleep(500)
      renderProgramFrame(canvas, seqNow, mNow, sNow.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
      const d = ctx.getImageData(0, 0, w, h).data
      const n = d.length / 4
      let nearBlack = 0, colored = 0, other = 0, sum = 0
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2]
        const mx = Math.max(r, g, b)
        sum += (r * 299 + g * 587 + b * 114) / 1000
        const isBg = Math.abs(r - 11) <= 10 && Math.abs(g - 13) <= 10 && Math.abs(b - 16) <= 10
        if (isBg) nearBlack++
        else if (mx > 40) colored++
        else other++
      }
      outFrames.push({
        tag,
        t,
        size: `${w}x${h}`,
        bgPct: Math.round(nearBlack * 1000 / n) / 10,
        coloredPct: Math.round(colored * 1000 / n) / 10,
        darkPct: Math.round(other * 1000 / n) / 10,
        meanLuma: Math.round(sum / n * 10) / 10,
        dataUrl: canvas.toDataURL('image/png'),
      })
    }
    return outFrames
  }

  // 对照：把被丢掉的 chromaKey 从素材里抹掉，模拟修复前导入的老工程
  const isWipe = (m: { url: string; name: string }) => /wipe\.mp4$/i.test(m.url) || /转场\.mp4$/i.test(m.url)
  const stripKey = () => {
    useApp.setState({
      media: useApp.getState().media.map((m) => (isWipe(m) ? { ...m, chromaKey: undefined, alpha: false } : m)),
    })
  }

  const frames = await sample(times, 'fresh')

  // 老工程：素材里没有 chromaKey（修复前导入的）→ 先看黑屏
  let brokenFrames: Record<string, unknown>[] = []
  let repairedFrames: Record<string, unknown>[] = []
  let repairedChanged = false
  if (media.some(isWipe)) {
    stripKey()
    brokenFrames = await sample(times, 'legacy-broken')
    repairedChanged = syncProduction(fixture)
    repairedFrames = await sample(times, 'legacy-repaired')
  }

  win.kouboPreviewResult = {
    failed: false,
    id: PID,
    changed,
    repairedChanged,
    layerMode: fixture.segments[0].boards.some((b) => b.render?.result?.layout === 'source-layers') ? 'source-layers' : 'other',
    clipCount: clips.length,
    clips,
    mediaAlphaState,
    frames,
    brokenFrames,
    repairedFrames,
  }
  const meta = document.getElementById('meta')
  if (meta) meta.textContent = `clips=${clips.length} changed=${changed}`
}

void main().catch((e) => {
  win.kouboPreviewResult = { failed: true, error: String(e && e.stack ? e.stack : e) }
})
