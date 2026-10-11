/**
 * 成片的合成层：把成片文档对到时间轴上（幂等，每次全量对账）。
 *
 * 每个产物一个键，片段上记着键和版本（source.key / source.rev，版本 = 生成层的输入指纹）：
 *   `${段}/voice`              配音（音频第 1 层）
 *   `${段}/${元素}/draw|hold`  元素书写片段 + 定格图（画面第 k 层 = 元素在镜头里的序号）
 *   `${段}/subs`               这一段的字幕条（字幕轨，链接配音）
 *   `plate`                    整片底板（最底层）
 * 对账规则：
 *   - 版本没变：不动（用户怎么剪都保留）
 *   - 版本变了：原位换成新产物；用户挪过 / 缩放过的元素保留用户的位置
 *   - 时间轴上没有、记录里版本也没变：是用户删的，不放回；版本变了（重新生成过）才再放
 *   - 文档里没有了的键（删掉的段 / 重拆分镜后的旧元素）：片段删掉
 *   - 段与段首尾相接：按各段配音片段现在的位置排，配音变长 / 变短、中间插了新段时，后面的段整体顺移（保留用户留的空隙）
 */
import { appendGroupSlot, useApp } from '../store'
import { defaultAudio, defaultText, type ChalkStroke, type Clip, type MediaItem, type ProductionPlacement, type Transform2D } from '../types'
import { aiUrl } from './aiFetch'
import { isSameAiMedia } from './aiJobImport'
import { subtitleClipStyle, type TimelinePlacement } from './aiSkills'
import { chalkEnterLabel, elementTransform, setChalkHand } from './chalkHand'
import { getProduction, listProductions, type Production, type ProductionSegment } from './production'
import { isStoreAuthority } from './storeSync'
import { isRemovedGenerated } from './mediaManagement'

const VOICE_LANE = 0
const BGM_LANE = 1
/** 元素自带音效（泡泡转场原声等）：独立音轨，便于单独调音量/取舍 */
const SFX_LANE = 2
/** 成片整片轨：仅 params.filmOnly=true 时铺；默认走逐镜分层 */
const FILM_LANE = 50
const PLATE_LANE = 99
const EPS = 1e-3
const pathExt = (f: string) => {
  const m = String(f || '').match(/\.[a-z0-9]+$/i)
  return m ? m[0] : '.wav'
}

type AddItem = Parameters<ReturnType<typeof useApp.getState>['addAiLayerClips']>[0][number]

const layoutSig = (t: Partial<Transform2D>) => [t.x ?? 0, t.y ?? 0, t.scaleX ?? 1, t.scaleY ?? 1, t.rotation ?? 0].map((v) => Math.round(Number(v) * 1e4) / 1e4).join(',')

/** 新建成片时登记入轨记录：整片从哪开始（按提交时选的位置，和其它 AI 任务一致） */
export function registerProduction(id: string, o: { auto: boolean; placement: TimelinePlacement; placeAt: number; estimate: number }) {
  const st = useApp.getState()
  const slot = appendGroupSlot(st.seq(), { audio: 1, video: 4 }, o.placeAt, Math.max(1, o.estimate), o.placement)
  const rec: ProductionPlacement = { t0: slot.start, auto: o.auto, placed: {}, createdAt: Date.now() }
  useApp.setState({ settings: { ...st.settings, aiProductions: { ...st.settings.aiProductions, [id]: rec } } })
  void st.flushProject()
}

export function setProductionAuto(id: string, auto: boolean) {
  const st = useApp.getState()
  const rec = st.settings.aiProductions?.[id]
  if (!rec) return
  useApp.setState({ settings: { ...st.settings, aiProductions: { ...st.settings.aiProductions, [id]: { ...rec, auto } } } })
}

export function forgetProduction(id: string) {
  const st = useApp.getState()
  const next = { ...st.settings.aiProductions }
  delete next[id]
  useApp.setState({ settings: { ...st.settings, aiProductions: next } })
}

function folderFor(p: Production) {
  const id = `f_ai_${p.id}`
  const st = useApp.getState()
  const name = `成片 ${p.title || p.id.slice(-4)}`
  const hit = st.folders.find((f) => f.id === id)
  if (!hit) useApp.setState({ folders: [...st.folders, { id, name, parentId: null }] })
  else if (hit.name !== name) useApp.setState({ folders: st.folders.map((f) => (f.id === id ? { ...f, name } : f)) })
  return id
}

function ensureMedia(item: {
  name: string
  url: string
  kind: MediaItem['kind']
  duration: number
  width?: number
  height?: number
  alpha?: boolean
  chromaKey?: MediaItem['chromaKey']
}, folderId: string) {
  if(isRemovedGenerated(item.url,useApp.getState().settings.removedGeneratedMedia))return null
  const hit = useApp.getState().media.find((m) => isSameAiMedia(m, item.url))
  if (hit) {
    const patch: Partial<MediaItem> = {}
    if (item.alpha && !hit.alpha) patch.alpha = true
    if (item.chromaKey && hit.chromaKey !== item.chromaKey) patch.chromaKey = item.chromaKey
    if (Object.keys(patch).length) {
      useApp.setState({
        media: useApp.getState().media.map((m) => (m.id === hit.id ? { ...m, ...patch } : m)),
      })
    }
    return hit.id
  }
  return useApp.getState().importMedia([{ ...item, hasAudio: item.kind === 'audio', folderId }], { silent: true })[0] ?? null
}

const segOfKey = (key: string) => (key === 'plate' ? null : key.split('/')[0])

/**
 * 素材元数据修复：满幅近黑转场（chromaKey=nearblack）早先导入时被丢掉标记，
 * 之后 `same` 短路又不会回头调 ensureMedia，于是它一直被当不透明黑层 → 预览黑屏。
 * 这里按成片文档把标记补回已存在的素材（幂等，不动其它字段）。
 */
function reconcileLayerKeyMeta(p: Production): boolean {
  const want = new Map<string, MediaItem['chromaKey']>()
  for (const seg of p.segments) {
    for (const b of seg.boards || []) {
      for (const e of b.render?.result?.elements || []) {
        const ck = (e as { chromaKey?: MediaItem['chromaKey'] }).chromaKey
        if (ck && e.video) want.set(aiUrl(e.video), ck)
      }
    }
  }
  if (!want.size) return false
  let changed = false
  const media = useApp.getState().media.map((m) => {
    if (m.chromaKey) return m
    for (const [url, ck] of want) {
      if (!isSameAiMedia(m, url)) continue
      changed = true
      return { ...m, chromaKey: ck }
    }
    return m
  })
  if (changed) useApp.setState({ media })
  return changed
}

/** 本段的配音时间（秒）→ 时间线：按配音片段的速度换算 */
type SegMap = { zero: number; speed: number }
const toTimeline = (m: SegMap, sec: number) => m.zero + sec / m.speed

/**
 * 对账一次。返回是否改动了时间轴。
 * 不自动入轨的成片什么都不做（素材在成片面板里按需取用）。
 */
export function syncProduction(p: Production): boolean {
  if (!isStoreAuthority() || !useApp.getState().started) return false
  const rec = useApp.getState().settings.aiProductions?.[p.id]
  if (!rec?.auto) return false

  const seq = useApp.getState().seq()
  const mine = seq.clips.filter((c) => c.meta?.source?.jobId === p.id && c.meta.source.key)
  const byKey = new Map<string, Clip[]>()
  for (const c of mine) byKey.set(c.meta!.source!.key!, [...(byKey.get(c.meta!.source!.key!) ?? []), c])
  const placed = { ...rec.placed }
  const patches: Record<string, Partial<Clip> | null> = {}
  const shifted = new Set<string>()
  const wanted = new Set<string>()
  const folderId = folderFor(p)
  const label = p.title || '成片'
  const opts = { jobId: p.id, kind: 'production', history: false }
  const [fw, fh] = String(p.params.size || '1920x1080').split('x').map(Number)
  const frame = { width: fw || 1920, height: fh || 1080 }
  const proj = { width: useApp.getState().settings.width, height: useApp.getState().settings.height }
  const projFps = Math.max(1, useApp.getState().settings.fps || 30)
  const snap = (t: number) => Math.round(t * projFps) / projFps
  const wantHand = p.params.hand !== 'none'
  let changed = false
  // 老工程：把被丢过的 chromaKey 补回素材，否则满幅转场预览是黑屏
  if (reconcileLayerKeyMeta(p)) changed = true

  // 1. 段落排布：配音片段现在的位置是准的；配音换了 / 新插的段让后面整体顺移
  const maps = new Map<string, SegMap>()
  const voiceIds = new Map<string, string>()
  let cursor = rec.t0
  let ripple = 0
  const lastVoiced = [...p.segments].reverse().find((s) => s.voice)
  // 删掉的段：它的配音让出的时长，后面的段往前收
  const live = new Set(p.segments.map((s) => `${s.id}/voice`))
  const removed = mine.filter((c) => c.meta!.source!.key!.endsWith('/voice') && !live.has(c.meta!.source!.key!)).sort((a, b) => a.start - b.start)
  let ri = 0
  for (const seg of p.segments) {
    const v = seg.voice
    if (!v) continue
    const key = `${seg.id}/voice`
    wanted.add(key)
    const vc = byKey.get(key)?.[0]
    const speed = vc?.speed || 1
    let zero: number
    let end: number
    if (vc) {
      const oldZero = vc.start - vc.inPoint / speed
      while (ri < removed.length && removed[ri].start < oldZero) ripple -= removed[ri++].duration
      zero = oldZero + ripple
      if (zero < cursor - EPS) zero = cursor
      const shift = zero - oldZero
      if (Math.abs(shift) > EPS) shiftSegment(seg.id, shift)
      if (vc.meta!.source!.rev !== v.hash) {
        // 新配音原位替换：从本段 0 秒开始放满
        const media = ensureMedia({ name: `${label}_${seg.title || seg.id}_配音.wav`, url: aiUrl(v.audioUrl), kind: 'audio', duration: v.duration }, folderId)
        if (media) {
          const oldEnd = vc.start + shift + vc.duration
          const dur = v.duration / speed
          patches[vc.id] = {
            ...patches[vc.id], mediaId: media, start: zero, inPoint: 0, outPoint: v.duration, duration: dur,
            meta: { ...vc.meta!, source: { ...vc.meta!.source!, rev: v.hash } },
          }
          placed[key] = v.hash
          ripple += zero + dur - oldEnd
          end = zero + dur
          changed = true
        } else end = vc.start + shift + vc.duration
      } else end = vc.start + shift + vc.duration
    } else {
      zero = cursor
      end = zero + v.duration
      if (placed[key] !== v.hash) {
        const media = ensureMedia({ name: `${label}_${seg.title || seg.id}_配音.wav`, url: aiUrl(v.audioUrl), kind: 'audio', duration: v.duration }, folderId)
        if (media) {
          const [id] = useApp.getState().addAiLayerClips([{ mediaId: media, start: zero, duration: v.duration, lane: VOICE_LANE, name: `${seg.title || '口播'} · 配音`, source: { key, rev: v.hash } }], opts)
          if (id) { voiceIds.set(seg.id, id); changed = true }
          placed[key] = v.hash
          // 中间插进来的段：后面的段让出位置
          ripple += v.duration
        }
      }
    }
    if (vc) voiceIds.set(seg.id, vc.id)
    maps.set(seg.id, { zero, speed })
    cursor = Math.max(cursor, end)
    if (seg === lastVoiced) cursor += Number(p.params.tail) || 0

    // BGM：原管线 bgm_plan 三段（intro→mid→outro）；无计划时回退整段 bed
    type BgmSeg = {
      id: string; file: string; hash: string; start: number; end: number
      duration: number; volume?: number; trim_start?: number; trim_dur?: number | null
    }
    const plan = (p as Production & {
      sourceBgmPlan?: { hash: string; segments: BgmSeg[] }
      sourceBgm?: { file: string; hash: string; duration: number }
    }).sourceBgmPlan
    const bgmSegs: BgmSeg[] = plan?.segments?.length
      ? plan.segments
      : (() => {
          const bed = (p as Production & { sourceBgm?: { file: string; hash: string; duration: number } }).sourceBgm
          return bed?.file && bed.hash
            ? [{ id: 'bed', file: bed.file, hash: bed.hash, start: 0, end: bed.duration || v.duration, duration: bed.duration || v.duration }]
            : []
        })()
    for (const bs of bgmSegs) {
      const bkey = `${seg.id}/bgm/${bs.id}`
      wanted.add(bkey)
      const oldB = byKey.get(bkey)?.[0]
      const span = Math.max(0.2, Number(bs.duration) || (Number(bs.end) - Number(bs.start)) || v.duration)
      const bMedia = ensureMedia({
        name: `${label}_${seg.title || seg.id}_BGM_${bs.id}${pathExt(bs.file)}`,
        url: aiUrl(`/ai-generated/${bs.file}`),
        kind: 'audio',
        duration: span + (Number(bs.trim_start) || 0) + 1,
      }, folderId)
      if (!bMedia) continue
      const clipStart = zero + (Number(bs.start) || 0) / speed
      const clipDur = span / speed
      const inPoint = Number(bs.trim_start) || 0
      const outPoint = inPoint + span
      const rev = bs.hash || plan?.hash || bs.file
      const vol = typeof bs.volume === 'number' ? bs.volume : undefined
      // 宿主音量模型是 gainDb（dB）；bgm_plan 给的是线性 volume，换算后才是真正生效的值
      const volDb = vol == null ? undefined : Math.max(-60, Math.min(18, 20 * Math.log10(Math.max(vol, 1e-3))))
      if (oldB) {
        if (oldB.meta?.source?.rev !== rev) {
          patches[oldB.id] = {
            ...patches[oldB.id],
            mediaId: bMedia,
            start: clipStart,
            duration: clipDur,
            inPoint,
            outPoint,
            ...(volDb != null ? { audio: { ...defaultAudio(), gainDb: volDb } } : {}),
            meta: { ...oldB.meta!, source: { ...oldB.meta!.source!, rev } },
          }
          placed[bkey] = rev
          changed = true
        }
      } else if (placed[bkey] !== rev) {
        const [cid] = useApp.getState().addAiLayerClips([{
          mediaId: bMedia,
          start: clipStart,
          duration: clipDur,
          inPoint,
          outPoint,
          lane: BGM_LANE,
          name: `${seg.title || '口播'} · BGM·${bs.id}`,
          source: { key: bkey, rev },
        }], { ...opts, linkTo: voiceIds.get(seg.id) })
        if (cid && volDb != null) {
          useApp.getState().patchClipsQuiet({
            [cid]: { audio: { ...defaultAudio(), gainDb: volDb } },
          })
        }
        placed[bkey] = rev
        changed = true
      }
    }
    // 旧整段 `${seg}/bgm` 不进 wanted → 对账时删掉，改由 /bgm/intro|mid|outro
  }

  function shiftSegment(segId: string, by: number) {
    for (const [key, clips] of byKey) {
      if (segOfKey(key) !== segId) continue
      for (const c of clips) {
        if (shifted.has(c.id)) continue
        shifted.add(c.id)
        patches[c.id] = { ...patches[c.id], start: Math.max(0, c.start + by) }
      }
    }
    changed = true
  }
  const startOf = (c: Clip) => (patches[c.id]?.start as number | undefined) ?? c.start

  // 2. 画面：原管线渐进——按镜头 boards 逐镜铺（intro_red → scene/card/…）；
  //    仅 params.filmOnly=true 时整片盖轨（对照用，离开可编辑分层）
  const addLater: { items: AddItem[]; linkTo?: string }[] = []
  const handOn: string[] = []
  const entrances: { holdKey: string; t1: number; tail: number; draw: AddItem; linkTo?: string; hand: boolean }[] = []
  const filmOnly = String((p.params as { filmOnly?: string } | undefined)?.filmOnly || '') === 'true'
  const filmMeta = (p as Production & { sourceFilm?: { file: string; hash?: string; duration?: number; width?: number; height?: number; hold?: string } }).sourceFilm
  const hasLayerBoards = p.segments.some((s) =>
    s.boards?.some((b) => b.render?.result?.layout === 'source-layers' || (b.render?.result?.elements?.length || 0) > 0),
  )

  for (const seg of p.segments) {
    const m = maps.get(seg.id)
    if (!m || !seg.voice) continue
    const isLast = seg === lastVoiced
    const items: AddItem[] = []

    // filmOnly：整片静音成片；默认仍走下方逐镜分层
    if (filmOnly && filmMeta?.file && !hasLayerBoards) {
      const fkey = `${seg.id}/film`
      wanted.add(fkey)
      const rev = filmMeta.hash || filmMeta.file
      const oldF = byKey.get(fkey)?.[0]
      const dur = Number(filmMeta.duration || seg.voice.duration) || seg.voice.duration
      if (oldF?.meta?.source?.rev !== rev && placed[fkey] !== rev) {
        if (oldF) patches[oldF.id] = null
        const media = ensureMedia({
          name: `${label}_${seg.title || seg.id}_成片.mp4`,
          url: aiUrl(`/ai-generated/${filmMeta.file}`),
          kind: 'video',
          duration: dur,
          width: filmMeta.width || frame.width,
          height: filmMeta.height || frame.height,
        }, folderId)
        if (media) {
          const [cid] = useApp.getState().addAiLayerClips([{
            mediaId: media,
            start: m.zero,
            duration: dur / m.speed,
            lane: FILM_LANE,
            name: `${seg.title || '口播'} · 成片`,
            source: { key: fkey, rev },
          }], { ...opts, linkTo: voiceIds.get(seg.id) })
          if (cid) {
            useApp.getState().patchClipsQuiet({
              [cid]: { audio: { ...defaultAudio(), mute: true } },
            })
          }
          placed[fkey] = rev
          changed = true
        }
      }
      continue
    }

    for (const [k, b] of seg.boards.entries()) {
      const r = b.render?.result
      if (!r || !b.render) continue
      const fps = r.fps || 30
      const boardEnd = r.endMs / 1000
      if (r.dynamicText) {
        const key = `${seg.id}/${b.id}/text`
        const rev = b.render.hash
        wanted.add(key)
        const old = byKey.get(key)?.[0]
        if (old?.meta?.source?.rev === rev || (!old && placed[key] === rev)) continue
        const start = snap(toTimeline(m, r.startMs / 1000))
        const end = snap(toTimeline(m, boardEnd))
        if (old) patches[old.id] = null
        items.push({ text: { ...defaultText(), ...r.dynamicText, animIn: 'none', animOut: 'none' }, start,
          duration: Math.max(1 / projFps, end - start), lane: 1, name: r.dynamicText.content,
          transform: old?.transform, keyframes: old?.keyframes, source: { key, rev } })
        placed[key] = rev
        continue
      }
      for (const [j, e] of r.elements.entries()) {
        const el = b.elements.find((x) => x.id === e.id)
        const name = el?.label || e.label || e.id
        const dk = `${seg.id}/${e.id}/draw`
        const hk = `${seg.id}/${e.id}/hold`
        wanted.add(dk)
        wanted.add(hk)
        const rev = b.render.hash
        const oldDraw = byKey.get(dk)?.[0]
        const oldHold = byKey.get(hk)?.[0]
        const same = oldDraw?.meta?.source?.rev === rev || oldHold?.meta?.source?.rev === rev
        if (same) continue
        const present = !!(oldDraw || oldHold)
        if (!present && placed[dk] === rev) continue
        const t0 = snap(toTimeline(m, e.startMs / 1000))
        // boardEnd 已是秒；优先用元素 durationMs（开场分段/泡泡转场）
        const elEndSec = Number(e.durationMs) > 0
          ? (Number(e.startMs) + Number(e.durationMs)) / 1000
          : boardEnd
        const boardCap = isLast && k === seg.boards.length - 1
          ? Math.max(boardEnd, seg.voice.duration + (Number(p.params.tail) || 0))
          : boardEnd
        const t2 = snap(toTimeline(m, Math.max(e.startMs / 1000 + 1 / projFps, Math.min(elEndSec, boardCap))))
        const t1 = Math.max(t0 + 1 / projFps, Math.min(t2, snap(t0 + Math.max(1, e.frames - 1) / fps / m.speed)))
        const size = e.crop ? { width: e.crop[2], height: e.crop[3] } : frame
        const motion = chalkEnterLabel(e.enter)
        // 只有显式 cut 才跳过入场片直接铺定格；缺字段是旧产物，按手写（与 narratedTimeline / production.ts 一致）
        const cutEnter = e.enter === 'cut'
        // play/wipe：整段播 webm（泡泡遮罩转场），不是定格 PNG
        const playEnter = e.enter === 'play' || e.enter === 'wipe'
        // hold PNG 必须带 alpha，否则红字/角色透明区变黑底，预览只剩沙滩
        const still = ensureMedia({ name: `${seg.title || seg.id}_${k + 1}_${name}.png`, url: aiUrl(e.hold), kind: 'image', duration: Math.max(1, t2 - t0), ...size, alpha: true }, folderId)
        // 用户挪过 / 缩放过这个元素：新产物沿用用户的位置
        const auto = e.crop ? elementTransform(e.crop, frame, proj) : undefined
        const prev = oldDraw ?? oldHold
        const userMoved = prev && prev.meta?.source?.layout != null && layoutSig(prev.transform) !== prev.meta.source.layout
        const transform = userMoved ? { ...prev!.transform } : auto
        const layout = layoutSig(transform ?? {})
        const chalk: ChalkStroke | undefined = (!e.enter || e.enter === 'draw') && p.hand && e.tip?.length
          ? { tip: e.tip, frame, hand: { url: aiUrl(p.hand.url), width: p.hand.width, height: p.hand.height, tipX: p.hand.tipX, tipY: p.hand.tipY } }
          : undefined
        const keepHand = oldDraw?.meta?.source?.chalk ? !!oldDraw.meta.source.chalk.on : wantHand
        // elements[0] 是底板（背景）→ 高 lane → 时间轴靠下 → 合成在下；末元素在最上
        const lane = Math.max(1, r.elements.length - j)
        if (oldDraw) patches[oldDraw.id] = null
        if (oldHold) patches[oldHold.id] = null
        const videoDur = Math.max(1 / projFps, (Number(e.frames) || 8) / fps / m.speed)
        const chromaKey = (e as { chromaKey?: MediaItem['chromaKey'] }).chromaKey
        const video = ensureMedia({
          name: `${seg.title || seg.id}_${k + 1}_${name}_${motion}${pathExt(String(e.video))}`,
          url: aiUrl(e.video),
          kind: 'video',
          duration: playEnter ? Math.max(videoDur, t2 - t0) : videoDur,
          ...size,
          // H.264 近黑抠像不当作文件内嵌 alpha；其余入场片仍标 alpha
          alpha: chromaKey === 'nearblack' ? false : true,
          ...(chromaKey ? { chromaKey } : {}),
        }, folderId)
        // 元素自带的音效（如泡泡转场片源自带的音轨）：落到独立音轨，跟元素同起同落
        const sfxName = (e as { sfx?: string }).sfx
        if (sfxName) {
          const skey = `${seg.id}/${e.id}/sfx`
          wanted.add(skey)
          const oldSfx = byKey.get(skey)?.[0]
          if (oldSfx?.meta?.source?.rev !== rev) {
            if (oldSfx) patches[oldSfx.id] = null
            const sfxDur = Math.max(0.2, t2 - t0)
            const sfxMedia = ensureMedia({
              name: `${seg.title || seg.id}_${k + 1}_${name}_音效.wav`,
              url: aiUrl(sfxName), kind: 'audio', duration: sfxDur,
            }, folderId)
            if (sfxMedia) {
              items.push({
                mediaId: sfxMedia, start: t0, duration: sfxDur, lane: SFX_LANE,
                name: `${name} · 音效`, source: { key: skey, rev },
              })
              placed[skey] = rev
            }
          }
        }
        // 转场：按元素窗整段播（durationMs），勿用 board.fps 误算短片长导致泡泡卡死半截
        if (playEnter && video && t2 - t0 > 0.02) {
          const playDur = Math.max(0.2, t2 - t0)
          items.push({
            mediaId: video,
            start: t0,
            duration: playDur,
            inPoint: 0,
            outPoint: playDur,
            lane,
            name: `${name} · ${motion}`,
            transform,
            source: { key: dk, rev, layout },
          })
          placed[dk] = rev
          placed[hk] = rev
          continue
        }
        // cut：直接铺 hold（底板/开场静帧）
        if (cutEnter && still && t2 - t0 > 0.02) {
          items.push({ mediaId: still, start: t0, duration: t2 - t0, lane, name, transform, source: { key: hk, rev, layout } })
          placed[dk] = rev
          placed[hk] = rev
          continue
        }
        const drawItem: AddItem | null = video
          ? { mediaId: video, start: t0, duration: Math.min(t1 - t0, videoDur), lane, name: `${name} · ${motion}`, transform, source: { key: dk, rev, layout, chalk } }
          : null
        // fade/stamp/draw：先铺满定格，入场 webm 叠在开头；Ctrl+Z 可只撤入场
        if (drawItem && still && t2 - t0 > 0.02 && (t1 - t0) > 0.02) {
          items.push({ mediaId: still, start: t0, duration: t2 - t0, lane, name, transform, source: { key: hk, rev, layout } })
          entrances.push({ holdKey: hk, t1, tail: t2 - t1, draw: drawItem, linkTo: voiceIds.get(seg.id), hand: !!(keepHand && chalk) })
        } else {
          if (drawItem) items.push(drawItem)
          if (still && t2 - t1 > 0.02) items.push({ mediaId: still, start: t1, duration: t2 - t1, lane, name, transform, source: { key: hk, rev, layout } })
          if (keepHand && chalk && drawItem) handOn.push(dk)
        }
        placed[dk] = rev
        placed[hk] = rev
      }
    }
    if (items.length) addLater.push({ items, linkTo: voiceIds.get(seg.id) })
  }

  // 3. 删掉文档里已经没有的产物，应用移动 / 替换
  for (const [key, clips] of byKey) {
    if (key.endsWith('/subs')) continue
    if (key === 'plate' || wanted.has(key)) continue
    for (const c of clips) patches[c.id] = null
    changed = true
  }
  if (Object.keys(patches).length) useApp.getState().patchClipsQuiet(patches)
  for (const { items, linkTo } of addLater) {
    const ids = useApp.getState().addAiLayerClips(items, { ...opts, linkTo })
    const draws = ids.filter((id, i): id is string => !!id && handOn.includes(items[i].source?.key ?? ''))
    if (draws.length) setChalkHand(draws, true, { history: false })
    changed = true
  }

  // 4. 字幕：每段一组，跟着本段配音；配音换了 / 参数改了整组重放
  const subsOn = p.params.subtitles !== 'off'
  for (const seg of p.segments) {
    const key = `${seg.id}/subs`
    const old = byKey.get(key) ?? []
    const m = maps.get(seg.id)
    const subs = seg.subtitles
    if (!subsOn || !subs || !m || !seg.voice) {
      if (old.length && !subsOn) { useApp.getState().patchClipsQuiet(Object.fromEntries(old.map((c) => [c.id, null]))); changed = true }
      continue
    }
    const rev = subs.hash
    const sameRev = old.some((c) => c.meta?.source?.rev === rev)
    if (sameRev) continue
    if (!old.length && placed[key] === rev) continue
    if (old.length) useApp.getState().patchClipsQuiet(Object.fromEntries(old.map((c) => [c.id, null])))
    const style = subtitleClipStyle({ ...p.params, ...subs.params, size: p.params.size }, frame.width, frame.height)
    useApp.getState().addSubtitleCues({
      cues: subs.cues.map((q) => ({ text: q.text, start: toTimeline(m, q.start), end: toTimeline(m, q.end) })),
      linkTo: voiceIds.get(seg.id),
      text: style.text,
      transform: style.transform,
      source: { type: 'ai', jobId: p.id, kind: 'production', key, rev },
      quiet: true,
    })
    placed[key] = rev
    changed = true
  }
  // 删掉的段留下的字幕
  for (const [key, clips] of byKey) {
    if (!key.endsWith('/subs')) continue
    if (p.segments.some((s) => `${s.id}/subs` === key)) continue
    useApp.getState().patchClipsQuiet(Object.fromEntries(clips.map((c) => [c.id, null])))
    changed = true
  }

  // 5. 底板：从整片起点铺到最后一个产物结束
  if (p.plate && p.params.plate !== 'none') {
    wanted.add('plate')
    const now = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === p.id && c.meta.source.key && c.meta.source.key !== 'plate')
    const end = Math.max(cursor, ...now.map((c) => startOf(c) + c.duration))
    const old = byKey.get('plate')?.[0]
    const dur = Math.max(0.5, end - rec.t0)
    if (old) {
      const patch: Partial<Clip> = {}
      if (old.meta?.source?.rev !== p.plate.hash) {
        const media = ensureMedia({ name: `${label}_底板.png`, url: aiUrl(p.plate.url), kind: 'image', duration: dur, width: p.plate.width, height: p.plate.height }, folderId)
        if (media) Object.assign(patch, { mediaId: media, meta: { ...old.meta!, source: { ...old.meta!.source!, rev: p.plate.hash } } })
        placed.plate = p.plate.hash
      }
      // 底板没被用户裁过（起点仍是整片起点）就跟着整片长度走
      if (Math.abs(old.start - rec.t0) < EPS && Math.abs(old.duration - dur) > 1 / projFps) Object.assign(patch, { duration: dur, outPoint: dur })
      if (Object.keys(patch).length) { useApp.getState().patchClipsQuiet({ [old.id]: patch }); changed = true }
    } else if (placed.plate !== p.plate.hash && now.length) {
      const media = ensureMedia({ name: `${label}_底板.png`, url: aiUrl(p.plate.url), kind: 'image', duration: dur, width: p.plate.width, height: p.plate.height }, folderId)
      if (media) useApp.getState().addAiLayerClips([{ mediaId: media, start: rec.t0, duration: dur, lane: PLATE_LANE, name: `${label} · 黑板底`, source: { key: 'plate', rev: p.plate.hash } }], opts)
      placed.plate = p.plate.hash
      changed = true
    }
  } else if (byKey.get('plate')?.length && p.params.plate === 'none') {
    useApp.getState().patchClipsQuiet(Object.fromEntries(byKey.get('plate')!.map((c) => [c.id, null])))
    changed = true
  }

  // 入场（书写视频 / 盖章 / 显现，以及粉笔手）叠在已经铺好的定格上，单独一笔撤销
  if (entrances.length) {
    const clipsNow = useApp.getState().seq().clips
    const jobs = entrances.flatMap((ent) => {
      const hold = clipsNow.find((c) => c.meta?.source?.jobId === p.id && c.meta.source.key === ent.holdKey)
      return hold ? [{ hold, ent }] : []
    })
    if (jobs.length) {
      useApp.getState().pushHistory()
      const holdPatch: Record<string, Partial<Clip> | null> = {}
      const groups = new Map<string, { linkTo?: string; items: AddItem[]; hands: string[] }>()
      for (const { hold, ent } of jobs) {
        holdPatch[hold.id] = ent.tail > 0.02
          ? { start: ent.t1, duration: ent.tail, outPoint: ent.tail }
          : null
        const gk = ent.linkTo ?? ''
        const g = groups.get(gk) ?? { linkTo: ent.linkTo, items: [], hands: [] }
        g.items.push(ent.draw)
        if (ent.hand && ent.draw.source?.key) g.hands.push(ent.draw.source.key)
        groups.set(gk, g)
      }
      useApp.getState().patchClipsQuiet(holdPatch)
      for (const g of groups.values()) {
        const ids = useApp.getState().addAiLayerClips(g.items, { ...opts, linkTo: g.linkTo })
        const draws = ids.filter((id, i): id is string => !!id && g.hands.includes(g.items[i].source?.key ?? ''))
        if (draws.length) setChalkHand(draws, true, { history: false })
      }
      changed = true
    }
  }

  const st = useApp.getState()
  const cur = st.settings.aiProductions?.[p.id]
  if (cur && JSON.stringify(cur.placed) !== JSON.stringify(placed)) {
    useApp.setState({ settings: { ...st.settings, aiProductions: { ...st.settings.aiProductions, [p.id]: { ...cur, placed } } } })
    changed = true
  }
  return changed
}

/** 段 → 时间线上的位置（成片面板「定位」用）：配音片段在哪就是哪 */
export function segmentClipStart(p: Production, seg: ProductionSegment) {
  const c = useApp.getState().seq().clips.find((x) => x.meta?.source?.jobId === p.id && x.meta.source.key === `${seg.id}/voice`)
  return c ? c.start : null
}

export function elementClips(pid: string, segId: string, el: { id: string }) {
  return useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === pid && c.meta.source.key?.startsWith(`${segId}/${el.id}/`))
}

// ── 轮询：本工程登记过的成片，文档版本变了才拉整份 ─────────────────

const seenRev = new Map<string, number>()
const listeners = new Set<(p: Production) => void>()

/** 成片面板订阅文档更新（和入轨同一次拉取，不重复请求） */
export function onProductionUpdate(fn: (p: Production) => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 强制下一轮重新拉取（编辑之后立刻对账） */
export function invalidateProduction(id: string) {
  seenRev.delete(id)
}

export async function pollProductions() {
  if (!useApp.getState().started) return
  const ids = Object.keys(useApp.getState().settings.aiProductions ?? {})
  if (!ids.length) return
  const list = await listProductions(ids)
  let dirty = false
  for (const s of list) {
    if (seenRev.get(s.id) === s.rev) continue
    const p = await getProduction(s.id)
    seenRev.set(s.id, p.rev)
    for (const fn of listeners) fn(p)
    if (syncProduction(p)) dirty = true
  }
  if (dirty) void useApp.getState().flushProject()
}

/** 编辑 / 运行之后直接拿到了整份文档：通知面板并立刻对账 */
export function applyProduction(p: Production) {
  seenRev.set(p.id, p.rev)
  for (const fn of listeners) fn(p)
  if (syncProduction(p)) void useApp.getState().flushProject()
}
