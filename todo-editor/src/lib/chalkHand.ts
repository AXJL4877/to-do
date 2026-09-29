/**
 * 「粉笔手书写」入场动画：给粉笔元素的书写片段在上层配一段粉笔手图片片段，
 * 位置关键帧沿渲染端记下的笔尖轨迹走。元素片段被挪动 / 缩放 / 改时间后自动重算，所以随意排版手都跟得上。
 */
import { useApp } from '../store'
import { uid, type ChalkStroke, type Clip, type Keyframe, type Transform2D } from '../types'
import { resolveClipTransform } from './keyframeEval'
import { isSameAiMedia } from './aiJobImport'

export const CHALK_HAND_PRESET_ID = 'chalkHand'
/** 手在所有粉笔层之上 */
const HAND_LANE = -1

type Size = { width: number; height: number }

/** 生成画幅 → 工程画面：等比放进去居中 */
function frameMap(frame: Size, proj: Size) {
  const k = Math.min(proj.width / frame.width, proj.height / frame.height)
  return { k, ox: (proj.width - frame.width * k) / 2, oy: (proj.height - frame.height * k) / 2 }
}

const fitOf = (w: number, h: number, proj: Size) => Math.min(proj.width / w, proj.height / h)

/** 裁好的元素素材放回它在生成画面里的位置和大小（片段默认是等比铺满画面居中） */
export function elementTransform(crop: number[], frame: Size, proj: Size): Partial<Transform2D> {
  const [x, y, w, h] = crop
  const { k, ox, oy } = frameMap(frame, proj)
  const s = k / fitOf(w, h, proj)
  const cx = ox + (x + w / 2) * k
  const cy = oy + (y + h / 2) * k
  return { x: (cx - proj.width / 2) / (proj.width / 2), y: (cy - proj.height / 2) / (proj.height / 2), scaleX: s, scaleY: s }
}

/** 按元素片段当前的时间和变换算手的片段：时间为时间线绝对秒，关键帧为片段内时间 */
export function handTrack(elem: Clip, chalk: ChalkStroke, mediaSize: Size, proj: Size, fps: number, scale = 1) {
  const speed = elem.speed || 1
  const inP = elem.inPoint
  const tip = chalk.tip.filter(([t]) => t >= inP - 1e-3 && (t - inP) / speed <= elem.duration + 1e-3)
  if (!tip.length) return null
  const t0 = tip[0][0]
  const { k } = frameMap(chalk.frame, proj)
  const hand = chalk.hand
  const hw = hand.width * k * scale
  const hh = hand.height * k * scale
  const hs = (k * scale) / fitOf(hand.width, hand.height, proj)
  const fitE = fitOf(mediaSize.width, mediaSize.height, proj)
  const xs: Keyframe[] = []
  const ys: Keyframe[] = []
  for (const [t, u, v] of tip) {
    const at = elem.start + (t - inP) / speed
    const tr = resolveClipTransform(elem, at)
    const dw = mediaSize.width * fitE * Math.abs(tr.scaleX)
    const dh = mediaSize.height * fitE * Math.abs(tr.scaleY)
    const px = proj.width / 2 + tr.x * proj.width / 2 + (u - 0.5) * dw
    const py = proj.height / 2 + tr.y * proj.height / 2 + (v - 0.5) * dh
    const cx = px + (0.5 - hand.tipX) * hw
    const cy = py + (0.5 - hand.tipY) * hh
    const lt = (t - t0) / speed
    xs.push({ id: uid('kf'), t: lt, value: (cx - proj.width / 2) / (proj.width / 2), ease: 'linear' })
    ys.push({ id: uid('kf'), t: lt, value: (cy - proj.height / 2) / (proj.height / 2), ease: 'linear' })
  }
  const duration = Math.max(1 / fps, xs[xs.length - 1].t + 1 / fps)
  return {
    start: elem.start + (t0 - inP) / speed,
    duration,
    transform: { x: xs[0].value, y: ys[0].value, scaleX: hs, scaleY: hs } as Partial<Transform2D>,
    keyframes: { x: xs, y: ys } as Clip['keyframes'],
  }
}

const projSize = (): Size => {
  const s = useApp.getState().settings
  return { width: s.width, height: s.height }
}

function mediaSizeOf(clip: Clip): Size | null {
  const m = useApp.getState().media.find((x) => x.id === clip.mediaId)
  return m?.width && m.height ? { width: m.width, height: m.height } : null
}

function ensureHandMedia(chalk: ChalkStroke, folderId?: string) {
  const st = useApp.getState()
  const hit = st.media.find((m) => isSameAiMedia(m, chalk.hand.url))
  if (hit) return hit.id
  return st.importMedia([{
    name: '粉笔手.png', url: chalk.hand.url, kind: 'image', duration: 5,
    width: chalk.hand.width, height: chalk.hand.height, hasAudio: false, folderId,
  }], { silent: true })[0] ?? null
}

export const canChalkHand = (c: Clip) => !!c.meta?.source?.chalk

/** 给元素片段套粉笔手（已有的先换掉）。返回套上的个数 */
export function applyChalkHand(clipIds: string[], opts: { scale?: number; history?: boolean } = {}) {
  const st = useApp.getState()
  const seq = st.seq()
  const targets = seq.clips.filter((c) => clipIds.includes(c.id) && canChalkHand(c))
  if (!targets.length) return 0
  if (opts.history !== false) st.pushHistory()
  const old = seq.clips.filter((c) => c.meta?.source?.handFor && targets.some((t) => t.id === c.meta!.source!.handFor))
  if (old.length) st.patchClipsQuiet(Object.fromEntries(old.map((c) => [c.id, null])))
  const fps = st.settings.fps
  let n = 0
  for (const elem of targets) {
    const chalk = elem.meta!.source!.chalk!
    const size = mediaSizeOf(elem)
    const folderId = st.media.find((m) => m.id === elem.mediaId)?.folderId
    const mediaId = size ? ensureHandMedia(chalk, folderId) : null
    const track = size && handTrack(elem, chalk, size, projSize(), fps, opts.scale ?? 1)
    if (!mediaId || !track) continue
    const src = elem.meta!.source!
    useApp.getState().addAiLayerClips([{
      mediaId, start: track.start, duration: track.duration, lane: HAND_LANE, name: `${elem.name.replace(/ · 书写$/, '')} · 粉笔手`,
      transform: track.transform, keyframes: track.keyframes,
      source: { key: src.key ? `${src.key}/hand` : undefined, handFor: elem.id, handScale: opts.scale ?? 1 },
    }], { jobId: src.jobId ?? 'chalk', kind: 'chalk-hand', history: false })
    n++
  }
  return n
}

const layoutSig = (t: Transform2D) => [t.x, t.y, t.scaleX, t.scaleY, t.rotation, t.flipH, t.flipV].join(',')

/** 同一元素的书写片段和定格片段是一个整体：挪 / 缩放其中一段，另一段跟着改 */
function pairPatches(clips: Clip[], sigs: Map<string, string>, patches: Record<string, Partial<Clip> | null>) {
  const byKey = new Map<string, Clip>()
  for (const c of clips) {
    const src = c.meta?.source
    if (src?.jobId && src.key && /\/(draw|hold)$/.test(src.key)) byKey.set(`${src.jobId}|${src.key}`, c)
  }
  for (const [k, draw] of byKey) {
    if (!k.endsWith('/draw')) continue
    const hold = byKey.get(k.replace(/\/draw$/, '/hold'))
    if (!hold) continue
    const d = layoutSig(draw.transform), h = layoutSig(hold.transform)
    const was = sigs.get(k)
    sigs.set(k, d === h ? d : (was === d ? h : d))
    if (d === h || was == null) continue
    const layout = (t: Transform2D) => ({ x: t.x, y: t.y, scaleX: t.scaleX, scaleY: t.scaleY, rotation: t.rotation, flipH: t.flipH, flipV: t.flipV })
    if (was === d) patches[draw.id] = { transform: { ...draw.transform, ...layout(hold.transform) } }
    else patches[hold.id] = { transform: { ...hold.transform, ...layout(draw.transform) } }
  }
}

/** 元素片段的时间、位置、大小或关键帧一变就重算它的手；元素删了手也删掉 */
export function startChalkHandFollow() {
  const sigs = new Map<string, string>()
  const pairSigs = new Map<string, string>()
  let busy = false
  const sigOf = (e: Clip) => JSON.stringify([
    e.start, e.inPoint, e.duration, e.speed, e.transform.x, e.transform.y, e.transform.scaleX, e.transform.scaleY,
    e.keyframes.x, e.keyframes.y, e.keyframes.scaleX, e.keyframes.scaleY, useApp.getState().settings.width, useApp.getState().settings.height,
  ])
  return useApp.subscribe((s, prev) => {
    if (busy || (s.sequences === prev.sequences && s.settings === prev.settings)) return
    const patches: Record<string, Partial<Clip> | null> = {}
    pairPatches(s.seq().clips, pairSigs, patches)
    // 手按两段同步之后的元素位置算
    const clips = s.seq().clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c))
    const hands = clips.filter((c) => c.meta?.source?.handFor)
    for (const h of hands) {
      const elem = clips.find((c) => c.id === h.meta!.source!.handFor)
      if (!elem) { patches[h.id] = null; sigs.delete(h.id); continue }
      const sig = sigOf(elem)
      const was = sigs.get(h.id)
      sigs.set(h.id, sig)
      if (was == null || was === sig) continue
      const size = mediaSizeOf(elem)
      const track = size && canChalkHand(elem)
        ? handTrack(elem, elem.meta!.source!.chalk!, size, projSize(), s.settings.fps, h.meta?.source?.handScale ?? 1)
        : null
      patches[h.id] = track
        ? { start: track.start, duration: track.duration, outPoint: track.duration, transform: { ...h.transform, ...track.transform }, keyframes: track.keyframes }
        : null
    }
    if (!Object.keys(patches).length) return
    busy = true
    try { useApp.getState().patchClipsQuiet(patches) } finally { busy = false }
  })
}
