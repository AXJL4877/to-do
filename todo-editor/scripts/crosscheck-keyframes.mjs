/**
 * B1.2b：JS sampleKeyframes vs C++ kf-eval，最大误差 < 1e-6。
 *   node scripts/crosscheck-keyframes.mjs
 * JS 侧用 scripts/lib/keyframeSample.mjs（与 keyframeEval.ts 公式同步）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sampleKeyframes, defaultHandles } from './lib/keyframeSample.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const engine = resolve(root, 'native/bin/todo-media-engine.exe')
if (!existsSync(engine)) throw new Error(`缺少引擎: ${engine}`)

const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'bezier']
const N_GROUPS = 200
const N_TIMES = 100
const TOL = 1e-6

function mulberry32(a) {
  return function next() {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(0xb12b0e12)

function randEase() {
  return EASES[Math.floor(rnd() * EASES.length)]
}

function makeGroup(gi) {
  const n = 2 + Math.floor(rnd() * 4) // 2..5 keys
  const kfs = []
  let t = 0
  for (let i = 0; i < n; i++) {
    t += i === 0 ? 0 : 0.05 + rnd() * 0.8
    const ease = randEase()
    const k = {
      id: `g${gi}_${i}`,
      t,
      value: (rnd() - 0.5) * 4,
      ease,
    }
    if (ease === 'bezier' || rnd() < 0.35) {
      const d = defaultHandles(ease === 'bezier' ? 'easeInOut' : ease)
      k.oh = { x: d.oh.x, y: d.oh.y }
      k.ih = { x: d.ih.x, y: d.ih.y }
    }
    kfs.push(k)
  }
  const t0 = kfs[0].t
  const t1 = kfs[kfs.length - 1].t
  const span = Math.max(1e-3, t1 - t0)
  const times = []
  for (let i = 0; i < N_TIMES; i++) {
    // 覆盖端点外一点、端点、中间
    if (i === 0) times.push(t0 - 0.1)
    else if (i === 1) times.push(t0)
    else if (i === 2) times.push(t1)
    else if (i === 3) times.push(t1 + 0.1)
    else times.push(t0 + rnd() * span)
  }
  // 偶尔塞入相同 t
  if (rnd() < 0.2 && kfs.length >= 2) {
    kfs[1] = { ...kfs[1], t: kfs[0].t }
  }
  return { kfs, times, fallback: (rnd() - 0.5) * 2 }
}

function cppEval(kfs, times, fallback) {
  const payload = JSON.stringify({
    keyframes: kfs.map(({ t, value, ease, oh, ih }) => {
      const o = { t, value }
      if (ease && ease !== 'linear') o.ease = ease
      else if (ease) o.ease = ease
      if (oh) o.oh = oh
      if (ih) o.ih = ih
      return o
    }),
    times,
    fallback,
  })
  const r = spawnSync(engine, ['kf-eval'], {
    input: payload,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  let j
  try { j = JSON.parse(line) } catch {
    throw new Error(`kf-eval 非 JSON status=${r.status} out=${line.slice(0, 200)} err=${(r.stderr || '').slice(0, 200)}`)
  }
  if (!j.ok || !Array.isArray(j.values)) throw new Error(`kf-eval 失败: ${line}`)
  return j.values
}

let maxAbs = 0
let maxAt = null
let compared = 0

for (let g = 0; g < N_GROUPS; g++) {
  const { kfs, times, fallback } = makeGroup(g)
  const js = times.map((t) => sampleKeyframes(kfs, t, fallback))
  const cpp = cppEval(kfs, times, fallback)
  if (cpp.length !== js.length) throw new Error(`len mismatch group ${g}`)
  for (let i = 0; i < js.length; i++) {
    const d = Math.abs(js[i] - cpp[i])
    compared++
    if (d > maxAbs) {
      maxAbs = d
      maxAt = { g, i, t: times[i], js: js[i], cpp: cpp[i], kfs }
    }
    if (d >= TOL) {
      console.error('FAIL', { g, i, t: times[i], js: js[i], cpp: cpp[i], d, kfs })
      process.exit(1)
    }
  }
}

console.log(`crosscheck-keyframes OK：${N_GROUPS} groups × ${N_TIMES} times = ${compared} 点`)
console.log(`maxAbsErr=${maxAbs.toExponential(3)} (< ${TOL})`)
if (maxAt) console.log(`maxAt group=${maxAt.g} i=${maxAt.i} t=${maxAt.t}`)
