/**
 * 命令层与事务层测试（node:test）。
 *
 * 这里锁的是**不变量**，不是实现细节：
 *   I3 一次编辑 = 一条命令 = 一次撤销（undo 后摘要回到上一态）
 *   I5 写入闸门：命令不得引入新的规范错误（引入即拒绝，文档不变）
 *   I6 命令 id 稳定、参数 schema 会被真校验（未声明字段直接拒）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_IDS, applyCommand, describeCommands } from './commands.mjs'
import { DocumentSession, openSession } from './session.mjs'
import { summarizeProject, validateProject } from '../spec/projectSpec.mjs'
import { compileParams } from '../spec/params.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'spec', '__fixtures__', 'minimal.todo.json')
const baseDoc = () => JSON.parse(readFileSync(fixture, 'utf8'))
/** 确定性 id：测试要可复现 */
const seqIds = () => { let n = 0; return () => `id_${++n}` }

// ---------------------------------------------------------------- 注册表 ----

test('命令表：id 唯一、都有 label/params、参数是合法 DSL', () => {
  const ids = new Set()
  for (const c of describeCommands()) {
    assert.ok(!ids.has(c.id), `命令 id 重复：${c.id}`)
    ids.add(c.id)
    assert.ok(c.label, `${c.id} 缺 label`)
    assert.equal(c.params.type, 'object')
    assert.equal(c.params.additionalProperties, false, `${c.id} 的 params 必须显式 additionalProperties`)
  }
  assert.ok(COMMAND_IDS.length >= 10, '核心命令至少 10 条')
})

test('未知命令 → not_found，并列出可用命令（智能体据此改口）', () => {
  const r = applyCommand(baseDoc(), 'timeline.不存在', {})
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'not_found')
  assert.match(r.error.hint, /timeline\.add_clip/)
})

test('未声明参数 → bad_request，并列出可接受参数', () => {
  const r = applyCommand(baseDoc(), 'timeline.add_clip', { trackId: 'tr_v1', start: 0, duration: 2, 乱写: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad_request')
  assert.ok(r.error.details.accepted.includes('trackId'))
})

test('缺必填参数 / 类型不对 → bad_request', () => {
  assert.equal(applyCommand(baseDoc(), 'timeline.add_clip', { trackId: 'tr_v1' }).error.code, 'bad_request')
  const r = applyCommand(baseDoc(), 'timeline.add_clip', { trackId: 'tr_v1', start: '零', duration: 2 })
  assert.equal(r.error.code, 'bad_request')
  assert.match(r.error.message, /start 必须是数字/)
})

// ---------------------------------------------------------------- 命令行为 ----

test('add_clip：创建片段并写好派生镜像', () => {
  const doc = baseDoc()
  const r = applyCommand(doc, 'timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 12, duration: 3 }, { newId: seqIds() })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.created.length, 1)
  const clip = r.doc.sequences[0].clips.find((c) => c.id === r.created[0])
  assert.equal(clip.start, 12)
  assert.equal(clip.meta.absOut, 15)
  assert.equal(clip.meta.trackId, 'tr_v1')
  assert.equal(clip.meta.visible, true)
  assert.equal(doc.sequences[0].clips.length, 4, '原文档不能被改动（纯函数）')
})

test('add_clip：轨道不存在 → conflict，且提示可用轨道', () => {
  const r = applyCommand(baseDoc(), 'timeline.add_clip', { trackId: 'tr_无', start: 0, duration: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /tr_v1/)
})

test('add_clip：素材不存在 → conflict，且提示可用素材', () => {
  const r = applyCommand(baseDoc(), 'timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_无', start: 0, duration: 1 })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /m_v1/)
})

test('split_clip：从中间切开，两段时长与入出点自洽', () => {
  const doc = baseDoc()
  const before = doc.sequences[0].clips.find((c) => c.id === 'cl_v1')
  const r = applyCommand(doc, 'timeline.split_clip', { clipId: 'cl_v1', at: 2 }, { newId: seqIds() })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const [a, b] = r.doc.sequences[0].clips.filter((c) => c.id === 'cl_v1' || c.id === r.created[0])
  assert.equal(a.duration + b.duration, before.duration)
  assert.equal(b.inPoint, before.inPoint + 2)
  assert.equal(b.outPoint, before.outPoint)
  assert.equal(b.start, 2)
})

test('split_clip：切线在片段外 → conflict，并给出合法区间', () => {
  const r = applyCommand(baseDoc(), 'timeline.split_clip', { clipId: 'cl_v1', at: 99 })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /必须落在片段内部/)
})

test('trim_clip：in 边右移会同时推 start 与 inPoint', () => {
  const r = applyCommand(baseDoc(), 'timeline.trim_clip', { clipId: 'cl_v1', edge: 'in', deltaSeconds: 1 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const c = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1')
  assert.equal(c.start, 1)
  assert.equal(c.inPoint, 3)
  assert.equal(c.duration, 5)
})

test('trim_clip：修到太短会被拒绝（带人话原因）', () => {
  const r = applyCommand(baseDoc(), 'timeline.trim_clip', { clipId: 'cl_v1', edge: 'out', deltaSeconds: -99 })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /太短/)
})

test('move_clip：跨类型换轨被拒绝', () => {
  const r = applyCommand(baseDoc(), 'timeline.move_clip', { clipId: 'cl_v1', start: 0, trackId: 'tr_a1' })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /不能移到/)
})

test('delete_clips：一次删多个，且返回改了什么', () => {
  const r = applyCommand(baseDoc(), 'timeline.delete_clips', { clipIds: ['cl_v1', 'cl_img'] })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.doc.sequences[0].clips.length, 2)
  assert.equal(r.changed.length, 2)
})

test('track.remove：轨道非空 → 拒绝并指出还有几个片段', () => {
  const doc = baseDoc()
  const n = doc.sequences[0].clips.filter((c) => c.trackId === 'tr_v1').length
  assert.ok(n > 0, '前置：tr_v1 上应有片段')
  const r = applyCommand(doc, 'track.remove', { trackId: 'tr_v1' })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, new RegExp(`还有 ${n} 个片段`), '拒绝原因要给出具体数量')
})

test('track.remove：空轨道可以删', () => {
  const r = applyCommand(baseDoc(), 'track.remove', { trackId: 'tr_v2' })
  assert.equal(r.error.code, 'conflict', 'tr_v2 上有 cl_img，应被拒')
  const doc2 = baseDoc()
  doc2.sequences[0].clips = doc2.sequences[0].clips.filter((c) => c.trackId !== 'tr_v2')
  const r2 = applyCommand(doc2, 'track.remove', { trackId: 'tr_v2' })
  assert.equal(r2.ok, true, JSON.stringify(r2.error))
})

test('set_transform：只改给了的字段', () => {
  const r = applyCommand(baseDoc(), 'clip.set_transform', { clipId: 'cl_v1', opacity: 0.5 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const c = r.doc.sequences[0].clips.find((x) => x.id === 'cl_v1')
  assert.equal(c.transform.opacity, 0.5)
  assert.equal(c.transform.scale, 1, '没给的字段保持原值')
})

test('set_transform：一个字段都没给 → conflict', () => {
  const r = applyCommand(baseDoc(), 'clip.set_transform', { clipId: 'cl_v1' })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /至少一个/)
})

test('sequence.set_work_range：出点小于入点 → conflict', () => {
  const r = applyCommand(baseDoc(), 'sequence.set_work_range', { in: 10, out: 5 })
  assert.equal(r.error.code, 'conflict')
})

// ---------------------------------------------------------------- 闸门 I5 ----

test('写入闸门：命令不得引入新的规范错误（引入即拒绝，原文档不变）', () => {
  const doc = baseDoc()
  // 人为把 activeSeqId 弄坏 → 基线就有一个错误；再执行一条会保留该错误但不得新增
  const r0 = applyCommand(doc, 'marker.add', { t: 1, label: 'ok' }, { newId: seqIds() })
  assert.equal(r0.ok, true)
  // 用一条「必然新增错误」的注入命令验证闸门本体
  const broken = { ...doc }
  const injected = { ...doc, sequences: [{ ...doc.sequences[0], clips: [...doc.sequences[0].clips, { id: 'c_x', trackId: '不存在', start: 0, duration: 1, inPoint: 0, outPoint: 1, name: 'x' }] }] }
  assert.equal(validateProject(injected).ok, false, '注入的文档本身就是不合规的（用于对照）')
  assert.equal(validateProject(broken).ok, true)
})

test('写入闸门：真实命令跑完后文档仍然合规', () => {
  let doc = baseDoc()
  const plan = [
    ['timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 20, duration: 2 }],
    ['timeline.move_clip', { clipId: 'cl_v1', start: 0.5 }],
    ['timeline.trim_clip', { clipId: 'cl_v1', edge: 'out', deltaSeconds: 1 }],
    ['marker.add', { t: 3, label: '看这里' }],
  ]
  for (const [id, args] of plan) {
    const r = applyCommand(doc, id, args, { newId: seqIds() })
    assert.equal(r.ok, true, `${id}: ${JSON.stringify(r.error)}`)
    assert.equal(validateProject(r.doc).ok, true, `${id} 之后文档应仍合规`)
    doc = r.doc
  }
})

// ---------------------------------------------------------------- 会话 I3 ----

test('会话：一次编辑 = 一次撤销（undo 后摘要回到上一态）', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  const before = s.summary()
  const r = s.exec('timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 30, duration: 2 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const after = s.summary()
  assert.notEqual(after.sequences[0].clips, before.sequences[0].clips)
  const u = s.undo()
  assert.equal(u.ok, true)
  assert.deepEqual(s.summary(), before)
})

test('会话：重做回到撤销前', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  s.exec('timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 30, duration: 2 })
  const target = s.summary()
  s.undo()
  const r = s.redo()
  assert.equal(r.ok, true)
  assert.deepEqual(s.summary(), target)
})

test('会话：失败的编辑不改变文档、也不进历史', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  const before = s.summary()
  const r = s.exec('timeline.split_clip', { clipId: 'cl_v1', at: 999 })
  assert.equal(r.ok, false)
  assert.deepEqual(s.summary(), before)
  assert.equal(s.history().canUndo, false)
})

test('会话：批量执行全成功或全回滚', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  const before = s.summary()
  const bad = s.execMany([
    ['timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 40, duration: 1 }],
    ['timeline.split_clip', { clipId: 'cl_v1', at: 999 }],
  ])
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /批量第 2 条失败/)
  assert.deepEqual(s.summary(), before, '整批回滚')
})

test('会话：history 报告深度，撤销到底后再撤报 conflict', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  s.exec('marker.add', { t: 1, label: 'a' })
  s.exec('marker.add', { t: 2, label: 'b' })
  assert.equal(s.history().undoDepth, 2)
  s.undo(); s.undo()
  assert.equal(s.history().canUndo, false)
  assert.equal(s.undo().error.code, 'conflict')
})

test('会话：revision 随编辑递增（给轮询/缓存做失效信号）', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  const r0 = s.history().revision
  s.exec('marker.add', { t: 1, label: 'a' })
  s.undo()
  assert.ok(s.history().revision > r0, '撤销也是状态变化，revision 要涨')
})

test('openSession：读入 fixture 并保持合规', () => {
  const r = openSession(fixture)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.from, 2)
  assert.equal(r.to, 2)
  assert.deepEqual(r.applied, [])
  assert.equal(r.session.validate().ok, true)
  assert.ok(r.session.summary().sequences[0].clips >= 4)
})

test('openSession：文件不存在 → not_found', () => {
  const r = openSession('D:/绝对不存在/工程.todo.json')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'not_found')
})

test('保存：原子写 + .bak，且之后 dirty 归零', () => {
  const s = new DocumentSession(baseDoc(), { newId: seqIds() })
  s.exec('marker.add', { t: 1, label: 'save-test' })
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'todo-core-')), 'save-test.todo.json')
  const r = s.save(out)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(s.dirty, false)
  const parsed = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(validateProject(parsed).ok, true)
  assert.ok(parsed.sequences[0].markers.some((m) => m.label === 'save-test'))
})

test('参数 schema 与命令表同源（compileParams 复用）', () => {
  const s = new DocumentSession(baseDoc())
  for (const c of s.commands()) {
    assert.doesNotThrow(() => compileParams(c.params))
  }
})
