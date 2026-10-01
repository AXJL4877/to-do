/**
 * 成片合成层（productionTimeline.syncProduction）回归：在真实 store 上对账一份合成的成片文档。
 * 首次入轨 / 幂等 / 版本变了原位替换并保留用户位置 / 用户删的不放回 / 配音变长后面顺移 / 插段与删段 / 字幕与底板。
 */
import { useApp } from '../src/store'
import { syncProduction } from '../src/lib/productionTimeline'
import type { Production, ProductionBoard, ProductionSegment } from '../src/lib/production'
import { defaultScene3d, type Clip, type Track } from '../src/types'
import { buildEditGraph } from '../src/lib/editGraph'

const results: { name: string; ok: boolean; error?: string }[] = []
function check(ok: unknown, message: string) { if (!ok) throw new Error(message) }
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: String(e) }) }
}

const PID = 'p_test_0001'
const track = (id: string, kind: Track['kind']): Track => ({ id, name: id, kind, locked: false, muted: false, hidden: false, solo: false, height: 48 })

function board(id: string, startMs: number, endMs: number, els: string[], rev: string): ProductionBoard {
  return {
    id, start: 0, dirty: false,
    elements: els.map((e, i) => ({ id: e, label: `元素${e}`, draw: `draw ${e}`, role: i ? 'support' : 'hero', weight: 1, at: 0, pick: 0, dirty: false, variants: [{ id: `v${e}`, source: 'ai', hash: 'h', file: `${e}.png`, url: `/ai-generated/${e}.png` }] })),
    render: {
      hash: rev,
      result: {
        fps: 30, width: 1920, height: 1080, startMs, endMs, layout: 'auto',
        elements: els.map((e, i) => ({
          id: e, label: `元素${e}`, role: 'hero', box: [100 + i * 300, 100, 200, 200], crop: [100 + i * 300, 100, 200, 200],
          startMs: startMs + i * 1000, durationMs: 600, frames: 24, video: `/ai-generated/${rev}_${e}.webm`, hold: `/ai-generated/${rev}_${e}_hold.png`,
          tip: [[0, 0.1, 0.1], [0.5, 0.6, 0.6]],
        })),
      },
    },
  }
}

function segment(id: string, dur: number, voiceHash: string, prefix: string, rev = 'r1'): ProductionSegment {
  const half = Math.round(dur * 500)
  return {
    id, title: `段${id}`, text: `${id} 的口播。`,
    voice: { hash: voiceHash, audio: `${voiceHash}.wav`, audioUrl: `/ai-generated/${voiceHash}.wav`, timing: 't.json', duration: dur, speaker: null, phrases: [{ text: 'a。', start: 0, end: 1, sentence: 0 }] },
    plan: { hash: 'p', voiceHash, source: 'ai', notes: '' },
    subtitles: { hash: `sub_${voiceHash}`, params: { font: 'smiley', fontPx: 54, bottomPct: 6 }, cues: [{ text: `${id}一`, start: 0, end: dur / 2 }, { text: `${id}二`, start: dur / 2, end: dur }] },
    boards: [board(`${prefix}b1`, 0, half, [`${prefix}e1`, `${prefix}e2`], `${prefix}${rev}a`), board(`${prefix}b2`, half, dur * 1000, [`${prefix}e3`], `${prefix}${rev}b`)],
    dirty: { voice: false, plan: false, subtitles: false },
  }
}

function production(segments: ProductionSegment[], patch: Partial<Production> = {}): Production {
  return {
    id: PID, skillId: 'builtin.chalk-hand', title: '测试成片', script: '', cast: [], outline: null, rev: 1, updatedAt: 0, status: null, lock: null,
    params: { size: '1920x1080', hand: 'chalk', subtitles: 'on', plate: 'board', tail: 1 },
    plate: { hash: 'plate1', file: 'plate.png', url: '/ai-generated/plate.png', width: 1920, height: 1080 },
    hand: { file: 'hand.png', url: '/ai-generated/hand.png', width: 100, height: 150, tipX: 0.1, tipY: 0.1 },
    segments, queuedJobId: null, runningJobId: null, ...patch,
  }
}

const mine = () => useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === PID)
const byKey = (key: string) => mine().filter((c) => c.meta?.source?.key === key)
const one = (key: string) => { const c = byKey(key); check(c.length === 1, `应有一个 ${key}，实际 ${c.length}`); return c[0] }
const near = (a: number, b: number, msg: string) => check(Math.abs(a - b) < 0.02, `${msg}：${a} ≠ ${b}`)
const trackKind = (c: Clip) => useApp.getState().seq().tracks.find((t) => t.id === c.trackId)?.kind

const seqId = 'prod-test'
useApp.setState({
  started: true,
  media: [],
  folders: [],
  sequences: [{ id: seqId, name: 'test', tracks: [track('v1', 'video'), track('a1', 'audio'), track('s1', 'subtitle')], clips: [], markers: [], workIn: 0, workOut: 10, scene3d: defaultScene3d() }],
  activeSeqId: seqId,
  settings: { ...useApp.getState().settings, width: 1920, height: 1080, fps: 30, aiProductions: { [PID]: { t0: 2, auto: true, placed: {}, createdAt: 0 } } },
})

let g1 = segment('g1', 10, 'va', 'x')
let g2 = segment('g2', 8, 'vb', 'y')

test('首次入轨：配音首尾相接、元素书写 + 定格、字幕链接配音、底板铺满整片', () => {
  check(syncProduction(production([g1, g2])), '应有改动')
  const v1 = one('g1/voice')
  const v2 = one('g2/voice')
  near(v1.start, 2, '第一段从 t0 开始')
  near(v2.start, 12, '第二段接在第一段后面')
  check(trackKind(v1) === 'audio', '配音在音频轨')
  const d = one('g1/xe1/draw')
  const h = one('g1/xe1/hold')
  near(d.start, 2, '元素在起笔时刻出现')
  near(h.start, d.start + d.duration, '定格图接在书写片段后')
  near(h.start + h.duration, 7, '定格到换板')
  check(d.linkedId === v1.id, '元素链接本段配音')
  check(d.meta?.source?.chalk?.on, '粉笔手默认开')
  const lastHold = one('g2/ye3/hold')
  near(lastHold.start + lastHold.duration, 21, '最后一块留到配音后 tail 秒')
  const subs = byKey('g1/subs')
  check(subs.length === 2 && subs.every((c) => trackKind(c) === 'subtitle' && c.linkedId === v1.id), '字幕两条、在字幕轨、链接配音')
  near(subs[1].start, 7, '字幕按配音时间换算')
  const plate = one('plate')
  near(plate.start, 2, '底板从整片起点开始')
  near(plate.start + plate.duration, 21, '底板铺到整片结束')
  const tracks = useApp.getState().seq().tracks
  check(tracks.findIndex((t) => t.id === plate.trackId) > tracks.findIndex((t) => t.id === d.trackId), '底板在元素下面')
})

test('幂等：再对账一次什么都不动', () => {
  const before = JSON.stringify(mine().map((c) => [c.id, c.start, c.duration]))
  check(!syncProduction(production([g1, g2])), '不应有改动')
  check(JSON.stringify(mine().map((c) => [c.id, c.start, c.duration])) === before, '片段不变')
})

test('镜头重渲：原位换成新片段，用户挪过的元素保留位置，别的镜头不动', () => {
  const moved = one('g1/xe1/draw')
  const pair = one('g1/xe1/hold')
  const other = one('g2/ye3/draw').id
  useApp.getState().patchClipsQuiet({ [moved.id]: { transform: { ...moved.transform, x: 0.5 } }, [pair.id]: { transform: { ...pair.transform, x: 0.5 } } })
  const untouched = one('g1/xe2/draw').transform
  g1 = segment('g1', 10, 'va', 'x', 'r2')
  g1.boards[1] = segment('g1', 10, 'va', 'x').boards[1]
  check(syncProduction(production([g1, g2])), '应有改动')
  const d = one('g1/xe1/draw')
  check(d.id !== moved.id && d.meta?.source?.rev === 'xr2a', '换成新版本的片段')
  near(d.transform.x, 0.5, '保留用户挪过的位置')
  near(one('g1/xe2/draw').transform.x, untouched.x, '没挪过的用新默认位置')
  check(one('g2/ye3/draw').id === other, '其它段的片段不动')
})

test('用户删掉的产物不放回；版本变了才再放', () => {
  const h = one('g2/ye3/hold')
  useApp.getState().patchClipsQuiet({ [h.id]: null })
  syncProduction(production([g1, g2]))
  check(byKey('g2/ye3/hold').length === 0, '删掉的定格图不放回')
})

test('配音变长：本段原位换配音，后面的段整体顺移', () => {
  const v1 = one('g1/voice').id
  const before = one('g2/ye3/draw').start
  g1 = { ...g1, voice: { ...g1.voice!, hash: 'va2', audioUrl: '/ai-generated/va2.wav', duration: 12 } }
  syncProduction(production([g1, g2]))
  const nv = one('g1/voice')
  check(nv.id === v1 && nv.meta?.source?.rev === 'va2', '配音片段原位替换')
  near(nv.duration, 12, '新配音时长')
  near(one('g2/voice').start, 14, '第二段顺移 2 秒')
  near(one('g2/ye3/draw').start, before + 2, '第二段的元素一起顺移')
  near(byKey('g2/subs')[0].start, 14, '第二段的字幕一起顺移')
})

test('中间插一段：后面的段让出位置；删掉后再收回来', () => {
  const g3 = segment('g3', 5, 'vc', 'z')
  syncProduction(production([g1, g3, g2]))
  near(one('g3/voice').start, 14, '新段接在第一段后')
  near(one('g2/voice').start, 19, '后面的段让出 5 秒')
  check(mine().every((c) => c.start >= 2 - 1e-6), '片段都在整片起点之后')
  syncProduction(production([g1, g2]))
  check(byKey('g3/voice').length === 0 && byKey('g3/ze1/draw').length === 0 && byKey('g3/subs').length === 0, '删掉的段片段清空')
  near(one('g2/voice').start, 14, '后面的段收回来')
})

test('字幕重切：整组替换；关掉字幕就删掉', () => {
  const old = byKey('g2/subs').map((c) => c.id)
  g2 = { ...g2, subtitles: { ...g2.subtitles!, hash: 'sub_new', cues: [{ text: '新字幕', start: 0, end: 8 }] } }
  syncProduction(production([g1, g2]))
  const subs = byKey('g2/subs')
  check(subs.length === 1 && !old.includes(subs[0].id) && subs[0].text?.content === '新字幕', '字幕整组换新')
  syncProduction(production([g1, g2], { params: { size: '1920x1080', hand: 'chalk', subtitles: 'off', plate: 'board', tail: 1 } }))
  check(byKey('g1/subs').length === 0 && byKey('g2/subs').length === 0, '关字幕后删掉')
})

test('底板跟着整片长度走', () => {
  const plate = one('plate')
  near(plate.start + plate.duration, 2 + 12 + 8 + 1, '底板延到新的结尾')
})

test('关掉自动入轨后不再改时间轴', () => {
  const st = useApp.getState()
  useApp.setState({ settings: { ...st.settings, aiProductions: { [PID]: { ...st.settings.aiProductions![PID], auto: false } } } })
  g2 = { ...g2, voice: { ...g2.voice!, hash: 'vb2', duration: 3 } }
  check(!syncProduction(production([g1, g2])), '不应改动')
})

let exportSequence: unknown
test('真实动态文字成片文档自动入轨，包含配音和可编辑文字且重复同步不会重复添加', () => {
  const p = (window as any).dynamicProductionFixture as Production
  const st = useApp.getState()
  useApp.setState({ selectedClipIds: [], media: [], folders: [],
    sequences: [{ ...st.seq(), clips: [], workIn: 0, workOut: 8 }],
    settings: { ...st.settings, width: 640, height: 360, fps: 30,
      aiProductions: { [p.id]: { t0: 0, auto: true, placed: {}, createdAt: 0 } } } })
  check(syncProduction(p), '动态成片没有入轨')
  const clips = useApp.getState().seq().clips
  const text = clips.filter(c => c.text?.fancy?.dynamic)
  check(text.length === p.segments.flatMap(s => s.boards).length, '文字镜头缺失')
  check(clips.some(c => c.meta?.source?.key?.endsWith('/voice')), '配音缺失')
  check(text.every(c => !!c.linkedId && c.duration > 0 && !c.mediaId), '镜头须为链接配音的可编辑文字')
  check(text.map(c => c.text!.content).join('') === p.script, '口播文字被丢弃或改写')
  check(!syncProduction(p), '重复同步不应重复添加')
  const state = useApp.getState(); const sq = state.seq()
  const media = state.media.map(m => ({ ...m, path: m.kind === 'audio' ? m.url : m.path }))
  exportSequence = buildEditGraph({ clips: sq.clips, tracks: sq.tracks, media,
    settings: state.settings, workIn: 0, workOut: p.segments.reduce((n, s) => n + (s.voice?.duration || 0), 0) })
})
;(window as unknown as { productionTests: unknown }).productionTests = { failed: results.filter((r) => !r.ok).length, results, exportSequence }
