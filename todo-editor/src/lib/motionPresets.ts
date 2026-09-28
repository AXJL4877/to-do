import type { Clip, Ease, Keyframe } from '../types'
import { uid } from '../types'
import { sampleKeyframes, snapToFrame } from './keyframeEval'

export type MotionProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'
export type PresetGroup = 'loop' | 'in' | 'out' | 'emph'
export type ParamValue = number | string
export type ParamValues = Record<string, ParamValue>

export type ParamDef =
  | { key: string; label: string; type: 'range'; min: number; max: number; step: number; default: number; unit?: string }
  | { key: string; label: string; type: 'select'; default: string; options: { value: string; label: string }[] }

/** add：叠加到原值（位置 / 旋转）；mul：乘到原值（缩放 / 透明度），值为倍率 */
type Mode = 'add' | 'mul'
interface GenKey { t: number; v: number; ease: Ease }

type Channel =
  /** 随机抖动：每 1/rate 秒一个随机偏移 */
  | { kind: 'noise'; prop: MotionProp; amp: number; rate: number }
  /** 正弦往复：峰值处打点，easeInOut 连接；positive 时在 0 与 amp 之间；decay 让幅度随时间衰减到 0 */
  | { kind: 'osc'; prop: MotionProp; amp: number; freq: number; phase?: number; positive?: boolean; mode?: Mode; decay?: number; attack?: boolean; hard?: boolean }
  /** 周期形状：一个周期内的 (相位 0..1, 值, 缓动) 点列 */
  | { kind: 'cycle'; prop: MotionProp; period: number; shape: [number, number, Ease][]; mode?: Mode }
  /** 匀速累加（旋转） */
  | { kind: 'ramp'; prop: MotionProp; total: number }
  /** 函数曲线：u∈[0,1] → 偏移 / 倍率，按帧采样（入场 / 出场 / 强调） */
  | { kind: 'fn'; prop: MotionProp; f: (u: number) => number; mode?: Mode }

export interface MotionPreset {
  id: string
  name: string
  desc: string
  group: PresetGroup
  params: ParamDef[]
  build: (v: ParamValues) => Channel[]
}

export const PRESET_GROUPS: { id: PresetGroup; label: string }[] = [
  { id: 'loop', label: '循环' },
  { id: 'in', label: '入场' },
  { id: 'out', label: '出场' },
  { id: 'emph', label: '强调' },
]

// ---------- 缓动 ----------

function bounceOut(u: number) {
  const n1 = 7.5625, d1 = 2.75
  if (u < 1 / d1) return n1 * u * u
  if (u < 2 / d1) return n1 * (u -= 1.5 / d1) * u + 0.75
  if (u < 2.5 / d1) return n1 * (u -= 2.25 / d1) * u + 0.9375
  return n1 * (u -= 2.625 / d1) * u + 0.984375
}

const EASES: Record<string, (u: number) => number> = {
  out: (u) => 1 - Math.pow(1 - u, 3),
  smooth: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  back: (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2),
  elastic: (u) => (u <= 0 ? 0 : u >= 1 ? 1 : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
  bounce: bounceOut,
  linear: (u) => u,
}

const EASE_OPTIONS = [
  { value: 'out', label: '减速' },
  { value: 'smooth', label: '平滑' },
  { value: 'back', label: '回弹' },
  { value: 'elastic', label: '弹性' },
  { value: 'bounce', label: '弹跳' },
  { value: 'linear', label: '匀速' },
]

/** 入场进度 0→1 */
const easeIn = (v: ParamValues) => EASES[String(v.ease)] ?? EASES.out
/** 出场进度 0→1（入场曲线的时间镜像：先慢后快，回弹变为蓄力） */
const easeOut = (v: ParamValues) => {
  const e = easeIn(v)
  return (u: number) => 1 - e(1 - u)
}

// ---------- 参数模板 ----------

const num = (v: ParamValues, k: string) => Number(v[k])
/** 画面百分比 → 归一化坐标（画面半宽 = 1） */
const pct = (v: ParamValues, k: string) => num(v, k) / 50

const P = {
  dur: (d: number): ParamDef => ({ key: 'dur', label: '时长', type: 'range', min: 0.1, max: 3, step: 0.05, default: d, unit: 's' }),
  ease: (d = 'out'): ParamDef => ({ key: 'ease', label: '曲线', type: 'select', default: d, options: EASE_OPTIONS }),
  freq: (d: number, max = 6): ParamDef => ({ key: 'freq', label: '频率', type: 'range', min: 0.2, max, step: 0.1, default: d, unit: 'Hz' }),
  dist: (d: number, max = 30, label = '幅度'): ParamDef => ({ key: 'dist', label, type: 'range', min: 0.2, max, step: 0.1, default: d, unit: '%' }),
  angle: (d: number, max = 45, label = '角度'): ParamDef => ({ key: 'angle', label, type: 'range', min: 0, max, step: 0.5, default: d, unit: '°' }),
  fade: (d = 'on'): ParamDef => ({ key: 'fade', label: '淡入淡出', type: 'select', default: d, options: [{ value: 'on', label: '开' }, { value: 'off', label: '关' }] }),
  dir4: (d = 'left', label = '方向'): ParamDef => ({
    key: 'dir', label, type: 'select', default: d,
    options: [{ value: 'left', label: '左' }, { value: 'right', label: '右' }, { value: 'up', label: '上' }, { value: 'down', label: '下' }],
  }),
  spinDir: (): ParamDef => ({ key: 'spin', label: '方向', type: 'select', default: 'cw', options: [{ value: 'cw', label: '顺时针' }, { value: 'ccw', label: '逆时针' }] }),
}

function dirVec(dir: ParamValue): [number, number] {
  switch (dir) {
    case 'right': return [1, 0]
    case 'up': return [0, -1]
    case 'down': return [0, 1]
    default: return [-1, 0]
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function hashNoise(seed: string, i: number): number {
  let h = 2166136261 ^ i
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1
}

/** 分段平滑插值：[(u, 值)] */
function piecewise(u: number, pts: [number, number][]) {
  if (u <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    const [u1, v1] = pts[i]
    const [u0, v0] = pts[i - 1]
    if (u <= u1) {
      const s = (u - u0) / Math.max(1e-6, u1 - u0)
      return lerp(v0, v1, s * s * (3 - 2 * s))
    }
  }
  return pts[pts.length - 1][1]
}

const fadeInCh = (on: ParamValue, portion = 0.4): Channel[] =>
  on === 'on' ? [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => clamp01(u / portion) }] : []
const fadeOutCh = (on: ParamValue, portion = 0.4): Channel[] =>
  on === 'on' ? [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => clamp01((1 - u) / portion) }] : []

// ---------- 预设 ----------

const shakeParams = (amp: number, freq: number, rot: number): ParamDef[] => [
  P.dist(amp, 10),
  { key: 'freq', label: '频率', type: 'range', min: 2, max: 30, step: 1, default: freq, unit: 'Hz' },
  P.angle(rot, 10, '旋转抖'),
]
const shakeBuild = (v: ParamValues): Channel[] => [
  { kind: 'noise', prop: 'x', amp: pct(v, 'dist'), rate: num(v, 'freq') },
  { kind: 'noise', prop: 'y', amp: pct(v, 'dist'), rate: num(v, 'freq') },
  ...(num(v, 'angle') > 0 ? [{ kind: 'noise', prop: 'rotation', amp: num(v, 'angle'), rate: num(v, 'freq') } as Channel] : []),
]

export const MOTION_PRESETS: MotionPreset[] = [
  // ----- 循环 -----
  { id: 'shake', name: '抖动', desc: '轻微随机抖动', group: 'loop', params: shakeParams(1, 15, 0), build: shakeBuild },
  { id: 'quake', name: '剧烈震动', desc: '位置 + 旋转强震', group: 'loop', params: shakeParams(3, 22, 3), build: shakeBuild },
  {
    id: 'sway', name: '摇晃', desc: '绕锚点左右摇摆', group: 'loop',
    params: [P.angle(10), P.freq(2)],
    build: (v) => [{ kind: 'osc', prop: 'rotation', amp: num(v, 'angle'), freq: num(v, 'freq') }],
  },
  {
    id: 'swing', name: '来回平移', desc: '水平或垂直往返', group: 'loop',
    params: [P.dist(5), P.freq(1.5), { key: 'axis', label: '方向', type: 'select', default: 'x', options: [{ value: 'x', label: '水平' }, { value: 'y', label: '垂直' }] }],
    build: (v) => [{ kind: 'osc', prop: v.axis === 'y' ? 'y' : 'x', amp: pct(v, 'dist'), freq: num(v, 'freq') }],
  },
  {
    id: 'float', name: '漂浮', desc: '上下浮动 + 轻微倾斜', group: 'loop',
    params: [P.dist(2.5, 15), P.freq(0.8, 4), P.angle(2, 15, '倾斜')],
    build: (v) => [
      { kind: 'osc', prop: 'y', amp: pct(v, 'dist'), freq: num(v, 'freq') },
      { kind: 'osc', prop: 'rotation', amp: num(v, 'angle'), freq: num(v, 'freq') * 0.7, phase: 0.25 },
    ],
  },
  {
    id: 'bounce', name: '弹跳', desc: '原地向上弹起', group: 'loop',
    params: [P.dist(6, 30, '高度'), P.freq(2)],
    build: (v) => [{
      kind: 'cycle', prop: 'y', period: 1 / num(v, 'freq'),
      shape: [[0, 0, 'easeOut'], [0.5, -pct(v, 'dist'), 'easeIn'], [1, 0, 'linear']],
    }],
  },
  {
    id: 'pulse', name: '呼吸', desc: '缩放一张一弛', group: 'loop',
    params: [P.dist(8, 40, '缩放'), P.freq(1.5)],
    build: (v) => [{ kind: 'osc', prop: 'scale', amp: num(v, 'dist') / 100, freq: num(v, 'freq'), positive: true, mode: 'mul' }],
  },
  {
    id: 'heartbeat', name: '心跳', desc: '两次快速放大', group: 'loop',
    params: [P.dist(12, 40, '缩放'), { key: 'bpm', label: '心率', type: 'range', min: 40, max: 200, step: 1, default: 90, unit: 'bpm' }],
    build: (v) => {
      const a = num(v, 'dist') / 100
      return [{
        kind: 'cycle', prop: 'scale', period: 60 / num(v, 'bpm'), mode: 'mul',
        shape: [[0, 1, 'easeOut'], [0.1, 1 + a, 'easeIn'], [0.2, 1, 'easeOut'], [0.3, 1 + a * 0.65, 'easeIn'], [0.45, 1, 'linear'], [1, 1, 'linear']],
      }]
    },
  },
  {
    id: 'blink', name: '闪烁', desc: '透明度明暗闪动', group: 'loop',
    params: [
      { key: 'min', label: '最暗', type: 'range', min: 0, max: 90, step: 1, default: 25, unit: '%' },
      P.freq(3, 12),
      { key: 'hard', label: '方式', type: 'select', default: 'soft', options: [{ value: 'soft', label: '柔和' }, { value: 'hard', label: '硬切' }] },
    ],
    build: (v) => [{ kind: 'osc', prop: 'opacity', amp: num(v, 'min') / 100 - 1, freq: num(v, 'freq'), positive: true, mode: 'mul', hard: v.hard === 'hard' }],
  },
  {
    id: 'spin', name: '旋转', desc: '持续匀速旋转', group: 'loop',
    params: [{ key: 'rps', label: '转速', type: 'range', min: 0.05, max: 3, step: 0.05, default: 0.5, unit: '圈/s' }, P.spinDir()],
    build: (v) => [{ kind: 'ramp', prop: 'rotation', total: (v.spin === 'ccw' ? -360 : 360) * num(v, 'rps') }],
  },
  {
    id: 'orbit', name: '绕圈', desc: '沿小圆周运动', group: 'loop',
    params: [P.dist(3, 20, '半径'), P.freq(1, 4)],
    build: (v) => [
      { kind: 'osc', prop: 'x', amp: pct(v, 'dist'), freq: num(v, 'freq') },
      { kind: 'osc', prop: 'y', amp: pct(v, 'dist'), freq: num(v, 'freq'), phase: 0.25 },
    ],
  },
  {
    id: 'pendulum', name: '衰减摆动', desc: '一开始大幅摆动，逐渐停下', group: 'loop',
    params: [P.angle(20, 60), P.freq(1.5), { key: 'decay', label: '衰减', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7 }],
    build: (v) => [{ kind: 'osc', prop: 'rotation', amp: num(v, 'angle'), freq: num(v, 'freq'), phase: 0.25, decay: num(v, 'decay'), attack: false }],
  },

  // ----- 入场 -----
  {
    id: 'fadeIn', name: '淡入', desc: '透明度渐显', group: 'in',
    params: [P.dur(0.5), P.ease('smooth')],
    build: (v) => { const e = easeIn(v); return [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => clamp01(e(u)) }] },
  },
  {
    id: 'slideIn', name: '滑入', desc: '从画面一侧滑入', group: 'in',
    params: [P.dir4('left', '来自'), P.dist(60, 150, '距离'), P.dur(0.6), P.ease('out'), P.fade('on')],
    build: (v) => {
      const e = easeIn(v), [dx, dy] = dirVec(v.dir), d = pct(v, 'dist')
      return [
        { kind: 'fn', prop: dx ? 'x' : 'y', f: (u) => (dx || dy) * d * (1 - e(u)) },
        ...fadeInCh(v.fade),
      ]
    },
  },
  {
    id: 'zoomIn', name: '放大入场', desc: '从小变大出现', group: 'in',
    params: [{ key: 'from', label: '起始大小', type: 'range', min: 0, max: 90, step: 1, default: 0, unit: '%' }, P.dur(0.5), P.ease('back'), P.fade('on')],
    build: (v) => {
      const e = easeIn(v), s0 = num(v, 'from') / 100
      return [{ kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => lerp(s0, 1, e(u)) }, ...fadeInCh(v.fade)]
    },
  },
  {
    id: 'zoomDown', name: '缩小入场', desc: '从大缩回原大小', group: 'in',
    params: [{ key: 'from', label: '起始大小', type: 'range', min: 110, max: 400, step: 5, default: 250, unit: '%' }, P.dur(0.6), P.ease('out'), P.fade('on')],
    build: (v) => {
      const e = easeIn(v), s0 = num(v, 'from') / 100
      return [{ kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => lerp(s0, 1, e(u)) }, ...fadeInCh(v.fade)]
    },
  },
  {
    id: 'dropIn', name: '掉落入场', desc: '从上方落下弹几下', group: 'in',
    params: [P.dist(60, 150, '高度'), P.dur(0.9), P.ease('bounce')],
    build: (v) => { const e = easeIn(v), h = pct(v, 'dist'); return [{ kind: 'fn', prop: 'y', f: (u) => -h * (1 - e(u)) }] },
  },
  {
    id: 'riseIn', name: '上浮入场', desc: '从下方浮起并渐显', group: 'in',
    params: [P.dist(12, 60, '距离'), P.dur(0.6), P.ease('smooth')],
    build: (v) => {
      const e = easeIn(v), d = pct(v, 'dist')
      return [{ kind: 'fn', prop: 'y', f: (u) => d * (1 - e(u)) }, ...fadeInCh('on', 0.6)]
    },
  },
  {
    id: 'spinIn', name: '旋转入场', desc: '边转边放大出现', group: 'in',
    params: [P.angle(360, 1080, '旋转'), P.spinDir(), P.dur(0.7), P.ease('out')],
    build: (v) => {
      const e = easeIn(v), a = num(v, 'angle') * (v.spin === 'ccw' ? 1 : -1)
      return [
        { kind: 'fn', prop: 'rotation', f: (u) => a * (1 - e(u)) },
        { kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => Math.max(0, e(u)) },
        ...fadeInCh('on', 0.3),
      ]
    },
  },
  {
    id: 'swingIn', name: '摆入', desc: '带角度甩入后回正', group: 'in',
    params: [P.angle(40, 90, '起始角度'), P.dir4('left', '来自'), P.dur(1), P.ease('elastic')],
    build: (v) => {
      const e = easeIn(v), [dx, dy] = dirVec(v.dir), a = num(v, 'angle') * (dx < 0 || dy < 0 ? -1 : 1)
      return [
        { kind: 'fn', prop: 'rotation', f: (u) => a * (1 - e(u)) },
        { kind: 'fn', prop: dx ? 'x' : 'y', f: (u) => (dx || dy) * 0.3 * (1 - Math.min(1, e(u))) },
        ...fadeInCh('on', 0.25),
      ]
    },
  },
  {
    id: 'flickerIn', name: '闪现入场', desc: '闪几下后稳定显示', group: 'in',
    params: [{ key: 'count', label: '闪烁次数', type: 'range', min: 2, max: 12, step: 1, default: 5 }, P.dur(0.6)],
    build: (v) => {
      const n = num(v, 'count') * 2
      return [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => (u >= 0.85 ? 1 : Math.floor(u / 0.85 * n) % 2 ? 1 : 0.08) }]
    },
  },

  // ----- 出场 -----
  {
    id: 'fadeOut', name: '淡出', desc: '透明度渐隐', group: 'out',
    params: [P.dur(0.5), P.ease('smooth')],
    build: (v) => { const e = easeOut(v); return [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => clamp01(1 - e(u)) }] },
  },
  {
    id: 'slideOut', name: '滑出', desc: '向一侧滑出画面', group: 'out',
    params: [P.dir4('right', '去往'), P.dist(60, 150, '距离'), P.dur(0.6), P.ease('out'), P.fade('on')],
    build: (v) => {
      const e = easeOut(v), [dx, dy] = dirVec(v.dir), d = pct(v, 'dist')
      return [{ kind: 'fn', prop: dx ? 'x' : 'y', f: (u) => (dx || dy) * d * e(u) }, ...fadeOutCh(v.fade)]
    },
  },
  {
    id: 'zoomOut', name: '缩小退场', desc: '缩到消失', group: 'out',
    params: [{ key: 'to', label: '结束大小', type: 'range', min: 0, max: 90, step: 1, default: 0, unit: '%' }, P.dur(0.45), P.ease('back'), P.fade('on')],
    build: (v) => {
      const e = easeOut(v), s1 = num(v, 'to') / 100
      return [{ kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => Math.max(0, lerp(1, s1, e(u))) }, ...fadeOutCh(v.fade)]
    },
  },
  {
    id: 'zoomUp', name: '放大消失', desc: '放大并渐隐', group: 'out',
    params: [{ key: 'to', label: '结束大小', type: 'range', min: 110, max: 400, step: 5, default: 200, unit: '%' }, P.dur(0.5), P.ease('out')],
    build: (v) => {
      const e = easeOut(v), s1 = num(v, 'to') / 100
      return [{ kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => lerp(1, s1, e(u)) }, ...fadeOutCh('on', 0.7)]
    },
  },
  {
    id: 'fallOut', name: '坠落退场', desc: '加速下坠并倾倒', group: 'out',
    params: [P.dist(80, 150, '距离'), P.angle(20, 90, '倾倒'), P.dur(0.7), P.ease('out')],
    build: (v) => {
      const e = easeOut(v), d = pct(v, 'dist'), a = num(v, 'angle')
      return [
        { kind: 'fn', prop: 'y', f: (u) => d * e(u) },
        { kind: 'fn', prop: 'rotation', f: (u) => a * e(u) },
        ...fadeOutCh('on', 0.3),
      ]
    },
  },
  {
    id: 'spinOut', name: '旋转退场', desc: '边转边缩小消失', group: 'out',
    params: [P.angle(360, 1080, '旋转'), P.spinDir(), P.dur(0.7), P.ease('out')],
    build: (v) => {
      const e = easeOut(v), a = num(v, 'angle') * (v.spin === 'ccw' ? -1 : 1)
      return [
        { kind: 'fn', prop: 'rotation', f: (u) => a * e(u) },
        { kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => Math.max(0, 1 - e(u)) },
      ]
    },
  },
  {
    id: 'flickerOut', name: '闪烁消失', desc: '闪几下后消失', group: 'out',
    params: [{ key: 'count', label: '闪烁次数', type: 'range', min: 2, max: 12, step: 1, default: 5 }, P.dur(0.6)],
    build: (v) => {
      const n = num(v, 'count') * 2
      return [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => (u <= 0.15 ? 1 : u >= 1 ? 0 : Math.floor((u - 0.15) / 0.85 * n) % 2 ? 0.08 : 1) }]
    },
  },

  // ----- 强调 -----
  {
    id: 'pop', name: '放大强调', desc: '快速放大再回弹', group: 'emph',
    params: [P.dist(25, 80, '放大'), P.dur(0.5)],
    build: (v) => {
      const a = num(v, 'dist') / 100
      return [{ kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => (u < 0.7 ? 1 + a * Math.sin(Math.PI * u / 0.7) : 1 - a * 0.2 * Math.sin(Math.PI * (u - 0.7) / 0.3)) }]
    },
  },
  {
    id: 'tada', name: '惊喜', desc: '缩一下再放大抖动', group: 'emph',
    params: [P.dist(10, 40, '缩放'), P.angle(4, 15, '抖动角'), P.dur(1)],
    build: (v) => {
      const a = num(v, 'dist') / 100, r = num(v, 'angle')
      return [
        { kind: 'fn', prop: 'scale', mode: 'mul', f: (u) => piecewise(u, [[0, 1], [0.1, 1 - a], [0.2, 1 - a], [0.3, 1 + a], [0.85, 1 + a], [1, 1]]) },
        { kind: 'fn', prop: 'rotation', f: (u) => (u < 0.1 || u > 0.9 ? 0 : r * Math.sin(2 * Math.PI * 4 * (u - 0.1) / 0.8)) },
      ]
    },
  },
  {
    id: 'jello', name: '果冻', desc: '左右扭动逐渐停下', group: 'emph',
    params: [P.angle(12, 40), { key: 'times', label: '次数', type: 'range', min: 1, max: 8, step: 1, default: 4 }, P.dur(0.9)],
    build: (v) => {
      const a = num(v, 'angle'), n = num(v, 'times')
      return [{ kind: 'fn', prop: 'rotation', f: (u) => a * Math.sin(2 * Math.PI * n * u) * Math.pow(1 - u, 2) }]
    },
  },
  {
    id: 'headShake', name: '摇头', desc: '左右快速晃动', group: 'emph',
    params: [P.dist(3, 15), { key: 'times', label: '次数', type: 'range', min: 1, max: 8, step: 1, default: 4 }, P.dur(0.8)],
    build: (v) => {
      const d = pct(v, 'dist'), n = num(v, 'times')
      return [{ kind: 'fn', prop: 'x', f: (u) => d * Math.sin(2 * Math.PI * n * u) * (1 - u) }]
    },
  },
  {
    id: 'nod', name: '点头', desc: '上下点动', group: 'emph',
    params: [P.dist(2, 15), { key: 'times', label: '次数', type: 'range', min: 1, max: 6, step: 1, default: 2 }, P.dur(0.6)],
    build: (v) => {
      const d = pct(v, 'dist'), n = num(v, 'times')
      return [{ kind: 'fn', prop: 'y', f: (u) => d * Math.abs(Math.sin(Math.PI * n * u)) * (1 - u * 0.5) }]
    },
  },
  {
    id: 'flash', name: '闪两下', desc: '透明度快速闪动', group: 'emph',
    params: [{ key: 'times', label: '次数', type: 'range', min: 1, max: 6, step: 1, default: 2 }, { key: 'min', label: '最暗', type: 'range', min: 0, max: 90, step: 1, default: 0, unit: '%' }, P.dur(0.8)],
    build: (v) => {
      const n = num(v, 'times'), m = num(v, 'min') / 100
      return [{ kind: 'fn', prop: 'opacity', mode: 'mul', f: (u) => lerp(m, 1, 0.5 + 0.5 * Math.cos(2 * Math.PI * n * u)) }]
    },
  },
]

export function findMotionPreset(id: string) {
  return MOTION_PRESETS.find((p) => p.id === id)
}

export function defaultValues(preset: MotionPreset): ParamValues {
  return Object.fromEntries(preset.params.map((p) => [p.key, p.default]))
}

export function resolveValues(preset: MotionPreset, values?: ParamValues): ParamValues {
  const out = defaultValues(preset)
  for (const p of preset.params) {
    const v = values?.[p.key]
    if (v === undefined) continue
    if (p.type === 'range') {
      const n = Number(v)
      if (Number.isFinite(n)) out[p.key] = Math.max(p.min, Math.min(p.max, n))
    } else if (p.options.some((o) => o.value === v)) out[p.key] = v
  }
  return out
}

/** 一次性动作（入场 / 出场 / 强调）的时长 */
export function presetDuration(preset: MotionPreset, values?: ParamValues): number | null {
  if (preset.group === 'loop') return null
  return num(resolveValues(preset, values), 'dur')
}

// ---------- 生成关键帧 ----------

const MAX_KEYS_PER_PROP = 400

const channelMode = (ch: Channel): Mode => ('mode' in ch && ch.mode) || 'add'

/** 在长度 T 的范围内生成相对偏移 / 倍率关键帧（t 从 0 起） */
function genChannel(ch: Channel, T: number, fps: number, seed: string): GenKey[] {
  const neutral = channelMode(ch) === 'mul' ? 1 : 0
  const fade = Math.min(0.2, T / 4)
  const env = (t: number, attack = true) =>
    fade <= 0 ? 1 : Math.min(1, attack ? t / fade : 1, (T - t) / fade)

  switch (ch.kind) {
    case 'noise': {
      let step = 1 / ch.rate
      if (T / step > MAX_KEYS_PER_PROP) step = T / MAX_KEYS_PER_PROP
      const n = Math.max(1, Math.round(T / step))
      const out: GenKey[] = []
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * T
        const v = i === 0 || i === n ? 0 : hashNoise(seed + ch.prop, i) * ch.amp * env(t)
        out.push({ t, v, ease: 'linear' })
      }
      return out
    }
    case 'osc': {
      const phase = ch.phase ?? 0
      const attack = ch.attack !== false
      const ease: Ease = ch.hard ? 'hold' : 'easeInOut'
      const wave = (s: number) => (ch.positive ? (1 + s) / 2 : s)
      const decay = (t: number) => (ch.decay ? Math.pow(1 - t / T, 1 + 3 * ch.decay) : 1)
      const at = (t: number) => neutral + ch.amp * wave(Math.sin(2 * Math.PI * (ch.freq * t + phase))) * env(t, attack) * decay(t)
      const out: GenKey[] = [{ t: 0, v: at(0), ease }]
      let k0 = Math.ceil((phase - 0.25) * 2 + 1e-6)
      if ((0.25 - phase + k0 / 2) / ch.freq <= 1e-6) k0++
      for (let k = k0, n = 0; n < MAX_KEYS_PER_PROP; k++, n++) {
        const t = (0.25 - phase + k / 2) / ch.freq
        if (t >= T - 1e-6) break
        out.push({ t, v: at(t), ease })
      }
      out.push({ t: T, v: neutral, ease: 'linear' })
      return out
    }
    case 'cycle': {
      const period = ch.period
      const out: GenKey[] = []
      for (let c0 = 0; c0 < T - 1e-6 && out.length < MAX_KEYS_PER_PROP; c0 += period) {
        for (const [ph, v, ease] of ch.shape) {
          const t = c0 + ph * period
          if (t > T + 1e-6) break
          if (out.length && t <= out[out.length - 1].t + 1e-6) continue
          out.push({ t, v: neutral + (v - neutral) * env(t), ease })
        }
      }
      if (!out.length || out[out.length - 1].t < T - 1e-6) out.push({ t: T, v: neutral, ease: 'linear' })
      return out
    }
    case 'ramp': {
      const total = ch.total * T
      const turns = Math.round(total / 360)
      return [{ t: 0, v: 0, ease: 'linear' }, { t: T, v: turns ? turns * 360 : total, ease: 'linear' }]
    }
    case 'fn': {
      const n = Math.max(2, Math.min(MAX_KEYS_PER_PROP, Math.ceil(T * Math.min(60, Math.max(24, fps)))))
      const out: GenKey[] = []
      for (let i = 0; i <= n; i++) out.push({ t: (i / n) * T, v: ch.f(i / n), ease: 'linear' })
      return out
    }
  }
}

function staticValue(c: Clip, prop: MotionProp): number {
  const tr = c.transform
  switch (prop) {
    case 'x': return tr.x
    case 'y': return tr.y
    case 'scale': return tr.scaleX
    case 'rotation': return tr.rotation
    case 'opacity': return tr.opacity
  }
}

export interface ApplyRange {
  /** 片段局部时间范围；入场 / 强调从 t0 起，出场在 t1 结束，循环铺满 */
  t0: number
  t1: number
  fps: number
}

/** 把预设写成关键帧：范围内的原有关键帧被替换，生成值叠加在原动画之上 */
export function applyPresetKeyframes(clip: Clip, preset: MotionPreset, values: ParamValues | undefined, range: ApplyRange): Clip {
  const v = resolveValues(preset, values)
  let a = Math.max(0, Math.min(clip.duration, range.t0))
  let b = Math.max(a, Math.min(clip.duration, range.t1))
  const dur = presetDuration(preset, v)
  if (dur != null) {
    const d = Math.min(b - a, dur)
    if (preset.group === 'out') a = b - d
    else b = a + d
  }
  const T = b - a
  const fps = Math.max(1, range.fps)
  if (T < 1 / fps) return clip

  const byProp = new Map<MotionProp, { mode: Mode; keys: GenKey[] }[]>()
  for (const ch of preset.build(v)) {
    const list = byProp.get(ch.prop) ?? []
    list.push({ mode: channelMode(ch), keys: genChannel(ch, T, fps, clip.id) })
    byProp.set(ch.prop, list)
  }

  const keyframes = { ...clip.keyframes }
  const eps = 0.5 / fps
  for (const [prop, chans] of byProp) {
    const existing = clip.keyframes[prop]
    const base = (t: number) => sampleKeyframes(existing, t, staticValue(clip, prop))
    const asKf = chans.map((ch) => ch.keys.map((k): Keyframe => ({ id: '', t: k.t, value: k.v, ease: k.ease })))

    const times = new Map<number, Ease>()
    for (const ch of chans) for (const k of ch.keys) {
      const t = snapToFrame(a + k.t, fps)
      if (t < a - eps || t > b + eps) continue
      if (!times.has(t) || k.ease !== 'linear') times.set(t, k.ease)
    }

    const gen: Keyframe[] = [...times.entries()].sort((p, q) => p[0] - q[0]).map(([t, ease]) => {
      let val = base(t)
      chans.forEach((ch, i) => {
        const o = sampleKeyframes(asKf[i], t - a, ch.mode === 'mul' ? 1 : 0)
        val = ch.mode === 'mul' ? val * o : val + o
      })
      if (prop === 'opacity') val = clamp01(val)
      if (prop === 'scale') val = Math.max(0, val)
      return { id: uid('kf'), t, value: val, ease }
    })

    const kept = (existing ?? []).filter((k) => k.t < a - eps || k.t > b + eps)
    keyframes[prop] = [...kept, ...gen].sort((p, q) => p.t - q.t)
  }
  return { ...clip, keyframes }
}
