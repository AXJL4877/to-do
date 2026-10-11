/**
 * OTIO 互操作测试。重点验三件事：
 *   1) 顺序模型转换正确：空档变 Gap、位置能累加回来（往返无损）
 *   2) **有损的地方必须被说出来**（同轨重叠、轨道类型折叠、标记丢弃）——
 *      "能转换"不等于"没丢东西"，导出工具最不该做的事就是静默丢数据
 *   3) schema 标签与有理时间符合 OTIO 规范
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OTIO_SCHEMA, fromOtio, toOtio } from './otio.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'spec', '__fixtures__', 'minimal.todo.json')

const docWith = ({ fps = 30, clips = [], tracks = null, media = null, markers = [] } = {}) => {
  const doc = JSON.parse(readFileSync(fixture, 'utf8'))
  doc.settings.fps = fps
  doc.sequences[0].tracks = tracks ?? [{ id: 'tr_v1', kind: 'video', name: 'V1' }]
  doc.sequences[0].clips = clips
  doc.sequences[0].markers = markers
  if (media) doc.media = media
  return doc
}
const clip = (id, start, duration, extra = {}) => ({
  id, trackId: 'tr_v1', start, duration, inPoint: 0, outPoint: duration, name: id, enabled: true, ...extra,
})

test('schema 标签与有理时间符合 OTIO 规范', () => {
  const doc = docWith({ clips: [clip('A', 0, 2)] })
  const { otio } = toOtio(doc)
  assert.equal(otio.OTIO_SCHEMA, 'Timeline.1')
  assert.equal(otio.tracks.OTIO_SCHEMA, 'Stack.1')
  const track = otio.tracks.children[0]
  assert.equal(track.OTIO_SCHEMA, 'Track.1')
  assert.equal(track.kind, 'Video')
  const c = track.children[0]
  assert.equal(c.OTIO_SCHEMA, 'Clip.1')
  assert.equal(c.source_range.OTIO_SCHEMA, 'TimeRange.1')
  assert.equal(c.source_range.duration.OTIO_SCHEMA, 'RationalTime.1')
  assert.equal(c.source_range.duration.rate, 30, '帧率要写进 RationalTime')
  assert.equal(c.source_range.duration.value, 60, '2s @30fps = 60 帧')
})

test('29.97 帧率写成有理数（不是 29.97）', () => {
  const doc = docWith({ fps: 29.97, clips: [clip('A', 0, 1)] })
  const { otio } = toOtio(doc)
  assert.equal(otio.metadata.todo.rate, 30000 / 1001)
  // 1s @30000/1001 ≈ 29.97 帧 → 取整 30
  assert.equal(otio.tracks.children[0].children[0].source_range.duration.value, 30)
})

test('空档变成 Gap，位置由顺序隐含', () => {
  const doc = docWith({ clips: [clip('A', 0, 1), clip('B', 2, 1)] })
  const { otio, lossy } = toOtio(doc)
  const kids = otio.tracks.children[0].children
  assert.equal(kids.length, 3, 'Clip + Gap + Clip')
  assert.equal(kids[1].OTIO_SCHEMA, 'Gap.1')
  assert.equal(kids[1].source_range.duration.value, 30, '1s 的空档 = 30 帧')
  assert.deepEqual(lossy, [], '不重叠、无特殊轨道时不该有损')
})

test('往返：起点/时长/入出点都能还原', () => {
  const doc = docWith({
    media: [
      { id: 'm1', kind: 'video', name: 'v.mp4', relPath: 'ai-generated/v.mp4', path: 'D:/p/v.mp4', duration: 10 },
      { id: 'm2', kind: 'video', name: 'w.mp4', relPath: 'ai-generated/w.mp4', path: 'D:/p/w.mp4', duration: 10 },
    ],
    clips: [
      { ...clip('A', 0, 2), mediaId: 'm1', inPoint: 1, outPoint: 3 },
      { ...clip('B', 2.5, 1.5), mediaId: 'm2', inPoint: 4, outPoint: 5.5 },
    ],
  })
  const { otio } = toOtio(doc)
  const { sequence } = fromOtio(otio, { media: doc.media })
  const a = sequence.clips.find((c) => c.id === 'A')
  const b = sequence.clips.find((c) => c.id === 'B')
  assert.equal(a.start, 0)
  assert.equal(a.duration, 2)
  assert.equal(a.inPoint, 1, '入点要还原')
  assert.equal(a.outPoint, 3)
  assert.equal(b.start, 2.5, 'Gap 累加后 B 的起点要正确')
  assert.equal(b.duration, 1.5)
  assert.equal(b.mediaId, 'm2', '按 target_url 找回 mediaId')
  assert.equal(sequence.tracks[0].id, 'tr_v1', '轨道 id 从 metadata 还原')
})

test('同轨重叠：被压平，但**必须**出现在 lossy 里', () => {
  const doc = docWith({ clips: [clip('A', 0, 2), clip('B', 1, 2)] })
  const { lossy } = toOtio(doc)
  const overlap = lossy.find((l) => l.code === 'track_overlap')
  assert.ok(overlap, '重叠不能静默消失')
  assert.match(overlap.message, /重叠/)
  assert.ok(overlap.path.includes('B'), '要指出是哪一条片段')
})

test('轨道类型折叠：subtitle → Video，但记进 lossy 且原名留在 metadata', () => {
  const doc = docWith({
    tracks: [{ id: 'tr_v1', kind: 'video', name: 'V1' }, { id: 'tr_s1', kind: 'subtitle', name: '字幕' }],
    clips: [clip('A', 0, 1)],
  })
  const { otio, lossy } = toOtio(doc)
  const sub = otio.tracks.children.find((t) => t.name === '字幕')
  assert.equal(sub.kind, 'Video')
  assert.equal(sub.metadata.todo.trackKind, 'subtitle')
  assert.ok(lossy.some((l) => l.code === 'track_kind_folded'))
})

test('标记未导出 → 如实报告', () => {
  const doc = docWith({ clips: [clip('A', 0, 1)], markers: [{ id: 'mk', t: 0.5, label: '看这里' }] })
  const { lossy } = toOtio(doc)
  assert.ok(lossy.some((l) => l.code === 'markers_dropped' && /1 个标记/.test(l.message)))
})

test('素材引用用 relPath（可搬走），不是绝对路径', () => {
  const doc = docWith({
    media: [{ id: 'm1', kind: 'video', name: 'v', relPath: 'ai-generated/v.mp4', path: 'D:/绝对/路径/v.mp4', duration: 5 }],
    clips: [{ ...clip('A', 0, 1), mediaId: 'm1' }],
  })
  const { otio } = toOtio(doc)
  const ref = otio.tracks.children[0].children[0].media_reference
  assert.equal(ref.OTIO_SCHEMA, 'ExternalReference.1')
  assert.equal(ref.target_url, 'ai-generated/v.mp4', '优先用 relPath（与不变量 I1 一致）')
})

test('没有序列 → 明确报错而不是空导出', () => {
  const { otio, lossy } = toOtio({ sequences: [] })
  assert.equal(otio, null)
  assert.equal(lossy[0].code, 'no_sequence')
})

test('fromOtio：不是 OTIO 的输入要报 bad_otio', () => {
  const { sequence, lossy } = fromOtio({ foo: 1 })
  assert.equal(sequence, null)
  assert.equal(lossy[0].code, 'bad_otio')
})

test('fromOtio：未支持的元素被跳过并报告', () => {
  const otio = {
    OTIO_SCHEMA: 'Timeline.1', name: 't',
    tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Transition.1' }] }] },
  }
  const { sequence, lossy } = fromOtio(otio)
  assert.equal(sequence.clips.length, 0)
  assert.ok(lossy.some((l) => l.code === 'item_dropped'))
})

test('往返后再次导出：结构稳定（幂等）', () => {
  const doc = docWith({
    media: [{ id: 'm1', kind: 'video', name: 'v', relPath: 'a/v.mp4', path: 'D:/a/v.mp4', duration: 10 }],
    clips: [{ ...clip('A', 0, 2), mediaId: 'm1' }, { ...clip('B', 3, 1), mediaId: 'm1' }],
  })
  const first = toOtio(doc).otio
  const back = fromOtio(first, { media: doc.media }).sequence
  const doc2 = { ...doc, sequences: [{ ...doc.sequences[0], ...back, id: doc.sequences[0].id }] }
  const second = toOtio(doc2).otio
  const shape = (o) => o.tracks.children.map((t) => t.children.map((c) => `${c.OTIO_SCHEMA}:${c.source_range?.duration?.value ?? '-'}`).join('|')).join('#')
  assert.equal(shape(second), shape(first), '往返后再导出应当结构一致')
})
