import assert from 'node:assert/strict'
import { defaultAudio, defaultColor, defaultTransform, defaultScene3d, type Clip, type Sequence, type Track } from '../src/types'
import * as tidy from '../src/lib/timelineTidy'
import { pictureClipsAt, audibleClipsAt, videoNeedsDirectAudio } from '../src/lib/programPlayer'
import { clipsOverlappingRange, upcomingClips } from '../src/lib/sequenceIndex'
import { buildEditGraph } from '../src/lib/editGraph'

const track = (id: string, props: Partial<Track> = {}): Track => ({ id, name: id, kind: 'video', locked: false, muted: false, hidden: false, solo: false, height: 48, ...props })
const clip = (id: string, trackId: string, start: number, duration: number, props: Partial<Clip> = {}): Clip => ({ id, trackId, name: id, start, duration, inPoint: 0, outPoint: duration, enabled: true, speed: 1, reverse: false, speedKeyframes: [], transform: defaultTransform(), color: defaultColor(), audio: defaultAudio(), effects: [], keyframes: {}, blend: 'normal', ...props })
const seq = (tracks: Track[], clips: Clip[]): Sequence => ({ id: 'test', name: 'test', tracks, clips, markers: [], workIn: 0, workOut: 10, scene3d: defaultScene3d() })

assert.equal(typeof tidy.tidyTimeline, 'function', 'missing one-click track consolidation')
const run = tidy.tidyTimeline
const before = seq([track('top'), track('bottom'), track('a', { kind: 'audio' })], [clip('one', 'top', 0, 1), clip('two', 'bottom', 1, 2, { linkedId: 'sound' }), clip('sound', 'a', 1, 2)])
const after = run(before)
assert.deepEqual(after.tracks.map(t => t.id), ['top', 'a'])
assert.deepEqual(after.clips.map(c => [c.id, c.trackId, c.start, c.duration, c.linkedId]), [['one', 'top', 0, 1, undefined], ['two', 'top', 1, 2, 'sound'], ['sound', 'a', 1, 2, undefined]])
assert.equal(before.clips[1].trackId, 'bottom', 'input must remain intact for undo')
assert.equal(run(after), after, 'already tidy is a no-op')

// Empty space on the top track is not sufficient: moving low there would cover middle.
const layered = seq([track('top'), track('middle'), track('low')], [clip('top', 'top', 0, 1), clip('middle', 'middle', 0, 4), clip('low', 'low', 2, 2)])
assert.equal(run(layered).clips[2].trackId, 'low')
for (const prop of ['locked', 'muted', 'hidden', 'solo'] as const) {
  const protectedSeq = seq([track('top'), track('low', { [prop]: true })], [clip('one', 'top', 0, 1), clip('two', 'low', 2, 1)])
  assert.equal(run(protectedSeq).clips[1].trackId, 'low', prop)
}
const lockedTarget = seq([track('top', { locked: true }), track('low')], [clip('two', 'low', 2, 1)])
assert.equal(run(lockedTarget).clips[0].trackId, 'low')
const overlap = seq([track('top'), track('low')], [clip('one', 'top', 0, 2), clip('two', 'low', 1.9999999, 1)])
assert.equal(run(overlap).tracks.length, 2, 'sub-frame overlaps cannot be erased')
const mutedEmpty = seq([track('top'), track('empty', { muted: true }), track('locked', { locked: true })], [clip('one', 'top', 0, 1)])
assert.deepEqual(run(mutedEmpty).tracks.map(t => t.id), ['top', 'empty', 'locked'])
const chalk = clip('chalk', 'low', 0, 1, { mediaId: 'chalk-media', meta: { source: { chalk: {
  on: true, tip: [[0, 0, 0], [1, 1, 1]], frame: { width: 320, height: 180 },
  hand: { url: 'hand.png', mediaId: 'hand', width: 32, height: 32, tipX: 0, tipY: 0 },
} } } as any })
const chalkSeq = seq([track('top'), track('middle'), track('low')], [clip('middle', 'middle', 1, 1), chalk])
const chalkMedia = [{ id: 'chalk-media', width: 320, height: 180 }, { id: 'hand', width: 32, height: 32 }]
const expandedStack = (s: Sequence) => {
  const graph = buildEditGraph({ ...s, media: chalkMedia as any, settings: { width: 320, height: 180, fps: 30 } })
  return graph.clips.filter(c => c.start <= 1 && c.start + c.duration > 1)
    .sort((a, b) => graph.tracks.findIndex(t => t.id === a.trackId) - graph.tracks.findIndex(t => t.id === b.trackId)).map(c => c.id)
}
assert.deepEqual(expandedStack(chalkSeq), ['middle', 'chalk__chalkhand__'])
assert.deepEqual(expandedStack(run(chalkSeq, chalkMedia as any, { width: 320, height: 180, fps: 30 })), ['middle', 'chalk__chalkhand__'], 'lingering generated hand must remain below the middle clip at the cut')

// Preserve every simultaneous pair's relative track order, including disabled clips,
// across generated timelines. This is independent of the consolidation algorithm.
let seed = 123
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
for (let trial = 0; trial < 80; trial++) {
  const tracks = Array.from({ length: 8 }, (_, i) => track(`t${i}`))
  const clips = Array.from({ length: 35 }, (_, i) => clip(`c${i}`, `t${Math.floor(rand() * 8)}`, Math.floor(rand() * 20), 0.5 + rand() * 4, { enabled: rand() > 0.2 }))
  const original = seq(tracks, clips)
  const result = run(original)
  for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
    const a = clips[i], b = clips[j]
    if (a.start >= b.start + b.duration || b.start >= a.start + a.duration) continue
    const order = (s: Sequence) => Math.sign(s.tracks.findIndex(t => t.id === s.clips[i].trackId) - s.tracks.findIndex(t => t.id === s.clips[j].trackId))
    assert.equal(order(result), order(original), `layer order trial ${trial}, ${i}/${j}`)
  }
  assert.equal(run(result), result, 'tidy is idempotent')
}

const schedule = seq([track('v'), track('a', { kind: 'audio' }), track('hidden', { hidden: true })], [clip('long', 'v', 0, 100), clip('late', 'v', 8, 1), clip('early', 'v', 2, 1), clip('sound', 'a', 2, 4), clip('hidden', 'hidden', 0, 100), clip('disabled', 'v', 0, 100, { enabled: false })])
for (const t of [0, 2, 3, 8, 9, 100, 2.5, -1]) {
  const expected = schedule.clips.filter(c => c.enabled && t >= c.start && t < c.start + c.duration && c.trackId === 'v').map(c => c.id)
  assert.deepEqual(pictureClipsAt(schedule, t).map(c => c.id), expected)
}
assert.deepEqual(audibleClipsAt(schedule, 2).map(c => c.id), ['long', 'early', 'sound'])
assert.deepEqual(upcomingClips(schedule, 1, 7).map(c => c.id), ['early', 'sound', 'late'])
assert.deepEqual(clipsOverlappingRange(schedule, 3, 8).map(c => c.id), ['long', 'sound', 'hidden', 'disabled'])
const edited = { ...schedule, clips: schedule.clips.map(c => c.id === 'early' ? { ...c, start: 30 } : c) }
assert.deepEqual(pictureClipsAt(edited, 2).map(c => c.id), ['long'])
assert.deepEqual(pictureClipsAt({ ...schedule, tracks: schedule.tracks.map(t => ({ ...t, hidden: true })) }, 2), [])
const linked = seq([track('v'), track('a', { kind: 'audio' })], [clip('video', 'v', 0, 2, { mediaId: 'media' }), clip('audio', 'a', 0, 1, { linkedId: 'video' })])
const media: any[] = [{ id: 'media', kind: 'video', url: 'test.mp4', offline: false }]
assert.equal(videoNeedsDirectAudio(linked, linked.clips[0], 0.5, media), false, 'reverse link must suppress duplicate audio')
assert.equal(videoNeedsDirectAudio(linked, linked.clips[0], 1.5, media), true, 'expired partner must restore video audio')
assert.equal(videoNeedsDirectAudio(linked, linked.clips[0], 1.5, [{ ...media[0], offline: true }]), false, 'media replacement invalidates lookup')

// Warm queries must not read the timing of all 10k inactive clips every frame.
let reads = 0
const many = seq([track('v')], Array.from({ length: 10000 }, (_, i) => {
  const c = clip(`c${i}`, 'v', i * 2, 1)
  Object.defineProperty(c, 'start', { get() { reads++; return i * 2 } })
  return c
}))
pictureClipsAt(many, 0)
reads = 0
assert.deepEqual(pictureClipsAt(many, 1234).map(c => c.id), ['c617'])
assert.ok(reads < 100, `warm query scanned ${reads} clip start times`)
const benchmark = seq(Array.from({ length: 100 }, (_, i) => track(`t${i}`)), Array.from({ length: 10000 }, (_, i) => clip(`b${i}`, `t${i % 100}`, i * 0.5, 0.5)))
pictureClipsAt(benchmark, 0)
const times = Array.from({ length: 1200 }, (_, i) => (i * 13) % 4999)
const measure = (fn: (t: number) => Clip[]) => {
  let count = 0
  const start = performance.now()
  for (const t of times) count += fn(t).length
  return { ms: +(performance.now() - start).toFixed(2), count }
}
const originalTiming = measure(t => benchmark.clips.filter(c => c.enabled && t >= c.start && t < c.start + c.duration
  && benchmark.tracks.find(tr => tr.id === c.trackId && !tr.hidden && tr.kind !== 'audio')))
const indexedTiming = measure(t => pictureClipsAt(benchmark, t))
assert.equal(indexedTiming.count, originalTiming.count)
const tidyStart = performance.now()
assert.equal(run(benchmark).tracks.length, 1)
console.log(JSON.stringify({ clips: 10000, queries: times.length, fullScan: originalTiming, indexed: indexedTiming, tidyMs: +(performance.now() - tidyStart).toFixed(2) }))
console.log('Timeline consolidation, layer invariants, preview scheduling and warm-query complexity passed')
