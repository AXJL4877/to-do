/**
 * 整数 tick 的测试：**精确性是主张，必须被证明**。
 * 重点不是"能算"，而是：
 *   1) 常见帧率下"一帧 = 整数 tick"（否则帧号运算迟早漂）
 *   2) 往返（秒→tick→秒）在 tick 精度内无损
 *   3) 与现有浮点实现相比，长链吸附下浮点会分歧而整数不会（这是迁移的**理由**，不是修辞）
 *   4) 超界必须报错，而不是悄悄给个错的数
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FRAME_RATES, MAX_SAFE_SECONDS, TICKS_PER_SECOND, findAccumulationDrift, findDrift, formatTimecode, frameToTicks,
  legacySnapSeconds, rateToNumber, secondsToFrame, secondsToTicks, simplify, snapSecondsToFrameTicks,
  ticksPerFrame, ticksToFrame, ticksToSeconds, toFrameRate,
} from './ticks.mjs'

test('基准值：每秒 tick 数与 filmcraft 一致', () => {
  assert.equal(TICKS_PER_SECOND, 254016000000)
  assert.ok(Number.isSafeInteger(TICKS_PER_SECOND))
})

test('常见帧率下每帧都是整数 tick（这是选这个基准的全部理由）', () => {
  const rates = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100]
  for (const r of rates) {
    const perFrame = ticksPerFrame(r)
    assert.ok(Number.isSafeInteger(perFrame), `${r} fps 的每帧 tick 不是整数：${perFrame}`)
    assert.ok(perFrame > 0)
  }
  // 抽查几个黄金值：30fps 一帧 = 254016000000/30 = 8467200000
  assert.equal(ticksPerFrame(30), 8467200000)
  // 29.97 = 30000/1001 → 一帧 = 254016000000 * 1001 / 30000
  assert.equal(ticksPerFrame(29.97), Math.round((TICKS_PER_SECOND * 1001) / 30000))
})

test('有理帧率：29.97 不被当成 2997/100', () => {
  assert.deepEqual(toFrameRate(29.97), { num: 30000, den: 1001 })
  assert.deepEqual(toFrameRate(23.976), { num: 24000, den: 1001 })
  assert.deepEqual(toFrameRate(30), { num: 30, den: 1 })
  assert.deepEqual(toFrameRate(25), { num: 25, den: 1 }, '整数帧率必须约分')
  assert.deepEqual(simplify({ num: 60000, den: 2002 }), { num: 30000, den: 1001 })
  assert.equal(rateToNumber({ num: 30000, den: 1001 }), 30000 / 1001)
})

test('往返无损：秒 → tick → 秒 在 tick 精度内', () => {
  const samples = [0, 0.1, 1 / 3, 1 / 30, 7.8025, 26.377, 123.456789]
  for (const s of samples) {
    const back = ticksToSeconds(secondsToTicks(s))
    assert.ok(Math.abs(back - s) <= 1 / TICKS_PER_SECOND, `${s} 往返误差过大：${back}`)
  }
})

test('往返无损：帧号 → tick → 帧号 完全相等（帧号是整数，不容误差）', () => {
  for (const r of [23.976, 24, 25, 29.97, 30, 60]) {
    for (const f of [0, 1, 29, 30, 1000, 17982, 100000]) {
      const t = frameToTicks(f, r)
      assert.equal(ticksToFrame(t, r), f, `${r}fps 第 ${f} 帧往返失败`)
    }
  }
})

test('帧网格吸附：与整数帧号严格对齐（30fps）', () => {
  const perFrame = ticksPerFrame(30)
  for (const s of [0, 0.033, 1.0, 1.001, 7.9999, 26.377]) {
    const t = snapSecondsToFrameTicks(s, 30)
    assert.equal(t % perFrame, 0, `${s}s 吸附后不是整帧：${t}`)
    assert.ok(Math.abs(ticksToSeconds(t) - s) <= 1 / 30 + 1e-9, `${s}s 吸附偏离超过一帧`)
  }
  // 吸附到最近帧：1.001s 在 30fps 下更接近第 30 帧（1.0s）而不是第 31 帧
  assert.equal(ticksToFrame(snapSecondsToFrameTicks(1.001, 30), 30), 30)
  assert.equal(ticksToFrame(snapSecondsToFrameTicks(1.02, 30), 30), 31)
})

test('时码格式（29.97 下按名义 30 帧显示，专业习惯）', () => {
  assert.equal(formatTimecode(0, 30), '00:00:00:00')
  assert.equal(formatTimecode(frameToTicks(90, 30), 30), '00:00:03:00')
  assert.equal(formatTimecode(frameToTicks(91, 30), 30), '00:00:03:01')
  assert.equal(formatTimecode(frameToTicks(30 * 3661, 30), 30), '01:01:01:00')
})

test('如实记录：浮点累加 200 万步**没有**偏格（所以"会漂"不是迁移理由）', () => {
  // 这条测试的价值是**防止后来者把理由说错**。真实结论：双精度够用很久，
  // 迁移的理由是"精确是保证 + 有理帧率 + 帧号一等公民 + 互操作"，不是"浮点会漂"。
  const drift = findAccumulationDrift(30, 2000000)
  assert.equal(drift, null, '若这条变红：浮点累加确实偏格了，那文件头的动机需要再改一次（并给出新数字）')
})

test('但浮点**无法精确表示**基本步长（精确性无法保证，这才是不用浮点的理由）', () => {
  // 教训：不要凭印象举浮点反例——1/30*30 在 IEEE754 下**恰好等于 1**。
  // 所以这里改成实测统计，而不是挑一个"看起来该失败"的式子。
  let inexact = 0
  for (let k = 1; k <= 1000; k += 1) if ((k / 30) * 30 !== k) inexact += 1
  assert.ok(inexact > 0, `1..1000 中应有 (k/30)*30 !== k 的情形，实测 ${inexact} 个`)
  assert.notEqual(0.1 + 0.2, 0.3, '经典反例：0.1 + 0.2 !== 0.3')
  // 整数 tick 侧：帧号往返严格相等（"精确是保证"的可验证形式）
  for (const r of [30, 29.97, 23.976]) {
    const t0 = frameToTicks(17982, r)
    assert.equal(ticksToFrame(t0, r), 17982, `${r}fps 第 17982 帧必须精确往返`)
  }
})

test('对照：单值反复吸附（不动点）两种实现都不漂 —— 所以漂移不是吸附引起的', () => {
  assert.equal(findDrift(0.1, 30, 5000), null, '单值反复吸附是收敛的；这条用于防止把漂移归错原因')
})

test('整数实现自身反复吸附不会分歧（同样条件下稳定）', () => {
  const r = toFrameRate(30)
  let ticks = secondsToTicks(0.1)
  const first = ticksToFrame(ticks, r)
  for (let i = 0; i < 5000; i += 1) ticks = snapSecondsToFrameTicks(ticksToSeconds(ticks), r)
  assert.equal(ticksToFrame(ticks, r), first, '整数 tick 反复吸附应当稳定在同一帧')
})

test('边界守卫：超出安全 tick 范围要报错，不能悄悄给错数', () => {
  assert.ok(MAX_SAFE_SECONDS > 30000, '至少能表示 8 小时以上')
  assert.throws(() => secondsToTicks(MAX_SAFE_SECONDS * 10), /超出安全 tick 范围/)
  assert.throws(() => secondsToTicks(Number.NaN), /非法秒数/)
  assert.throws(() => toFrameRate(0), /非法帧率/)
})

test('secondsToFrame 与 frameToTicks 互为逆（向下取整语义）', () => {
  for (const s of [0, 0.5, 1.0, 1.999, 2.0]) {
    const f = secondsToFrame(s, 30)
    assert.ok(frameToTicks(f, 30) <= secondsToTicks(s, { round: 'floor' }) + 1e-9)
  }
  assert.equal(secondsToFrame(1.999, 30), 59)
  assert.equal(secondsToFrame(2.0, 30), 60)
})

test('legacySnapSeconds 仅作对照：它就是当前实现的做法', () => {
  // 1.001s 在 30fps 下吸附到第 30 帧 = 1.0s（所以它确实等于 1.0；这里如实断言）
  assert.equal(legacySnapSeconds(1.001, 30), 1.0)
  assert.equal(legacySnapSeconds(1.02, 30), Math.round(1.02 * 30) / 30)
})

test('FRAME_RATES 常量都是合法有理数', () => {
  for (const [k, v] of Object.entries(FRAME_RATES)) {
    assert.ok(v.num > 0 && v.den > 0, k)
    assert.ok(ticksPerFrame(v) > 0, k)
  }
})
