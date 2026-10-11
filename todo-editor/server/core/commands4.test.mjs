/**
 * timeline.trim_to 测试。修剪的语义是"把某一侧移到指定位置"，而不是"移动多少秒"——
 * 因为 UI 已经吸附出精确位置，命令只负责按确定规则落位。
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

const docWith = (clips) => {
  const doc = JSON.parse(readFileSync(fixture, 'utf8'))
  doc.sequences[0].clips = clips
  return doc
}
// 合成片段必须带**一致的 meta 镜像**：校验器的同轨重叠检查读的是派生字段，
// 只造 clips 会得到"看起来没重叠"的文档 —— 那是 fixture 假象，不是闸门失效。
const clip = (id, start, duration, extra = {}) => ({
  id, trackId: 'tr_v1', start, duration, inPoint: 0, outPoint: duration, name: id, enabled: true,
  meta: {
    absIn: start, absOut: start + duration, start, duration, end: start + duration,
    inPoint: 0, outPoint: duration, trackId: 'tr_v1', trackName: 'V1', trackKind: 'video',
    enabled: true, trackHidden: false, trackMuted: false, visible: true,
  },
  ...extra,
})
const run = (doc, args) => applyCommand(doc, 'timeline.trim_to', args, { newId: (p) => p + '_t' })

test('out 边：拉长到指定位置，出点跟着走', () => {
  const r = run(docWith([clip('A', 0, 2)]), { clipId: 'A', edge: 'out', at: 5 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const a = r.doc.sequences[0].clips[0]
  assert.equal(a.duration, 5)
  assert.equal(a.outPoint, 5, '出点 = 入点 + 时长')
  assert.equal(a.start, 0)
  assert.equal(validateProject(r.doc).ok, true)
})

test('in 边：右移会同时推 start 与入点，出点不动', () => {
  const r = run(docWith([clip('A', 0, 6, { inPoint: 10, outPoint: 16 })]), { clipId: 'A', edge: 'in', at: 2 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const a = r.doc.sequences[0].clips[0]
  assert.equal(a.start, 2)
  assert.equal(a.duration, 4)
  assert.equal(a.inPoint, 12)
  assert.equal(a.outPoint, 16, '出点不该被 in 边影响')
})

test('修到长度 ≤ 0 → 拒绝（带当前区间）', () => {
  const r = run(docWith([clip('A', 0, 4)]), { clipId: 'A', edge: 'out', at: 0 })
  assert.equal(r.error.code, 'conflict')
  assert.match(r.error.message, /长度 ≤ 0/)
})

test('clamp：拉长时被邻居夹住，并如实报告"被夹"', () => {
  const doc = docWith([clip('A', 0, 2), clip('B', 3, 2)])
  const r = run(doc, { clipId: 'A', edge: 'out', at: 5, overlap: 'clamp' })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const a = r.doc.sequences[0].clips.find((c) => c.id === 'A')
  assert.equal(a.duration, 3, '夹到 B 的起点 3s')
  assert.match(r.summary, /被夹到邻居边界/)
  assert.equal(validateProject(r.doc).ok, true)
})

test('clamp：起点侧被前一个邻居夹住', () => {
  const doc = docWith([clip('X', 0, 2), clip('A', 4, 4)])
  const r = run(doc, { clipId: 'A', edge: 'in', at: 1, overlap: 'clamp' })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const a = r.doc.sequences[0].clips.find((c) => c.id === 'A')
  assert.equal(a.start, 2, '夹到 X 的终点 2s')
})

test('linked：联动的音视频一起修剪', () => {
  const doc = docWith([
    clip('V', 0, 4, { linkedId: 'AU' }),
    { ...clip('AU', 0, 4, { linkedId: 'V' }), trackId: 'tr_a1' },
  ])
  doc.sequences[0].tracks.push({ id: 'tr_a1', kind: 'audio', name: 'A1' })
  const r = run(doc, { clipId: 'V', edge: 'out', at: 3 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual([...r.changed].sort(), ['AU', 'V'])
  assert.equal(r.doc.sequences[0].clips.find((c) => c.id === 'AU').duration, 3, '声音也修到 3s')
})

test('linked:false：只修被点名的那个', () => {
  const doc = docWith([clip('V', 0, 4, { linkedId: 'AU' })])
  const r = run(doc, { clipId: 'V', edge: 'out', at: 3, linked: false })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.changed, ['V'])
})

test('reject（默认）：与邻居重叠 → 被写入闸门拦住（不产生非法工程）', () => {
  const doc = docWith([clip('A', 0, 2), clip('B', 3, 2)])
  const r = run(doc, { clipId: 'A', edge: 'out', at: 4 })
  assert.equal(r.ok, false)
  assert.match(String(r.error.code), /conflict|bad_request/)
})
