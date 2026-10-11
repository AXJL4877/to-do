/**
 * 工程规范校验器测试（node:test，零依赖）。
 * 运行: node --test server/spec/
 *
 * 这些用例是「不变量」的可执行版本：谁改坏了交叉引用/悬空 id/派生镜像，这里会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSpec, summarizeProject, validateProject } from './projectSpec.mjs'

const minimal = () => ({
  version: 2,
  projectName: '测试',
  settings: { width: 1920, height: 1080, fps: 30, canvasBg: 'black' },
  media: [
    { id: 'm1', kind: 'video', name: 'a.mp4', relPath: 'media/a.mp4', duration: 10 },
  ],
  folders: [],
  sequences: [{
    id: 's1', name: '序列 1',
    tracks: [{ id: 't1', kind: 'video' }, { id: 't2', kind: 'audio' }],
    clips: [{
      id: 'c1', trackId: 't1', mediaId: 'm1', name: 'a', start: 0, duration: 5, inPoint: 0, outPoint: 5,
    }],
    markers: [], workIn: 0, workOut: 5,
  }],
  activeSeqId: 's1',
})

test('detectSpec 识别 v2 裸整数与 spec 字符串', () => {
  assert.equal(detectSpec({ version: 2 }), 'todo-project/2')
  assert.equal(detectSpec({ spec: 'todo-project/3' }), 'todo-project/3')
  assert.equal(detectSpec({ version: 7 }), 'todo-project/v7')
  assert.equal(detectSpec(null), 'unknown')
})

test('最小合法工程：ok，且统计正确', () => {
  const r = validateProject(minimal())
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.stats, { seqCount: 1, trackCount: 2, clipCount: 1, mediaCount: 1, productionCount: 0 })
})

test('缺画布规格 → bad_canvas / missing_settings', () => {
  const doc = minimal()
  delete doc.settings
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.code === 'missing_settings'))
})

test('activeSeqId 悬空 → dangling_active_seq（实测踩过的坑）', () => {
  const doc = minimal()
  doc.activeSeqId = 'seq_不存在'
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  const e = r.errors.find((x) => x.code === 'dangling_active_seq')
  assert.ok(e, JSON.stringify(r.errors))
  assert.equal(e.path, '$.activeSeqId')
  assert.ok(e.hint, '必须给人话修复建议')
})

test('片段指向不存在的轨道/媒体 → orphan_track / orphan_media', () => {
  const doc = minimal()
  doc.sequences[0].clips[0].trackId = 't_nope'
  doc.sequences[0].clips[0].mediaId = 'm_nope'
  const r = validateProject(doc)
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('orphan_track'), String(codes))
  assert.ok(codes.includes('orphan_media'), String(codes))
})

test('时长非法与出点早于入点 → bad_clip_time', () => {
  const doc = minimal()
  doc.sequences[0].clips[0].duration = 0
  doc.sequences[0].clips[0].inPoint = 4
  doc.sequences[0].clips[0].outPoint = 2
  const r = validateProject(doc)
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.filter((c) => c === 'bad_clip_time').length >= 2, String(codes))
})

test('派生镜像漂移只报警告，不判错（权威在片段自身）', () => {
  const doc = minimal()
  doc.sequences[0].clips[0].meta = { absIn: 0, absOut: 99, start: 0, duration: 5 }
  const r = validateProject(doc)
  assert.equal(r.ok, true)
  const w = r.warnings.find((x) => x.code === 'meta_mirror_drift')
  assert.ok(w, JSON.stringify(r.warnings))
  assert.match(w.path, /meta\.absOut/)
})

test('同轨重叠 → track_overlap 警告', () => {
  const doc = minimal()
  doc.sequences[0].clips.push({ id: 'c2', trackId: 't1', mediaId: 'm1', name: 'b', start: 3, duration: 4, inPoint: 0, outPoint: 4 })
  const r = validateProject(doc)
  assert.ok(r.warnings.some((w) => w.code === 'track_overlap'))
})

test('素材既无 relPath 也无 path → media_no_ref（工程搬不走的隐患）', () => {
  const doc = minimal()
  doc.media[0].relPath = undefined
  const r = validateProject(doc)
  assert.ok(r.warnings.some((w) => w.code === 'media_no_ref'))
})

test('重复 id → duplicate_id', () => {
  const doc = minimal()
  doc.media.push({ id: 'm1', kind: 'image', name: 'dup.png', relPath: 'media/dup.png', duration: 0 })
  const r = validateProject(doc)
  assert.ok(r.errors.some((e) => e.code === 'duplicate_id'))
})

test('未知顶层字段 → unknown_key 警告（向前兼容，不判错）', () => {
  const r = validateProject({ ...minimal(), 将来字段: 1 })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.code === 'unknown_key'))
})

test('summarizeProject 给出可规划编辑的结构', () => {
  const s = summarizeProject(minimal())
  assert.equal(s.ok, true)
  assert.equal(s.spec, 'todo-project/2')
  assert.deepEqual(s.canvas, { width: 1920, height: 1080, fps: 30, background: 'black' })
  assert.equal(s.sequences[0].duration, 5)
  assert.equal(s.sequences[0].clipsByMediaKind.video, 1)
  assert.equal(s.sequences[0].tracks[0].clips, 1)
  assert.equal(s.media.total, 1)
})
