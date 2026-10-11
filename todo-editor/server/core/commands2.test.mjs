/**
 * 第二批命令（覆盖 UI 真实编辑动作）的测试 + 注册表一致性守卫。
 *
 * 守卫的由来：这批命令是用 COMMANDS.push() 追加的，而 COMMAND_IDS / byId 原本在 push **之前**求值——
 * 于是命令"在表里但 applyCommand 说未知"。这种错在 Node 里跑测试完全看不出来（除非有人正好用新命令），
 * 所以把它变成一条会红的测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_IDS, COMMANDS, applyCommand, describeCommands } from './commands.mjs'
import { validateProject } from '../spec/projectSpec.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'spec', '__fixtures__', 'minimal.todo.json')
const baseDoc = () => JSON.parse(readFileSync(fixture, 'utf8'))
let n = 0
const newId = () => { n += 1; return `t2_${n}` }
const run = (id, args, doc = baseDoc()) => applyCommand(doc, id, args, { newId })

// ───────────────────────── 注册表一致性（守卫）─────────────────────────

test('注册表一致：COMMAND_IDS 与 COMMANDS 一一对应（含 push 追加的第二批）', () => {
  assert.equal(COMMAND_IDS.length, COMMANDS.length, 'COMMAND_IDS 漏了 push 进来的命令')
  assert.deepEqual(COMMAND_IDS, COMMANDS.map((c) => c.id))
  assert.ok(COMMAND_IDS.length >= 20, `P1 目标是 20-30 条，现在 ${COMMAND_IDS.length} 条`)
})

test('注册表一致：每条命令都能被 applyCommand 解析到（不会报 unknown command）', () => {
  const doc = baseDoc()
  const unknown = []
  for (const id of COMMAND_IDS) {
    const r = applyCommand(doc, id, {})
    // 参数不全会报 bad_request / conflict，但不应该是 not_found
    if (r.error?.code === 'not_found') unknown.push(id)
  }
  assert.deepEqual(unknown, [], `这些命令在表里但 applyCommand 找不到：${unknown.join(', ')}`)
})

test('注册表一致：describeCommands 覆盖全部命令且参数 schema 合法', () => {
  const list = describeCommands()
  assert.equal(list.length, COMMAND_IDS.length)
  for (const c of list) {
    assert.equal(c.params.type, 'object')
    assert.equal(c.params.additionalProperties, false, `${c.id} 缺 additionalProperties`)
  }
})

// ───────────────────────── 新命令行为 ─────────────────────────

test('clip.set_enabled：停用后 meta.visible 变 false', () => {
  const r = run('clip.set_enabled', { clipId: 'cl_v1', enabled: false })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const c = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1')
  assert.equal(c.enabled, false)
  assert.equal(c.meta.visible, false, '派生镜像要跟着变')
})

test('clip.set_speed：倍数/倒放/冻结可单给', () => {
  const r = run('clip.set_speed', { clipId: 'cl_v1', speed: 2, reverse: true })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const c = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1')
  assert.equal(c.speed, 2)
  assert.equal(c.reverse, true)
  assert.match(r.summary, /2x 倒放/)
  assert.equal(run('clip.set_speed', { clipId: 'cl_v1' }).error.code, 'conflict', '一个字段都不给应拒绝')
})

test('clip.set_audio：写入 audio 子对象，不理其他字段', () => {
  const r = run('clip.set_audio', { clipId: 'cl_v1', volume: 0.5, fadeIn: 0.3 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const a = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1').audio
  assert.equal(a.volume, 0.5)
  assert.equal(a.fadeIn, 0.3)
  assert.equal(a.gainDb, undefined, '没给的字段不能凭空出现')
})

test('clip.set_color：调色只改给到的字段', () => {
  const r = run('clip.set_color', { clipId: 'cl_v1', saturation: 1.4 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1').color, { saturation: 1.4 })
})

test('clip.set_text：改文字同时同步片段名（便于时间轴上认出来）', () => {
  const r = run('clip.set_text', { clipId: 'cl_solid', content: '能被人抄走的东西都不值钱' })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const c = r.doc.sequences[0].clips.find((x) => x.id === 'cl_solid')
  assert.equal(c.text.content, '能被人抄走的东西都不值钱')
  assert.equal(c.name, '能被人抄走的东西都不值钱')
})

test('clip.set_transition：设置与移除', () => {
  const set = run('clip.set_transition', { clipId: 'cl_v1', edge: 'in', type: 'dissolve', duration: 0.6 })
  assert.equal(set.ok, true, JSON.stringify(set.error))
  const c = set.doc.sequences[0].clips.find((x) => x.id === 'cl_v1')
  assert.equal(c.transitionIn.type, 'dissolve')
  assert.equal(c.transitionIn.duration, 0.6)
  const rm = run('clip.set_transition', { clipId: 'cl_v1', edge: 'in', duration: 0 })
  assert.equal(rm.ok, true)
  assert.equal(rm.doc.sequences[0].clips.find((x) => x.id === 'cl_v1').transitionIn, undefined)
  // 99s 超过参数 schema 的上限（10s），所以是 bad_request；语义校验（比片段还长）另有一条
  assert.equal(run('clip.set_transition', { clipId: 'cl_v1', edge: 'in', duration: 99 }).error.code, 'bad_request')
  assert.equal(run('clip.set_transition', { clipId: 'cl_v1', edge: 'in', duration: 9 }).error.code, 'conflict')
})

test('clip.add_effect：追加特效并返回新建 id', () => {
  const r = run('clip.add_effect', { clipId: 'cl_v1', type: 'blur', strength: 0.3 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.created.length, 1)
  const fx = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1').effects
  assert.equal(fx.length, 1)
  assert.equal(fx[0].type, 'blur')
  assert.equal(run('clip.add_effect', { clipId: 'cl_v1', type: '不存在的特效' }).error.code, 'bad_request')
})

test('timeline.move_clips：批量位移 + 挡住负数起点', () => {
  const r = run('timeline.move_clips', { clipIds: ['cl_v1', 'cl_solid'], deltaSeconds: 2 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.changed.length, 2)
  assert.equal(r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1').start, 2)
  const neg = run('timeline.move_clips', { clipIds: ['cl_v1'], deltaSeconds: -99 })
  assert.equal(neg.error.code, 'conflict')
  assert.match(neg.error.message, /起点为负/)
})

test('timeline.move_clips：跨类型整体换轨被挡', () => {
  const r = run('timeline.move_clips', { clipIds: ['cl_v1'], deltaSeconds: 0, trackId: 'tr_a1' })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /不能移到/)
})

test('timeline.ripple_delete：后面的片段整体前移合拢空隙', () => {
  const doc = baseDoc()
  const seq = doc.sequences[0]
  const removed = seq.clips.find((c) => c.id === 'cl_v1')
  const follower = { id: 'cl_after', trackId: removed.trackId, start: removed.start + removed.duration + 1, duration: 2, inPoint: 0, outPoint: 2, name: '后面的', enabled: true }
  seq.clips = [...seq.clips, follower]
  const r = run('timeline.ripple_delete', { clipIds: ['cl_v1'] }, doc)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const after = r.doc.sequences[0].clips.find((c) => c.id === 'cl_after')
  assert.equal(after.start, follower.start - removed.duration, '后面的片段要前移被删片段的时长')
  assert.equal(after.start, 1, '7s - 6s = 1s')
  assert.equal(r.doc.sequences[0].clips.find((c) => c.id === 'cl_v1'), undefined)
})

test('sequence.rename：空名/超长被挡', () => {
  const ok = run('sequence.rename', { name: '  口播成片 v2  ' })
  assert.equal(ok.ok, true, JSON.stringify(ok.error))
  assert.equal(ok.doc.sequences[0].name, '口播成片 v2', '要去掉首尾空白')
  assert.equal(run('sequence.rename', { name: '   ' }).error.code, 'conflict')
  assert.equal(run('sequence.rename', { name: 'x'.repeat(41) }).error.code, 'conflict')
})

test('media.remove：被引用时默认拒绝，点名要删片段才允许', () => {
  const blocked = run('media.remove', { mediaIds: ['m_v1'] })
  assert.equal(blocked.error.code, 'conflict')
  assert.match(blocked.error.message, /个片段引用着这些素材/)
  const forced = run('media.remove', { mediaIds: ['m_v1'], removeClips: true })
  assert.equal(forced.ok, true, JSON.stringify(forced.error))
  assert.equal(forced.doc.media.some((m) => m.id === 'm_v1'), false)
  assert.equal(forced.doc.sequences[0].clips.some((c) => c.mediaId === 'm_v1'), false)
  assert.match(forced.summary, /同时删除 \d+ 个片段/)
})

test('新命令跑完后工程仍然合规（写入闸门对新命令同样生效）', () => {
  let doc = baseDoc()
  const plan = [
    ['clip.set_enabled', { clipId: 'cl_v1', enabled: true }],
    ['clip.set_speed', { clipId: 'cl_v1', speed: 1.5 }],
    ['clip.set_audio', { clipId: 'cl_v1', volume: 0.8 }],
    ['clip.set_color', { clipId: 'cl_v1', brightness: 0.1 }],
    ['clip.set_text', { clipId: 'cl_solid', content: '标题' }],
    ['clip.add_effect', { clipId: 'cl_v1', type: 'glow' }],
    ['clip.set_transition', { clipId: 'cl_v1', edge: 'out', duration: 0.4 }],
    ['timeline.move_clips', { clipIds: ['cl_solid'], deltaSeconds: 1 }],
  ]
  for (const [id, args] of plan) {
    const r = applyCommand(doc, id, args, { newId })
    assert.equal(r.ok, true, `${id}: ${JSON.stringify(r.error)}`)
    assert.equal(validateProject(r.doc).ok, true, `${id} 之后文档应仍合规`)
    doc = r.doc
  }
})

// ───────────────────────── timeline.razor_at（UI razor 动作的命令化）─────────────────────────

test('timeline.razor_at：一次切开播放头下所有片段（含帧网格端点判定）', () => {
  // 造两条相互重叠的轨道片段，切线落在两者内部
  const doc = baseDoc()
  const seq = doc.sequences[0]
  seq.clips = [
    { id: 'c1', trackId: 'tr_v1', start: 0, duration: 4, inPoint: 10, outPoint: 14, name: 'A', enabled: true },
    { id: 'c2', trackId: 'tr_v2', start: 1, duration: 5, inPoint: 20, outPoint: 25, name: 'B', enabled: true },
  ]
  const r = applyCommand(doc, 'timeline.razor_at', { at: 2, fps: 30 }, { newId })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.changed.length, 2, '两个片段各被切一刀')
  assert.equal(r.created.length, 2)
  const clips = r.doc.sequences[0].clips
  assert.equal(clips.length, 4)
  const a = clips.find((c) => c.id === 'c1')
  assert.equal(a.duration, 2)
  assert.equal(a.outPoint, 12, '左段出点要跟着走')
  const bR = clips.find((c) => r.created.includes(c.id) && c.trackId === 'tr_v1')
  assert.equal(bR.start, 2)
  assert.equal(bR.duration, 2)
  assert.equal(bR.inPoint, 12, '右段入点要接着左段')
  assert.equal(bR.outPoint, 14)
})

test('timeline.razor_at：端点/空处拒绝，并给出人话原因', () => {
  const doc = baseDoc()
  doc.sequences[0].clips = [{ id: 'c1', trackId: 'tr_v1', start: 1, duration: 3, inPoint: 0, outPoint: 3, name: 'A', enabled: true }]
  const atEnd = applyCommand(doc, 'timeline.razor_at', { at: 4, fps: 30 }, { newId })
  assert.equal(atEnd.error.code, 'conflict')
  assert.match(atEnd.error.message, /没有可切开的片段/)
  const empty = applyCommand(doc, 'timeline.razor_at', { at: 9, fps: 30 }, { newId })
  assert.equal(empty.error.code, 'conflict')
})

test('timeline.razor_at：联动片段被同时切开时，右段与右段重新关联', () => {
  const doc = baseDoc()
  doc.sequences[0].clips = [
    { id: 'v1', trackId: 'tr_v1', start: 0, duration: 4, inPoint: 0, outPoint: 4, name: '画面', enabled: true, linkedId: 'a1' },
    { id: 'a1', trackId: 'tr_a1', start: 0, duration: 4, inPoint: 0, outPoint: 4, name: '声音', enabled: true, linkedId: 'v1' },
  ]
  const r = applyCommand(doc, 'timeline.razor_at', { at: 2, fps: 30 }, { newId })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const clips = r.doc.sequences[0].clips
  const rightV = clips.find((c) => r.created.includes(c.id) && c.trackId === 'tr_v1')
  const rightA = clips.find((c) => r.created.includes(c.id) && c.trackId === 'tr_a1')
  assert.equal(rightV.linkedId, rightA.id, '右画面要指向右声音')
  assert.equal(rightA.linkedId, rightV.id, '右声音要指向右画面')
  const leftV = clips.find((c) => c.id === 'v1')
  assert.equal(leftV.linkedId, 'a1', '左段保持原来的联动关系')
})
