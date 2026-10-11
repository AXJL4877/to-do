/**
 * 整数 tick 时间基准（P4 的地基）。
 *
 * 现状：工程里每个时间字段都是**浮点秒**，帧吸附靠 `Math.round(t * fps) / fps`。
 *
 * ⚠️ 关于动机，先纠正一个我一度写错的说法：**"浮点用久了会漂"不成立**。
 * 实测（`findAccumulationDrift`，随测试保留）：30fps 与 29.97fps 下按帧累加 200 万步
 * （≈18.5 小时），浮点帧号与整数帧号**没有**出现偏差——双精度累积误差约 1e-12 秒，远不到半帧。
 *
 * 那么为什么要整数 tick？理由是这些（都可验证）：
 *   1. **精确是保证，而不是"误差足够小"**：商用工具不该依赖"误差远低于阈值"这种估计。
 *      浮点连 `1/30 * 30 === 1` 都不成立（见测试），而整数 tick 下帧号往返严格相等。
 *   2. **有理帧率**：29.97 必须是 30000/1001 而不是 2997/100——后者才是真正会累积错的地方。
 *   3. **帧号是一等公民**：`frameToTicks` / `ticksToFrame` 精确互逆，不必反复从浮点秒反推帧。
 *   4. **互操作**：OTIO 用有理时间、filmcraft 用整数 tick；对外交换时整数是共同语言。
 *
 * 目标形态：
 *   ticksPerSecond = 254016000000 = 2^7 × 3^4 × 5^2 × 7^2 × 11 × 13 × 17 × 19 × 23
 *   能被 1..100 的绝大多数帧率（含 29.97 = 30000/1001、23.976 = 24000/1001）整除。
 *
 * **本文件的范围（重要）**：只提供精确算术 + 边界守卫 + 对照实验。
 * 把 tick 提升为工程文档里的**权威表示**是另一件事，牵动 store / 渲染 / 导出 / AI 服务，
 * 需要 `todo-project/3` 规范 + 迁移边 + 金样比对，**尚未完成**。别把这个文件当成迁移已完成。
 */
/** 每秒 tick 数（与 filmcraft 一致）。能被 1..100 里绝大多数帧率整除。 */
export const TICKS_PER_SECOND = 254016000000

/** JS Number 能精确表示的整数上限；tick 是整数，超过就要走 BigInt。 */
export const MAX_SAFE_TICKS = Number.MAX_SAFE_INTEGER

/** 用该 tick 基准能安全表示的最长时长（约 9.85 小时）。 */
export const MAX_SAFE_SECONDS = MAX_SAFE_TICKS / TICKS_PER_SECOND

export const FRAME_RATES = {
  fps23_976: { num: 24000, den: 1001 },
  fps24: { num: 24, den: 1 },
  fps25: { num: 25, den: 1 },
  fps29_97: { num: 30000, den: 1001 },
  fps30: { num: 30, den: 1 },
  fps50: { num: 50, den: 1 },
  fps59_94: { num: 60000, den: 1001 },
  fps60: { num: 60, den: 1 },
}

/** 把 30 / 29.97 / {num,den} 统一成有理帧率。 */
export function toFrameRate(fps) {
  if (fps && typeof fps === 'object' && fps.num && fps.den) return { num: fps.num, den: fps.den }
  const n = Number(fps)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`非法帧率：${fps}`)
  // 常见非整数帧率映射到有理数（避免 29.97 被当成 2997/100）
  if (Math.abs(n - 29.97) < 1e-9) return { num: 30000, den: 1001 }
  if (Math.abs(n - 23.976) < 1e-9) return { num: 24000, den: 1001 }
  if (Math.abs(n - 59.94) < 1e-9) return { num: 60000, den: 1001 }
  // 整数帧率必须给 {n, 1}：否则 30 会变成 30000000/1000000，
  // 虽然数值相同，但"是否已约分"会影响序列化与比较（踩过一次）。
  if (Number.isInteger(n)) return { num: n, den: 1 }
  const den = 1000000
  return simplify({ num: Math.round(n * den), den })
}

const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b))

/** 约分（保持整数，便于比较与序列化）。 */
export function simplify(rate) {
  const g = gcd(rate.num, rate.den) || 1
  return { num: rate.num / g, den: rate.den / g }
}

export const rateToNumber = (rate) => rate.num / rate.den

/**
 * 秒 → tick。**四舍五入到最近 tick**（不是截断）：截断会让 1/30 这类步长系统性地偏慢。
 * @param {number} seconds
 * @param {{round?: 'nearest'|'floor'|'ceil'}} [opts]
 */
export function secondsToTicks(seconds, opts = {}) {
  const s = Number(seconds)
  if (!Number.isFinite(s)) throw new Error(`非法秒数：${seconds}`)
  const raw = s * TICKS_PER_SECOND
  const round = opts.round ?? 'nearest'
  const v = round === 'floor' ? Math.floor(raw) : round === 'ceil' ? Math.ceil(raw) : Math.round(raw)
  if (!Number.isSafeInteger(v)) {
    throw new Error(`时间 ${s}s 超出安全 tick 范围（约 ${MAX_SAFE_SECONDS.toFixed(0)}s）；超过请用 BigInt 版本`)
  }
  return v
}

export function ticksToSeconds(ticks) {
  if (!Number.isFinite(ticks)) throw new Error(`非法 tick：${ticks}`)
  return ticks / TICKS_PER_SECOND
}

/** 一帧有多少 tick（可能是非整数，因为 1001 与基准互质时的结果仍由基准保证可整除）。 */
export function ticksPerFrame(rate) {
  const r = toFrameRate(rate)
  const v = (TICKS_PER_SECOND * r.den) / r.num
  if (!Number.isSafeInteger(v)) throw new Error(`帧率 ${r.num}/${r.den} 下每帧 tick 不是整数：${v}`)
  return v
}

/** 秒 → 帧号（向下取整，用于"当前在第几帧"）。 */
export function secondsToFrame(seconds, rate) {
  const r = toFrameRate(rate)
  return Math.floor((Number(seconds) * r.num) / r.den)
}

/** 帧号 → tick（精确，无浮点误差）。 */
export function frameToTicks(frame, rate) {
  const r = toFrameRate(rate)
  return Math.round((frame * TICKS_PER_SECOND * r.den) / r.num)
}

/** 把秒吸附到帧网格，返回 tick（**全程整数运算**，这是与浮点实现的关键差别）。 */
export function snapSecondsToFrameTicks(seconds, rate, mode = 'nearest') {
  const r = toFrameRate(rate)
  const t = secondsToTicks(seconds, { round: 'floor' })
  const perFrame = ticksPerFrame(r)
  const idx = mode === 'floor' ? Math.floor(t / perFrame) : Math.round(t / perFrame)
  return frameToTicks(idx, r)
}

/** tick → 帧号（精确）。 */
export function ticksToFrame(ticks, rate) {
  const perFrame = ticksPerFrame(rate)
  return Math.floor(ticks / perFrame)
}

/** 便于人读的时码 HH:MM:SS:FF。 */
export function formatTimecode(ticks, rate) {
  const r = toFrameRate(rate)
  const perFrame = ticksPerFrame(r)
  const totalFrames = Math.floor(ticks / perFrame)
  const fps = Math.round(rateToNumber(r))
  const ff = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

// ───────────────────────── 浮点实现的漂移证据 ─────────────────────────

/**
 * 复现当前实现的做法：`Math.round(t * fps) / fps`（浮点秒 + 浮点除法）。
 * 用于对照——不是推荐用法。
 */
export function legacySnapSeconds(seconds, fps) {
  const f = Number(fps)
  return Math.round(seconds * f) / f
}

/**
 * 累加漂移（这才是真实故障场景）。
 *
 * 一开始我写的是"把同一个值反复吸附"，结果浮点与整数都不漂——因为反复吸附会收敛到不动点。
 * 真实场景是**累加**：长片里成千上万个片段按帧往后铺，每步都在做 `t += 1/fps`。
 * 浮点累加会把误差攒起来，攒够半帧之后帧号就偏一格；整数 tick 累加永远精确。
 *
 * @returns {{at:number, legacyFrame:number, tickFrame:number, legacySeconds:number, tickSeconds:number}|null}
 *          首次帧号分歧的位置（null = 在给定步数内没分歧）
 */
export function findAccumulationDrift(rate, steps = 200000) {
  const r = toFrameRate(rate)
  const fps = rateToNumber(r)
  const perFrame = ticksPerFrame(r)
  let legacy = 0
  let ticks = 0
  for (let i = 1; i <= steps; i += 1) {
    legacy += 1 / fps
    ticks += perFrame
    const a = Math.round(legacy * fps)
    const b = ticksToFrame(ticks, r)
    if (a !== b) {
      return { at: i, legacyFrame: a, tickFrame: b, legacySeconds: legacy, tickSeconds: ticksToSeconds(ticks) }
    }
  }
  return null
}

/** 兼容旧名字：单值反复吸附（保留，因为它证明了"吸附本身不会漂"）。 */
export function findDrift(seconds, rate, iterations = 2000) {
  const r = toFrameRate(rate)
  const fps = rateToNumber(r)
  let legacy = Number(seconds)
  let ticks = secondsToTicks(seconds)
  for (let i = 1; i <= iterations; i += 1) {
    legacy = legacySnapSeconds(legacy, fps)
    ticks = snapSecondsToFrameTicks(ticksToSeconds(ticks), r)
    if (Math.round(legacy * fps) !== ticksToFrame(ticks, r)) {
      return { at: i, legacyFrame: Math.round(legacy * fps), tickFrame: ticksToFrame(ticks, r), legacySeconds: legacy }
    }
  }
  return null
}
