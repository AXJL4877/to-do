/**
 * 单帧渲染入口（浏览器侧，由 scripts/render-frame.mjs 用 esbuild 打包后在 Electron 里执行）。
 *
 * 关键点：用的就是应用监视器那条渲染路径 `renderProgramFrame`（src/lib/monitorDraw.ts），
 * 所以 agent 渲出来的帧和用户在编辑窗里看到的是同一套合成逻辑，不是另写一个"近似实现"。
 * 这是「预览=导出」这条不变量的最小可验证形式：能渲出一帧、能量、能比对两次是否一致。
 */
import { getPreviewSize, renderProgramFrame } from '../src/lib/monitorDraw'
import { pictureClipsAt } from '../src/lib/programPlayer'
import { useApp } from '../src/store'
import type { MediaItem, ProjectSettings, Sequence } from '../src/types'

const win = window as unknown as {
  __PROJECT__?: { media?: MediaItem[]; sequences?: Sequence[]; activeSeqId?: string; settings?: ProjectSettings }
  __FRAME__?: { at: number; edge: number }
  __FRAME_RESULT__?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const proj = win.__PROJECT__
  const spec = win.__FRAME__ ?? { at: 0, edge: 960 }
  if (!proj?.sequences?.length) throw new Error('工程没有 sequence')

  useApp.setState({
    started: true,
    media: proj.media ?? [],
    folders: [],
    sequences: proj.sequences,
    activeSeqId: proj.activeSeqId || proj.sequences[0].id,
    settings: { ...useApp.getState().settings, ...(proj.settings ?? {}) },
  })

  const st = useApp.getState()
  const seq = st.seq()
  const media = st.media
  // 目标边长自己算：getPreviewSize 只按性能档位给比例，渲单帧要能指定分辨率
  const full = getPreviewSize(st.settings, 'quality')
  const scale = spec.edge > 0 ? spec.edge / Math.max(1, Math.max(full.w, full.h)) : 1
  const w = Math.max(320, Math.round(full.w * scale))
  const h = Math.max(180, Math.round(full.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false })!

  // 预热图片：不预热会渲出空帧（解码是异步的）
  const imgCache = new Map<string, HTMLImageElement>()
  const warmStart = performance.now()
  await Promise.all(media.filter((m) => m.kind === 'image' || m.kind === 'sticker').map((m) => new Promise<void>((done) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { imgCache.set(m.id, img); done() }
    img.onerror = () => done()
    img.src = m.url
  })))
  const warmMs = Math.round(performance.now() - warmStart)

  const active = pictureClipsAt(seq, spec.at)
  const first = performance.now()
  renderProgramFrame(canvas, seq, media, st.settings, spec.at, imgCache, w, h, [], undefined, false, undefined, true)
  const firstMs = performance.now() - first
  await sleep(260) // 让视频槽有机会出帧
  const second = performance.now()
  renderProgramFrame(canvas, seq, media, st.settings, spec.at, imgCache, w, h, [], undefined, false, undefined, true)
  const secondMs = performance.now() - second

  const url = canvas.toDataURL('image/png')
  const b64 = url.slice(url.indexOf(',') + 1)

  // 自己先量一下：空白帧（全黑/全透明）要能被机器判出来，而不是靠人眼看
  const probe = ctx.getImageData(0, 0, w, h).data
  let sum = 0
  let nonBlack = 0
  for (let i = 0; i < probe.length; i += 4) {
    const l = (probe[i] + probe[i + 1] + probe[i + 2]) / 3
    sum += l
    if (l > 8) nonBlack += 1
  }
  const pixels = w * h

  win.__FRAME_RESULT__ = {
    ok: true,
    at: spec.at,
    width: w,
    height: h,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    warmMs, firstMs: Math.round(firstMs), secondMs: Math.round(secondMs),
    activeClips: active.length,
    activeNames: active.map((c) => String(c.name ?? '').slice(0, 14)),
    meanLuma: +(sum / pixels).toFixed(2),
    nonBlackPct: +((nonBlack / pixels) * 100).toFixed(2),
    pngBase64: b64,
    pngBytes: Math.floor((b64.length * 3) / 4),
  }
}

void main().catch((e) => {
  win.__FRAME_RESULT__ = { ok: false, error: String(e && e.stack ? e.stack : e) }
})
