/**
 * 预览黑屏门（浏览器侧）：真入轨 + 真 renderProgramFrame 取样。
 *
 * 守四条契约：
 *   1. 满幅近黑转场必须带 chromaKey=nearblack，丢了就是满幅黑屏（老工程的坑）
 *   2. 扩展自己编的入场片 / 转场片，宿主必须解得出且带真透明（qtrle 就死在这条）
 *   3. 入场层在入场窗口里必须真的画出来（元素动向，不是等定格图才出现）
 *   4. 真 alpha 转场压在底板上不能把画面盖黑
 */
import { useApp } from '../src/store'
import { syncProduction } from '../src/lib/productionTimeline'
import { getPreviewSize, renderProgramFrame } from '../src/lib/monitorDraw'
import { mayHaveAlpha } from '../src/lib/mediaAlpha'
import type { Production } from '../src/lib/production'
import { defaultScene3d, type MediaItem, type Track } from '../src/types'

const results: { name: string; ok: boolean; error?: string }[] = []
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: String(e) }) }
}

const win = window as unknown as {
  kouboPreviewGateFixture?: Production
  kouboPreviewGateResult?: unknown
}

const track = (id: string, kind: Track['kind']): Track => ({
  id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type FrameStat = { t: number; blackPct: number; meanLuma: number; orangePct: number; size: string; dataUrl: string }

/** 在时间轴某一刻出帧并统计：近黑占比 / 平均亮度 / 橙块占比（角色的实心橙） */
async function sampleAt(t: number): Promise<FrameStat> {
  const st = useApp.getState()
  const seq = st.seq()
  const media = st.media
  const { w, h } = getPreviewSize(st.settings, 'balanced')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const imgCache = new Map<string, HTMLImageElement>()
  await Promise.all(media.filter((m) => m.kind === 'image').map((m) => new Promise<void>((done) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { imgCache.set(m.id, img); done() }
    img.onerror = () => done()
    img.src = m.url
  })))
  renderProgramFrame(canvas, seq, media, st.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
  await sleep(900)
  renderProgramFrame(canvas, seq, media, st.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
  await sleep(400)
  renderProgramFrame(canvas, seq, media, st.settings, t, imgCache, w, h, [], undefined, false, undefined, true)
  const d = ctx.getImageData(0, 0, w, h).data
  let dark = 0, orange = 0, sum = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2]
    sum += (r * 299 + g * 587 + b * 114) / 1000
    if (Math.max(r, g, b) <= 24) dark++
    // 夹具里的角色是纯橙 (240,140,20)
    if (r > 180 && g > 90 && g < 190 && b < 80) orange++
  }
  return {
    t,
    blackPct: Math.round(dark * 1000 / n) / 10,
    meanLuma: Math.round(sum / n * 10) / 10,
    orangePct: Math.round(orange * 1000 / n) / 10,
    size: `${w}x${h}`,
    dataUrl: canvas.toDataURL('image/png'),
  }
}

/** 直接把素材丢进 <video> 量真透明：宿主解不出时 transparent% 会是 0/空。
 *  注意取帧时刻：入场片任意时刻周围都透明；泡泡遮罩层开头是"还没揭开"的不透明黑场，
 *  必须取末段——那时应几乎全透明（画面已揭开）。 */
async function videoAlpha(url: string, at: number): Promise<{ loaded: boolean; vw: number; transparentPct: number; error: string }> {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  const settled = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000)
    v.onloadeddata = () => { clearTimeout(timer); resolve('ok') }
    v.onerror = () => { clearTimeout(timer); resolve('error') }
  })
  v.src = url
  const how = await settled
  const err = v.error ? `${v.error.code}:${v.error.message || ''}` : ''
  if (how !== 'ok') return { loaded: false, vw: 0, transparentPct: 0, error: err || how }
  // 等真正 seek 到目标时刻再取帧。原来只 sleep 固定 500ms：seek 慢一点就会画到
  // seek 之前的帧（开头是"没揭开"的不透明黑场），transparent% 随机变 0 —— 门本身是好的，
  // 但会间歇性假红。这里改成等 seeked + readyState 有帧，再给合成器几帧时间。
  const v1 = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
  await new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      v.removeEventListener('seeked', finish)
      resolve()
    }
    timer = setTimeout(finish, 8000)
    v.addEventListener('seeked', finish)
    v.currentTime = at
    if (v.readyState >= 2 && Math.abs(v.currentTime - at) < 0.5) finish()
  })
  for (let i = 0; i < 120; i++) {
    if (v.readyState >= 2 && !v.seeking) break
    await sleep(25)
  }
  await new Promise<void>((resolve) => {
    // 有 rVFC 就用它确认"这一帧已经交到合成器"，否则退回短暂等待
    if (typeof v1.requestVideoFrameCallback === 'function') {
      const t = setTimeout(resolve, 1000)
      v1.requestVideoFrameCallback!(() => { clearTimeout(t); resolve() })
    } else {
      setTimeout(resolve, 400)
    }
  })
  const c = document.createElement('canvas')
  c.width = Math.max(1, v.videoWidth)
  c.height = Math.max(1, v.videoHeight)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.clearRect(0, 0, c.width, c.height)
  g.drawImage(v, 0, 0, c.width, c.height)
  const d = g.getImageData(0, 0, c.width, c.height).data
  let tr = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] <= 10) tr++
  return { loaded: true, vw: v.videoWidth, transparentPct: Math.round(tr * 1000 / (d.length / 4)) / 10, error: '' }
}

const nearBlackMedia = (m: MediaItem) => /wipe\.mp4$/i.test(m.name) || /wipe\.mp4$/i.test(m.url)

async function main() {
  const fixture = win.kouboPreviewGateFixture
  if (!fixture) throw new Error('缺少 fixture')
  const PID = fixture.id

  useApp.setState({
    started: true,
    media: [],
    folders: [],
    sequences: [{
      id: 'gate',
      name: 'gate',
      tracks: [track('v1', 'video'), track('v2', 'video'), track('v3', 'video'),
        track('a1', 'audio'), track('s1', 'subtitle')],
      clips: [], markers: [], workIn: 0, workOut: 10, scene3d: defaultScene3d(),
    }],
    activeSeqId: 'gate',
    settings: {
      ...useApp.getState().settings,
      width: 1920, height: 1080, fps: 30,
      aiProductions: { [PID]: { t0: 0, auto: true, placed: {}, createdAt: 0 } },
    },
  })

  const changed = syncProduction(fixture)
  const nb = useApp.getState().media.find(nearBlackMedia)
  const sprite = useApp.getState().media.find((m) => /sprite\.webm$/i.test(m.url))
  const vp9wipe = useApp.getState().media.find((m) => /wipe\.webm$/i.test(m.url))

  await test('入轨：两板共 5 条画面片段', () => {
    check(changed, '应入轨')
    const keys = useApp.getState().seq().clips
      .filter((c) => c.meta?.source?.jobId === PID)
      .map((c) => String(c.meta?.source?.key || ''))
    for (const want of ['/e_plate/hold', '/e_nearblack/draw', '/e_plate2/hold', '/e_sprite/draw', '/e_wipe_vp9/draw']) {
      check(keys.some((k) => k.endsWith(want)), `缺 ${want}：${keys.join('|')}`)
    }
  })

  await test('近黑转场素材保留 chromaKey=nearblack（导入不丢字段）', () => {
    check(nb, '近黑素材没进媒体库')
    check(nb!.chromaKey === 'nearblack', `chromaKey 丢了: ${JSON.stringify(nb!.chromaKey)}`)
    check(mayHaveAlpha(nb!), '近黑转场必须按可透明层处理，否则会被当成不透明黑层')
  })

  await test('扩展编的入场片宿主能解出真透明（qtrle 会在这里红）', async () => {
    check(sprite, '入场片没进媒体库')
    const a = await videoAlpha(sprite!.url, 0.05)
    check(a.loaded, `宿主解不出入场片：${a.error}`)
    check(a.transparentPct > 20, `入场片没有真透明 transparent%=${a.transparentPct}（被烤成不透明黑底了？）`)
  })

  await test('扩展编的满幅转场宿主能解出真透明（末段应几乎全透）', async () => {
    check(vp9wipe, '转场片没进媒体库')
    const a = await videoAlpha(vp9wipe!.url, 1.7)
    check(a.loaded, `宿主解不出转场片：${a.error}`)
    check(a.transparentPct > 80, `转场末段没揭开画面 transparent%=${a.transparentPct}`)
  })

  let entrance: FrameStat | null = null
  await test('元素动向：入场窗口里角色真的画出来了', async () => {
    entrance = await sampleAt(3.15)
    check(entrance!.orangePct > 0.3, `入场窗口看不到角色 orange%=${entrance!.orangePct}（入场层没渲染）`)
    check(entrance!.meanLuma > 60, `入场窗口整体太黑 meanLuma=${entrance!.meanLuma}`)
  })

  await test('泡泡自带音效落到独立音轨（不是被丢掉）', () => {
    const st = useApp.getState()
    const clip = st.seq().clips.find((c) => String(c.meta?.source?.key || '').endsWith('/e_wipe_vp9/sfx'))
    check(clip, '时间轴上没有泡泡音效片段（片源音轨被丢了？）')
    const m = st.media.find((x) => x.id === clip!.mediaId)
    check(m?.kind === 'audio', `音效素材类型不对: ${m?.kind}`)
    const track = st.seq().tracks.find((t) => t.id === clip!.trackId)
    check(track?.kind === 'audio', `音效没落在音频轨: ${track?.kind}`)
    check(clip!.duration > 0.5, `音效时长为 0: ${clip!.duration}`)
  })

  let vp9WipeFrame: FrameStat | null = null
  await test('真 alpha 转场压在底板上不盖黑', async () => {
    vp9WipeFrame = await sampleAt(5.4)
    check(vp9WipeFrame!.meanLuma > 60, `转场窗口太黑 meanLuma=${vp9WipeFrame!.meanLuma}`)
  })

  let fresh: FrameStat | null = null
  await test('新导入：近黑转场窗口预览不黑', async () => {
    fresh = await sampleAt(1.0)
    check(fresh!.meanLuma > 60, `预览太黑 meanLuma=${fresh!.meanLuma} black%=${fresh!.blackPct}（底板被满幅转场盖住）`)
  })

  let broken: FrameStat | null = null
  let repaired: FrameStat | null = null
  await test('老工程（素材无 chromaKey）：确认能复现黑屏——门本身有效', async () => {
    useApp.setState({
      media: useApp.getState().media.map((m) => (nearBlackMedia(m) ? { ...m, chromaKey: undefined } : m)),
    })
    broken = await sampleAt(1.0)
    check(broken!.meanLuma < 25, `对照态应该黑，实际 meanLuma=${broken!.meanLuma}：门抓不到黑屏就没意义`)
  })

  await test('再对账一次：素材元数据被修复，预览恢复', async () => {
    const fixed = syncProduction(fixture)
    const w2 = useApp.getState().media.find(nearBlackMedia)
    check(w2?.chromaKey === 'nearblack', `对账没修复 chromaKey: ${JSON.stringify(w2?.chromaKey)}`)
    check(fixed, '修复应报告有改动（好让工程落盘）')
    repaired = await sampleAt(1.0)
    check(repaired!.meanLuma > 60, `修复后仍黑 meanLuma=${repaired!.meanLuma}`)
  })

  await test('修复后继续对账不再改：不会反复落盘', () => {
    check(!syncProduction(fixture), 'chromaKey 已补回，后续对账不该再报改动')
  })

  const out = {
    failed: results.some((r) => !r.ok),
    results,
    entrance,
    vp9WipeFrame,
    fresh,
    broken,
    repaired,
    clips: useApp.getState().seq().clips.map((c) => {
      const m = useApp.getState().media.find((x) => x.id === c.mediaId)
      return {
        key: String(c.meta?.source?.key || ''), start: c.start, duration: c.duration,
        track: useApp.getState().seq().tracks.find((t) => t.id === c.trackId)?.id,
        media: m?.name || c.name, kind: m?.kind || '', alpha: !!m?.alpha, chromaKey: m?.chromaKey || '',
      }
    }),
  }
  win.kouboPreviewGateResult = out
  const meta = document.getElementById('meta')
  if (meta) meta.textContent = JSON.stringify({ entrance, vp9WipeFrame, fresh, broken, repaired })
}

void main().catch((e) => {
  win.kouboPreviewGateResult = {
    failed: true,
    results: [...results, { name: 'boot', ok: false, error: String(e && e.stack ? e.stack : e) }],
  }
})
