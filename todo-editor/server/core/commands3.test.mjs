/**
 * timeline.set_clip_starts 测试：重叠策略是**文档规则**，必须被证明。
 *   reject（默认，给智能体）：拒绝并指名"和谁撞了、怎么改"
 *   push（给拖拽）：同轨后面的片段往后推，不留重叠
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyCommand } from './commands.mjs'
import { validateProject } from '../spec/projectSpec.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'spec', '__fixtures__', 'minimal.todo.json')

/** 造一条干净的轨道：A(0~2) B(3~5)，两者不重叠 */
const docWith = () => {
  const doc = JSON.parse(readFileSync(fixture, 'utf8'))
  doc.sequences[0].clips = [
    { id: 'A', trackId: 'tr_v1', start: 0, duration: 2, inPoint: 0, outPoint: 2, name: 'A', enabled: true },
    { id: 'B', trackId: 'tr_v1', start: 3, duration: 2, inPoint: 0, outPoint: 2, name: 'B', enabled: true },
  ]
  return doc
}
const run = (doc, args) => applyCommand(doc, 'timeline.set_clip_starts', args, { newId: (p) => `${p}_t` })

test('reject（默认）：重叠时拒绝，并指名撞上了谁、怎么改', () => {
  const r = run(docWith(), { moves: [{ clipId: 'B', start: 1 }] })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /会和「A」/)
  assert.match(r.error.message, /overlap:"push"/, '要告诉调用方怎么改')
})

test('reject：不重叠时正常摆放', () => {
  const r = run(docWith(), { moves: [{ clipId: 'B', start: 6 }] })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.doc.sequences[0].clips.find((c) => c.id === 'B').start, 6)
  assert.equal(validateProject(r.doc).ok, true)
})

test('push：把同轨后面的片段往后推，且不产生重叠', () => {
  const r = run(docWith(), { moves: [{ clipId: 'B', start: 1 }], overlap: 'push' })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const clips = r.doc.sequences[0].clips
  const a = clips.find((c) => c.id === 'A')
  const b = clips.find((c) => c.id === 'B')
  assert.equal(a.start, 0, 'A 不动')
  assert.equal(b.start, 2, 'B 被推到 A 的结束处（2s）')
  assert.ok(b.start >= a.start + a.duration - 1e-6, '不得重叠')
  assert.equal(validateProject(r.doc).ok, true, '推开后必须合规')
  // changed 只报**真的动了**的片段：A 没动，B 既是被移动的也是被推的（集合去重）
  assert.deepEqual(r.changed, ['B'], '只在 changed 里报真的动了的片段')
})

test('push：整条轨道从左到右归一化（被移动的片段自己也可能被推）', () => {
  const doc = docWith()
  doc.sequences[0].clips.push({ id: 'C', trackId: 'tr_v1', start: 6, duration: 2, inPoint: 0, outPoint: 2, name: 'C', enabled: true })
  // 把 C 拖到 1s：它落在 A(0~2) 里面 —— 规则是"整条轨道归一化"，
  // 所以 C 自己先被推到 2s，随后 B(3~5) 又撞上 C 的尾巴被推到 4s。
  const r = run(doc, { moves: [{ clipId: 'C', start: 1 }], overlap: 'push' })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const clips = r.doc.sequences[0].clips
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]))
  assert.equal(byId.A.start, 0, 'A 在最前面，不动')
  assert.equal(byId.C.start, 2, 'C 被 A 推到 2s')
  assert.equal(byId.B.start, 4, 'B 被 C 的尾巴推到 4s')
  assert.equal(validateProject(r.doc).ok, true)
  assert.deepEqual([...r.changed].sort(), ['B', 'C'], '谁动了就报谁（顺序不保证，调用方按集合用）')
})

test('目标位置为负 → 拒绝（人话原因）', () => {
  const r = run(docWith(), { moves: [{ clipId: 'A', start: -2 }] })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /为负/)
})

test('不存在的片段 → 拒绝并列出', () => {
  const r = run(docWith(), { moves: [{ clipId: 'nope', start: 1 }] })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /nope/)
})

test('跨类型换轨 → 拒绝', () => {
  const doc = docWith()
  doc.sequences[0].tracks.push({ id: 'tr_a1', kind: 'audio', name: 'A1' })
  const r = run(doc, { moves: [{ clipId: 'A', start: 0, trackId: 'tr_a1' }] })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /不能移到/)
})

test('非法 overlap 值 → bad_request（参数闭集生效）', () => {
  const r = run(docWith(), { moves: [{ clipId: 'A', start: 0 }], overlap: '随便' })
  assert.equal(r.error.code, 'bad_request')
})
