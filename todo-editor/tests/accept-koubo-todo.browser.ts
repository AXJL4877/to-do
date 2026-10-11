/**
 * 海绵宝宝实机验收：开场红字入轨、元素可单独缩放、分层连贯、字幕/配音在。
 * BGM：配音轨来自含 BGM 成片（由脚本侧 RMS 对照）；此处确认 voice 已挂上。
 */
import { useApp } from '../src/store'
import { syncProduction } from '../src/lib/productionTimeline'
import type { Production } from '../src/lib/production'
import { defaultScene3d, type Track } from '../src/types'

const results: { name: string; ok: boolean; error?: string }[] = []
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (e) {
    results.push({ name, ok: false, error: String(e) })
  }
}

const track = (id: string, kind: Track['kind']): Track => ({
  id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48,
})

async function main() {
  const fixture = (window as unknown as { spongebobProductionFixture?: Production }).spongebobProductionFixture
  check(fixture, '缺少 production fixture')
  const PID = fixture!.id
  const doc = fixture as Production & { sourceFilm?: unknown; sourceLayers?: unknown }

  useApp.setState({
    started: true,
    media: [],
    folders: [],
    sequences: [{
      id: 'accept-koubo',
      name: 'accept',
      tracks: [track('v1', 'video'), track('a1', 'audio'), track('s1', 'subtitle')],
      clips: [],
      markers: [],
      workIn: 0,
      workOut: 20,
      scene3d: defaultScene3d(),
    }],
    activeSeqId: 'accept-koubo',
    settings: {
      ...useApp.getState().settings,
      width: 1920,
      height: 1080,
      fps: 30,
      aiProductions: { [PID]: { t0: 0, auto: true, placed: {}, createdAt: 0 } },
    },
  })

  await test('文档含开场红字层 + 多板连续', () => {
    const seg = fixture!.segments[0]
    check(seg.boards?.length >= 2, `boards=${seg.boards?.length}`)
    const labels = seg.boards.flatMap((b) => (b.render?.result?.elements || []).map((e) => e.label || ''))
    check(labels.some((l) => l.includes('开场红字') || l.includes('红字')), `无开场红字: ${labels.join(',')}`)
    const windows = seg.boards.map((b) => ({
      s: b.render!.result!.startMs,
      e: b.render!.result!.endMs,
    }))
    check(windows[0].s <= 80, `未从 0 起: ${windows[0].s}`)
    for (let i = 1; i < windows.length; i++) {
      check(Math.abs(windows[i].s - windows[i - 1].e) <= 80, `镜间空隙 ${windows[i - 1].e}->${windows[i].s}`)
    }
  })

  await test('入轨：红字/角色分轨 + 配音 + 字幕', () => {
    check(syncProduction(fixture!), '应入轨')
    const clips = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === PID)
    const holds = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/hold'))
    const voice = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/voice'))
    const intro = holds.find((c) => (c.name || '').includes('开场红字') || (c.name || '').includes('红字'))
    check(intro, `入轨无开场红字 hold，holds=${holds.map((c) => c.name).join('|')}`)
    check(holds.length >= 4, `hold 不足 ${holds.length}`)
    check(voice.length >= 1, '缺配音轨（含 BGM 混音）')
    check(voice[0].duration > 5, `配音过短 ${voice[0].duration}`)
    const xs = new Set(holds.map((c) => Math.round((c.transform?.x ?? 0) * 1000)))
    check(xs.size >= 2, `元素未分开 x=${[...xs]}`)
  })

  await test('改缩放只影响开场红字', () => {
    const clips = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === PID)
    const holds = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/hold'))
    const intro = holds.find((c) => (c.name || '').includes('开场红字') || (c.name || '').includes('红字'))!
    const others = holds.filter((c) => c.id !== intro.id).map((c) => ({
      id: c.id, s: c.transform?.scaleX,
    }))
    const before = intro.transform?.scaleX || 1
    useApp.getState().patchClipsQuiet({
      [intro.id]: {
        transform: {
          ...intro.transform!,
          scaleX: before * 1.45,
          scaleY: (intro.transform?.scaleY || 1) * 1.45,
          x: (intro.transform?.x || 0) + 0.06,
        },
      },
    })
    const after = useApp.getState().seq().clips.find((c) => c.id === intro.id)!
    check((after.transform?.scaleX || 0) > before * 1.2, '红字缩放未生效')
    for (const o of others) {
      const cur = useApp.getState().seq().clips.find((c) => c.id === o.id)!
      check(Math.abs((cur.transform?.scaleX || 0) - (o.s || 0)) < 1e-6, `其它元素缩放被改: ${cur.name}`)
    }
  })

  await test('画布绘出开场红字 hold（可见红像素）', async () => {
    const seg = fixture!.segments[0]
    const introEl = seg.boards[0].render!.result!.elements.find((e) => (e.label || '').includes('红字'))
    check(introEl?.hold, '无 intro hold 路径')
    const aiRoot = (window as unknown as { __AI_ROOT__?: string }).__AI_ROOT__ || ''
    const file = String(introEl!.hold).replace(/^\/?ai-generated\//, '')
    const url = aiRoot ? `file:///${aiRoot}/${file}` : introEl!.hold
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`load fail ${url}`))
      img.src = url
    })
    const cv = document.getElementById('cv') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, cv.width, cv.height)
    const crop = introEl!.crop || [0, 0, img.width, img.height]
    const [cx, cy] = crop
    ctx.drawImage(img, cx, cy)
    const sample = ctx.getImageData(cv.width / 2 - 40, cv.height / 2 - 40, 80, 80).data
    let redish = 0
    for (let i = 0; i < sample.length; i += 4) {
      if (sample[i] > 120 && sample[i] > sample[i + 1] * 1.2 && sample[i] > sample[i + 2] * 1.2) redish++
    }
    check(redish > 30, `开场层中间区缺少红像素 redish=${redish}`)
    const meta = document.getElementById('meta')
    if (meta) meta.textContent = `开场红字 OK · redish=${redish} · boards=${fixture!.segments[0].boards.length}`
  })

  ;(window as unknown as { kouboAcceptTests: unknown }).kouboAcceptTests = {
    failed: results.some((r) => !r.ok),
    id: PID,
    layout: fixture!.segments[0].boards[0]?.render?.result?.layout,
    boards: fixture!.segments[0].boards.length,
    sourceFilm: !!doc.sourceFilm,
    sourceLayers: doc.sourceLayers,
    results,
  }
}

void main().catch((e) => {
  ;(window as unknown as { kouboAcceptTests: unknown }).kouboAcceptTests = {
    failed: true,
    results: [{ name: 'boot', ok: false, error: String(e) }],
  }
})
