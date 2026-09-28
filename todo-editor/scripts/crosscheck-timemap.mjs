/**
 * B1.2c：JS mediaTimeCore vs C++ media_time，最大误差 < 1e-9。
 *   node scripts/crosscheck-timemap.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mediaTimeCore } from './lib/timemapSample.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const engine = resolve(root, 'native/bin/todo-media-engine.exe')
if (!existsSync(engine)) throw new Error(`缺少引擎: ${engine}`)

const SPEEDS = [0.05, 0.5, 1, 1.5, 2, 4]
const N_GROUPS = 500
const N_TIMES = 100
const TOL = 1e-9

function mulberry32(a) {
  return function next() {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(0xb12c71e0)

function makeGroup(gi) {
  const start = rnd() < 0.5 ? 0 : rnd() * 3
  const duration = 0.5 + rnd() * 5
  const inPoint = rnd() * 2
  const speed = SPEEDS[Math.floor(rnd() * SPEEDS.length)]
  const reverse = rnd() < 0.5
  let outPoint
  const outMode = Math.floor(rnd() * 3) // 0 valid, 1 equal, 2 missing(-1)
  if (outMode === 0) outPoint = inPoint + duration * speed
  else if (outMode === 1) outPoint = inPoint // <= in
  else outPoint = -1

  const clip = {
    id: `g${gi}`,
    trackId: 'v1',
    name: 'x',
    start,
    duration,
    inPoint,
    outPoint,
    enabled: true,
    speed,
    reverse,
    speedKeyframes: [],
    transform: {},
    color: {},
    audio: {},
    effects: [],
    blend: 'normal',
    keyframes: {},
  }
  if (rnd() < 0.4) {
    clip.freeze = rnd() < 0.15 ? 0 : inPoint + rnd() * 2
  }

  const times = []
  for (let i = 0; i < N_TIMES; i++) {
    if (i === 0) times.push(start - 0.2)
    else if (i === 1) times.push(start)
    else if (i === 2) times.push(start + duration / 2)
    else if (i === 3) times.push(start + duration - 1e-6)
    else if (i === 4) times.push(start + duration + 0.5)
    else times.push(start + rnd() * duration)
  }
  return { clip, times }
}

function cppEval(clip, times) {
  const payload = {
    clip: {
      start: clip.start,
      duration: clip.duration,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      speed: clip.speed,
      reverse: clip.reverse,
    },
    times,
  }
  if (clip.freeze !== undefined) payload.clip.freeze = clip.freeze
  const r = spawnSync(engine, ['timemap-eval'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  let j
  try { j = JSON.parse(line) } catch {
    throw new Error(`timemap-eval 非 JSON: ${line.slice(0, 300)} err=${(r.stderr || '').slice(0, 200)}`)
  }
  if (!j.ok || !Array.isArray(j.values)) throw new Error(`timemap-eval 失败: ${line}`)
  return j.values
}

let maxAbs = 0
let compared = 0

for (let g = 0; g < N_GROUPS; g++) {
  const { clip, times } = makeGroup(g)
  const js = times.map((t) => mediaTimeCore(clip, t))
  const cpp = cppEval(clip, times)
  if (cpp.length !== js.length) throw new Error(`len mismatch ${g}`)
  for (let i = 0; i < js.length; i++) {
    const d = Math.abs(js[i] - cpp[i])
    compared++
    if (d > maxAbs) maxAbs = d
    if (d >= TOL) {
      console.error('FAIL', { g, i, t: times[i], js: js[i], cpp: cpp[i], d, clip })
      process.exit(1)
    }
  }
}

console.log(`crosscheck-timemap OK：${N_GROUPS} groups × ${N_TIMES} times = ${compared} 点`)
console.log(`maxAbsErr=${maxAbs.toExponential(3)} (< ${TOL})`)
