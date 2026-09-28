/** 自检：每个动效预设写出的关键帧有序、有限、落在范围内；循环 / 强调结束时回到原值，入场结束时到达原值 */
import { applyPresetKeyframes, defaultValues, MOTION_PRESETS, presetDuration, resolveValues } from './motionPresets'
import { sampleKeyframes } from './keyframeEval'
import { defaultAudio, defaultColor, defaultTransform, type Clip } from '../types'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const clip: Clip = {
  id: 'c1', trackId: 'v1', name: 'c', start: 10, duration: 4, inPoint: 0, outPoint: 4,
  enabled: true, speed: 1, reverse: false, speedKeyframes: [],
  transform: { ...defaultTransform(), x: 0.1, scaleX: 0.8, scaleY: 0.8 },
  color: defaultColor(), audio: defaultAudio(), effects: [], blend: 'normal',
  keyframes: { x: [{ id: 'k0', t: 0, value: 0.1, ease: 'linear' }, { id: 'k1', t: 4, value: 0.3, ease: 'linear' }] },
}
const staticOf: Record<string, number> = { x: 0.1, y: 0, scale: 0.8, rotation: 0, opacity: 1 }

const ids = new Set<string>()
for (const p of MOTION_PRESETS) {
  assert(!ids.has(p.id), `duplicate id ${p.id}`)
  ids.add(p.id)
  const dv = defaultValues(p)
  for (const d of p.params) {
    if (d.type === 'range') assert(d.min <= d.default && d.default <= d.max, `${p.id}.${d.key} default in range`)
    else assert(d.options.some((o) => o.value === d.default), `${p.id}.${d.key} default option`)
  }
  assert(Number(resolveValues(p, { ...dv, dist: 1e9, angle: -1e9 }).dist ?? 0) < 1e9, `${p.id} clamps`)

  for (const [t0, t1] of [[0, 4], [1, 2.5]]) {
    const out = applyPresetKeyframes(clip, p, undefined, { t0, t1, fps: 30 })
    const dur = presetDuration(p)
    let a = t0, b = t1
    if (dur != null) { if (p.group === 'out') a = b - Math.min(b - a, dur); else b = a + Math.min(b - a, dur) }
    const props = new Set(p.build(dv).map((c) => c.prop))
    for (const prop of props) {
      const list = out.keyframes[prop]
      assert(!!list && list.length >= 2, `${p.id}.${prop} has keys`)
      for (let i = 0; i < list.length; i++) {
        const k = list[i]
        assert(Number.isFinite(k.value) && Number.isFinite(k.t), `${p.id}.${prop} finite`)
        assert(k.t >= 0 && k.t <= clip.duration + 1e-6, `${p.id}.${prop} t in clip`)
        if (i) assert(k.t >= list[i - 1].t, `${p.id}.${prop} sorted`)
        if (prop === 'opacity') assert(k.value >= 0 && k.value <= 1, `${p.id} opacity clamped`)
      }
      if (p.group === 'out') continue
      const before = sampleKeyframes(clip.keyframes[prop], b, staticOf[prop])
      const after = sampleKeyframes(list, b, NaN)
      const diff = Math.abs(before - after)
      const ok = diff < 1e-3 || (p.id === 'spin' && prop === 'rotation' && Math.abs(diff / 360 - Math.round(diff / 360)) < 1e-6)
      assert(ok, `${p.id}.${prop} settles to base at end (${before} vs ${after})`)
    }
    if (t0 === 1 && out.keyframes.x && props.has('x')) {
      assert(out.keyframes.x.some((k) => k.id === 'k1'), `${p.id} keeps keys outside range`)
    }
  }
}

const groups = MOTION_PRESETS.reduce<Record<string, number>>((m, p) => ({ ...m, [p.group]: (m[p.group] ?? 0) + 1 }), {})
console.log(`motion-presets self-check ok (${MOTION_PRESETS.length} presets: ${JSON.stringify(groups)})`)
