/**
 * 「粉笔手书写」入场动画（动效模块）：开关记在元素书写片段自己身上（meta.source.chalk.on / scale），
 * 时间轴上不多出片段；手由 chalkHandLayers 在预览 / 导出渲染时按笔尖轨迹现画。
 */
import { useApp } from '../store'
import type { ChalkStroke, Clip, Transform2D } from '../types'
import { isSameAiMedia } from './aiJobImport'
import { isRemovedGenerated } from './mediaManagement'

export { elementTransform } from './chalkHandLayers'

export const CHALK_HAND_PRESET_ID = 'chalkHand'

export const CHALK_ENTER_LABEL: Record<string, string> = { draw: '书写', stamp: '盖章', fade: '显现' }

export function chalkEnterLabel(enter?: string) {
  return CHALK_ENTER_LABEL[enter || ''] || '书写'
}

function ensureHandMedia(chalk: ChalkStroke, folderId?: string) {
  const st = useApp.getState()
  if(isRemovedGenerated(chalk.hand.url,st.settings.removedGeneratedMedia))return null
  if (chalk.hand.mediaId && st.media.some((m) => m.id === chalk.hand.mediaId)) return chalk.hand.mediaId
  const hit = st.media.find((m) => isSameAiMedia(m, chalk.hand.url))
  if (hit) return hit.id
  return st.importMedia([{
    name: '粉笔手.png', url: chalk.hand.url, kind: 'image', duration: 5,
    width: chalk.hand.width, height: chalk.hand.height, hasAudio: false, folderId,
  }], { silent: true })[0] ?? null
}

export const canChalkHand = (c: Clip) => !!c.meta?.source?.chalk
export const hasChalkHand = (c: Clip) => !!c.meta?.source?.chalk?.on

function withChalk(c: Clip, chalk: ChalkStroke): Partial<Clip> {
  return { meta: { ...c.meta!, source: { ...c.meta!.source!, chalk } } }
}

/** 给元素书写片段开 / 关粉笔手。返回改动的个数 */
export function setChalkHand(clipIds: string[], on: boolean, opts: { scale?: number; history?: boolean } = {}) {
  const st = useApp.getState()
  const targets = st.seq().clips.filter((c) => clipIds.includes(c.id) && canChalkHand(c))
  if (!targets.length) return 0
  if (opts.history !== false) st.pushHistory()
  const patches: Record<string, Partial<Clip>> = {}
  for (const c of targets) {
    const chalk = c.meta!.source!.chalk!
    const folderId = st.media.find((m) => m.id === c.mediaId)?.folderId
    const mediaId = on ? ensureHandMedia(chalk, folderId) : chalk.hand.mediaId
    patches[c.id] = withChalk(c, { ...chalk, on: on && !!mediaId, scale: opts.scale ?? chalk.scale ?? 1, hand: { ...chalk.hand, mediaId: mediaId ?? undefined } })
  }
  useApp.getState().patchClipsQuiet(patches)
  return targets.length
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

/** 早先版本把手放成了单独的片段：删掉它，改成元素自己的入场动画 */
function migrateHandClips(clips: Clip[], patches: Record<string, Partial<Clip> | null>) {
  for (const h of clips) {
    const elemId = h.meta?.source?.handFor
    if (!elemId) continue
    patches[h.id] = null
    const elem = clips.find((c) => c.id === elemId)
    const chalk = elem?.meta?.source?.chalk
    if (elem && chalk) patches[elem.id] = withChalk(elem, { ...chalk, on: true, scale: h.meta?.source?.handScale ?? 1, hand: { ...chalk.hand, mediaId: h.mediaId } })
  }
}

export function startChalkHandFollow() {
  const pairSigs = new Map<string, string>()
  let busy = false
  const run = () => {
    const patches: Record<string, Partial<Clip> | null> = {}
    const clips = useApp.getState().seq().clips
    migrateHandClips(clips, patches)
    pairPatches(clips, pairSigs, patches)
    if (!Object.keys(patches).length) return
    busy = true
    try { useApp.getState().patchClipsQuiet(patches) } finally { busy = false }
  }
  run()
  return useApp.subscribe((s, prev) => {
    if (busy || s.sequences === prev.sequences) return
    run()
  })
}
