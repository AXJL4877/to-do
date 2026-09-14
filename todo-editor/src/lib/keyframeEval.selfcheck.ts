/** 自检：贝塞尔关键帧采样端点与中点 */
import { sampleBezierSegment, sampleKeyframes, defaultHandles } from './keyframeEval'
import type { Keyframe } from '../types'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const a: Keyframe = { id: 'a', t: 0, value: 0, ease: 'bezier', oh: { x: 1 / 3, y: 1 / 3 } }
const b: Keyframe = { id: 'b', t: 1, value: 10, ease: 'bezier', ih: { x: -1 / 3, y: -1 / 3 } }

assert(Math.abs(sampleBezierSegment(a, b, 0) - 0) < 1e-6, 'start')
assert(Math.abs(sampleBezierSegment(a, b, 1) - 10) < 1e-6, 'end')
const mid = sampleBezierSegment(a, b, 0.5)
assert(Math.abs(mid - 5) < 0.15, `linearish mid got ${mid}`)

const holdA: Keyframe = { id: 'h0', t: 0, value: 2, ease: 'hold' }
const holdB: Keyframe = { id: 'h1', t: 1, value: 9, ease: 'linear' }
assert(sampleKeyframes([holdA, holdB], 0.4, 0) === 2, 'hold')

const linA: Keyframe = { id: 'l0', t: 0, value: 0, ease: 'linear' }
const linB: Keyframe = { id: 'l1', t: 1, value: 10, ease: 'linear' }
assert(Math.abs(sampleKeyframes([linA, linB], 0.5, 0) - 5) < 1e-6, 'linear mid')

const d = defaultHandles('easeInOut')
assert(d.oh.x > 0 && d.ih.x < 0, 'default handles')

console.log('keyframeEval self-check ok')
