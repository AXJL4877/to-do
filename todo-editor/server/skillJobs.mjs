/**
 * 技能任务执行，按 pack.pipeline 分流，渲染端统一走 todo-skill-render/1，产出清单 todo-skill-output/1：
 *   elements：规划 → 元素生图 → 渲染。元素图 <id>_el<N>.png 落盘后重试直接复用，不重复扣费。
 *   tts：文案 → 配音（TTS_timeline），产出 <id>_voice.wav + <id>_timing.json，已存在则重试直接复用。
 *   subtitle：取一条 tts 任务的文案 / 配音 / 时间戳 → 渲染（按逐字时间戳切条 + 透明底烧录）。
 *   narrated：口播 → 配音 → 按短语时间戳分板拆元素 → 元素生图 ∥ 逐板渲染成时间轴片段；阶段产物随时写进 params.partial 供前端流式入轨。各步产物落盘，重试复用。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { saveImageResult, submitImageGeneration } from './huniuClient.mjs'
import {
  assetAspect, assetPrompt, fallbackNarrationPlan, fallbackPlan, getSkillEntry, planNarration, planSkill, timingPhrases,
} from './skillPacks.mjs'
import { synthTimeline } from './ttsTimeline.mjs'
import { resolveFfmpeg } from './animBuild.mjs'
import { resolvePython } from './toolRoots.mjs'

export const SKILL_RENDER_SPEC = 'todo-skill-render/1'
export const SKILL_OUTPUT_SPEC = 'todo-skill-output/1'
const PYTHON = resolvePython()

/** 整体进度：规划 0~5%，生图 5~40%，渲染 40~100% */
const pctOf = (stage, local) => Math.round(stage === 'plan' ? 5 * local : stage === 'assets' ? 5 + 35 * local : 40 + 60 * local)
export function elementImageName(jobId, index) {
  return `${jobId}_el${index + 1}.png`
}

export const ttsNames = (jobId) => ({
  script: `${jobId}_script.txt`,
  audio: `${jobId}_voice.wav`,
  timing: `${jobId}_timing.json`,
})

export const subtitleNames = (jobId) => ({
  subtitles: `${jobId}_subtitles.json`,
  ass: `${jobId}.ass`,
})

const url = (name) => `/ai-generated/${name}`

/** 配音音色：咪仔为 Seed TTS 2.0 官方音色；克隆音走声音复刻 2.0，两者都带逐字时间戳 */
export function ttsVoice(params) {
  if (params?.voice === 'clone') return { speaker: String(params.cloneId || ''), resourceId: 'seed-icl-2.0' }
  return { speaker: 'zh_female_mizai_uranus_bigtts', resourceId: 'seed-tts-2.0' }
}

/**
 * 解析渲染端 stdout：@progress / @result / @error 为协议行，其余是日志。
 * @returns {{ tag: 'progress'|'result'|'error', data: any } | null}
 */
export function parseRenderLine(line) {
  const m = /^@(progress|result|error) (.+)$/.exec(line.trim())
  if (!m) return null
  try { return { tag: m[1], data: JSON.parse(m[2]) } } catch { return null }
}

export function runRenderer(entry, requestFile, { timeoutSec, onProgress }) {
  const script = path.join(entry.dir, entry.pack.runtime.entry)
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [script, '--request', requestFile], {
      cwd: entry.dir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })
    let buf = ''
    let tail = ''
    let result = null
    let error = null
    const timer = setTimeout(() => { error = `渲染超时（${timeoutSec}s）`; try { child.kill() } catch { /* */ } }, timeoutSec * 1000)
    const onLine = (line) => {
      const msg = parseRenderLine(line)
      if (!msg) { tail = `${tail}\n${line}`.slice(-600); return }
      if (msg.tag === 'progress') onProgress(msg.data)
      else if (msg.tag === 'result') result = msg.data
      else error = String(msg.data?.message || '渲染失败')
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { tail = `${tail}${c}`.slice(-600) })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? `找不到 Python（${PYTHON}，可设 TODO_PYTHON）` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf) onLine(buf)
      if (code === 0 && result && !error) resolve(result)
      else reject(new Error(error || `渲染端退出码 ${code}：${tail.trim().slice(-300)}`))
    })
  })
}

/**
 * @param {object} job rowToJob 结果；params = { skill, request: { skillId, prompt, params, plan }, ... }
 * @param {{ outDir: string, config: object, phase: (s: string) => void, saveParams: (p: object) => void, withRetry: <T>(fn: () => Promise<T>) => Promise<T> }} ctx
 * @returns {Promise<object>} todo-skill-output/1 清单
 */
export async function executeSkillJob(job, ctx) {
  const entry = getSkillEntry(job.params.request.skillId)
  // 黑板手绘 1.x 是 elements 管线，按入队时的管线重试老任务
  const pipeline = job.params.skill?.pipeline ?? (job.params.request.plan?.elements ? 'elements' : entry.pack.pipeline)
  // production 管线的成片任务走成片运行器（配音/分镜/生图/渲染/字幕/入轨全由它接管）。
  // 这里曾漏掉这一支：executeProductionJob 写好了却没人调用，于是成片任务掉进 executeElementsJob，
  // 而它的 req.prompt 对成片永远是 undefined → TypeError: Cannot read properties of undefined (reading 'slice')，
  // 任务在 58ms 内失败、阶段停在「待生成」。判据用 request.productionId，避免误拦老任务。
  if (pipeline === 'production' && job.params.request.productionId) {
    // 动态 import：production/job.mjs 反过来 import 本模块的 SKILL_OUTPUT_SPEC，
    // 静态 import 会形成初始化顺序依赖，这里按调用时机加载更稳。
    const { executeProductionJob } = await import('./production/job.mjs')
    return executeProductionJob(job, ctx)
  }
  const run = { tts: executeTtsJob, subtitle: executeSubtitleJob, narrated: executeNarratedJob }[pipeline] ?? executeElementsJob
  return run(job, entry, ctx)
}

async function executeElementsJob(job, entry, ctx) {
  const { outDir, config, phase, saveParams, withRetry } = ctx
  const params = job.params
  const req = params.request
  const { pack } = entry

  // 1. 规划
  let plan = req.plan
  if (!plan) {
    phase(`AI 规划元素（${pctOf('plan', 0)}%）`)
    try {
      plan = { ...(await withRetry(() => planSkill(config, entry, req.prompt, req.params))), source: 'ai' }
    } catch (e) {
      plan = { ...fallbackPlan(pack, req.prompt), source: 'fallback', notes: `AI 规划失败，整句作为一个元素：${String(e instanceof Error ? e.message : e).slice(0, 80)}` }
    }
    req.plan = plan
    saveParams(params)
  }
  const els = plan.elements

  // 2. 元素生图（已有文件直接复用）
  const aspect = assetAspect(req.params, els.length)
  let done = els.filter((_, i) => existsSync(path.join(outDir, elementImageName(job.id, i)))).length
  phase(`生成元素图 ${done}/${els.length}（${pctOf('assets', done / els.length)}%）`)
  const imageFails = []
  await Promise.all(els.map(async (el, i) => {
    const file = path.join(outDir, elementImageName(job.id, i))
    if (existsSync(file)) return
    try {
      await generateElementImage(config, withRetry, {
        prompt: assetPrompt(pack, el, req.params), model: pack.assets.models[0], size: aspect, quality: pack.assets.resolution,
      }, file)
    } catch (e) {
      imageFails.push({ index: i, label: el.label, error: errText(e) })
      return
    }
    done++
    phase(`生成元素图 ${done}/${els.length}（${pctOf('assets', done / els.length)}%）`)
  }))
  if (imageFails.length) throw new Error(imageFailMessage(imageFails, done, els.length))

  // 3. 渲染
  const request = {
    spec: SKILL_RENDER_SPEC,
    jobId: job.id,
    outDir,
    ffmpeg: resolveFfmpeg(),
    params: req.params,
    elements: els.map((el, i) => ({
      id: `e${i + 1}`, label: el.label, role: el.role, weight: el.weight, image: path.join(outDir, elementImageName(job.id, i)),
    })),
    outputs: { prefix: job.id, video: `${job.id}.webm`, still: `${job.id}_still.png` },
  }
  const requestFile = path.join(outDir, `${job.id}_request.json`)
  writeFileSync(requestFile, JSON.stringify(request, null, 2))
  phase(`准备渲染（${pctOf('render', 0)}%）`)
  const result = await runRenderer(entry, requestFile, {
    timeoutSec: pack.runtime.timeoutSec,
    onProgress: ({ phase: p, pct }) => phase(`${p}（${pctOf('render', p === '书写渲染' ? 0.1 + 0.85 * pct : p === '编码' ? 0.95 + 0.05 * pct : 0.1 * pct)}%）`),
  })

  const output = {
    spec: SKILL_OUTPUT_SPEC,
    jobId: job.id,
    skill: { id: pack.id, version: pack.version, name: pack.name },
    prompt: req.prompt,
    params: req.params,
    plan: { title: plan.title, notes: plan.notes, source: plan.source || 'user' },
    alpha: !!result.alpha,
    width: result.width,
    height: result.height,
    fps: result.fps,
    frames: result.frames,
    duration: result.duration,
    layout: result.layout,
    video: url(result.video),
    still: url(result.still),
    elements: result.elements.map((e, i) => ({
      ...e,
      draw: els[i]?.draw ?? '',
      weight: els[i]?.weight ?? 1,
      image: url(elementImageName(job.id, i)),
      mask: url(e.mask),
      cut: url(e.cut),
    })),
    manifest: url(`${job.id}.json`),
  }
  writeFileSync(path.join(outDir, `${job.id}.json`), JSON.stringify(output, null, 2))
  return output
}

/** narrated 进度：配音 0~10%，拆分 10~15%，之后生图（40%）与逐板渲染（60%）交错推进到 100% */
const narratedPct = (stage, local) => Math.round(stage === 'tts' ? 10 * local : stage === 'plan' ? 10 + 5 * local : 15 + 85 * local)
/** 元素生图并发数；和云端生图道一致 */
const NARRATED_IMAGE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TODO_AI_CONCURRENCY) || 4))

/**
 * 生一张元素图到 out。提交即扣费，所以网络波动只重试下载；提交返回的地址先落盘（out.url.json），
 * 下载失败后任务重试会先拿这个地址再下一次，地址失效才重新提交。
 */
export async function generateElementImage(config, withRetry, request, out) {
  const tmp = `${out}.part`
  const pending = `${out}.url.json`
  if (existsSync(pending)) {
    try {
      await withRetry(() => saveImageResult(config, JSON.parse(readFileSync(pending, 'utf8')), tmp))
      renameSync(tmp, out)
      rmSync(pending, { force: true })
      return
    } catch { rmSync(pending, { force: true }) }
  }
  const submitted = await withRetry(() => submitImageGeneration(config, request))
  if (submitted.kind === 'url') writeFileSync(pending, JSON.stringify(submitted))
  await withRetry(() => saveImageResult(config, submitted, tmp))
  // 下载完才改名，中途失败不会留下半张图被重试误复用
  renameSync(tmp, out)
  rmSync(pending, { force: true })
}

const errText = (e) => String(e instanceof Error ? e.message : e).slice(0, 120)

function imageFailMessage(fails, done, total) {
  const list = fails.sort((a, b) => a.index - b.index).map((f) => `「${f.label || `元素${f.index + 1}`}」${f.error}`).join('；')
  return `${fails.length} 个元素生图失败（成功的 ${done}/${total} 已保留，重试只补失败的）：${list}`
}

/**
 * 分板 → 渲染时间表（毫秒，绝对时间）。黑板在换板短语开口时切换，第一块从 0 开始，最后一块留到配音结束后 tail 秒。
 * 元素在锚点短语开口时起笔，最晚写到下一个元素起笔前（windowEndMs），实际书写时长由渲染端按墨量和书写速度定。
 */
export function narrationSchedule(plan, phrases, durationSec, tailSec) {
  const endMs = Math.round((durationSec + tailSec) * 1000)
  const at = (i) => Math.round(phrases[i].start * 1000)
  const boards = plan.scenes.map((s, k) => {
    const startMs = k === 0 ? 0 : at(s.start)
    const nextStart = k + 1 < plan.scenes.length ? at(plan.scenes[k + 1].start) : endMs
    let prev = startMs - 400
    // 第一块黑板的第一个元素随配音开口起笔，片头不空屏；之后各块由上一块留到本块起笔，不需要提前
    const starts = s.elements.map((e, j) => (prev = Math.max(k === 0 && j === 0 ? at(s.start) : at(e.at), prev + 400, startMs)))
    return { startMs, starts: starts.map((t) => Math.min(t, nextStart - 300)) }
  })
  return boards.map(({ startMs, starts }, k) => {
    // 上一块黑板一直留到下一块第一个元素起笔，两板硬切，中间不空屏
    const sceneEnd = k + 1 < boards.length ? boards[k + 1].starts[0] ?? boards[k + 1].startMs : endMs
    return {
      startMs,
      endMs: sceneEnd,
      elements: starts.map((t, j) => ({
        atMs: t,
        windowEndMs: Math.max(t + 300, (starts[j + 1] ?? sceneEnd) - 150),
      })),
    }
  })
}

/** 先进先出的并发闸：排在前面的黑板先拿到生图名额 */
function limiter(n) {
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= n || !waiting.length) return
    active++
    const { fn, resolve, reject } = waiting.shift()
    fn().then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next() })
}

export const narratedNames = (jobId, sceneId) => ({
  clips: `${jobId}_${sceneId}_clips.json`,
  request: `${jobId}_${sceneId}_request.json`,
})

/**
 * 口播 → 时间轴片段。每步产物一出来就写进 params.partial，前端轮询到即入轨：
 *   partial.voice   配音（先入轨，后面所有片段都链接它、按它的时间戳摆放）
 *   partial.hand    粉笔手图 + 笔尖锚点（编辑器「粉笔手书写」入场动画用）
 *   partial.scenes  逐块黑板追加：每个元素一份裁到自身框的透明素材（书写 WebM + 定格 PNG + 笔尖轨迹），box 为默认排版位置
 * 生图按元素并发，某块黑板的图齐了就排进渲染队列，和后面黑板的生图同时进行。重试时已落盘的图 / 已渲好的黑板直接复用。
 */
async function executeNarratedJob(job, entry, ctx) {
  const { outDir, config, phase, saveParams, withRetry } = ctx
  const params = job.params
  const req = params.request
  const { pack } = entry
  const names = ttsNames(job.id)
  const file = (k) => path.join(outDir, names[k])
  const tail = Number(req.params.tail ?? 0)

  // 1. 配音（逐字时间戳）→ 先上时间轴
  if (!existsSync(file('audio')) || !existsSync(file('timing'))) {
    phase(`合成配音（${narratedPct('tts', 0)}%）`)
    await withRetry(() => synthTimeline(req.prompt, {
      job: `todo_${job.id}`, textFile: file('script'), audioFile: file('audio'), timingFile: file('timing'), ...ttsVoice(req.params),
    }))
  }
  const timing = JSON.parse(readFileSync(file('timing'), 'utf8'))
  const phrases = timingPhrases(timing)
  if (!phrases.length) throw new Error('配音没有返回时间戳，无法对时')
  const duration = Number(timing.duration) || phrases.at(-1).end
  const narration = {
    text: req.prompt, duration, speaker: timing.speaker ?? null, audio: url(names.audio), timing: url(names.timing),
  }
  // lanes：这次生成要占几条轨，编辑器按整组找接续位置；分镜出来前画面轨按每块元素上限算
  const lanes = { audio: 1, video: pack.planner?.maxElements ?? 1 }
  const partial = params.partial = { voice: narration, tail, hand: null, total: null, lanes, scenes: [] }
  saveParams(params)

  // 2. 分板 + 元素
  let plan = req.plan
  if (!plan) {
    phase(`AI 拆分语句与元素（${narratedPct('plan', 0)}%）`)
    try {
      plan = { ...(await withRetry(() => planNarration(config, entry, phrases, req.params))), source: 'ai' }
    } catch (e) {
      plan = { ...fallbackNarrationPlan(pack, phrases), source: 'fallback', notes: `AI 拆分失败，按句各画一块：${String(e instanceof Error ? e.message : e).slice(0, 80)}` }
    }
    req.plan = plan
  }
  const schedule = narrationSchedule(plan, phrases, duration, tail)
  const offsets = []
  plan.scenes.reduce((n, s) => (offsets.push(n), n + s.elements.length), 0)
  const nEls = plan.scenes.reduce((n, s) => n + s.elements.length, 0)
  partial.total = { scenes: plan.scenes.length, elements: nEls }
  lanes.video = Math.max(1, ...plan.scenes.map((s) => s.elements.length))
  saveParams(params)

  // 3. 生图 ∥ 逐板渲染
  const imageOf = (k, j) => path.join(outDir, elementImageName(job.id, offsets[k] + j))
  let imagesDone = plan.scenes.reduce((n, s, k) => n + s.elements.filter((_, j) => existsSync(imageOf(k, j))).length, 0)
  let elsRendered = 0
  const report = (what) => phase(`${what} · 生图 ${imagesDone}/${nEls} · 黑板 ${partial.scenes.length}/${plan.scenes.length}（${narratedPct('work', 0.4 * imagesDone / nEls + 0.6 * elsRendered / nEls)}%）`)
  const gate = limiter(NARRATED_IMAGE_CONCURRENCY)
  let renderQueue = Promise.resolve()

  const publish = (k, result) => {
    const s = plan.scenes[k]
    if (result.hand && !partial.hand) partial.hand = { ...result.hand, url: url(result.hand.file) }
    partial.scenes.push({
      ...result.scene,
      index: k,
      fps: result.fps,
      elements: result.scene.elements.map((e, j) => ({
        ...e,
        draw: s.elements[j]?.draw ?? '',
        image: url(elementImageName(job.id, offsets[k] + j)),
        video: url(e.video), hold: url(e.hold), mask: url(e.mask), cut: url(e.cut),
      })),
    })
    partial.scenes.sort((a, b) => a.index - b.index)
    elsRendered += s.elements.length
    saveParams(params)
  }

  const renderScene = async (k) => {
    const s = plan.scenes[k]
    const sid = `s${k + 1}`
    const n = narratedNames(job.id, sid)
    const request = {
      spec: SKILL_RENDER_SPEC,
      jobId: job.id,
      mode: 'scene-clips',
      outDir,
      ffmpeg: resolveFfmpeg(),
      params: req.params,
      scene: {
        id: sid,
        startMs: schedule[k].startMs,
        endMs: schedule[k].endMs,
        elements: s.elements.map((el, j) => ({
          id: `${sid}e${j + 1}`, label: el.label, role: el.role, weight: el.weight, image: imageOf(k, j), ...schedule[k].elements[j],
        })),
      },
      outputs: { prefix: job.id },
    }
    const requestFile = path.join(outDir, n.request)
    writeFileSync(requestFile, JSON.stringify(request, null, 2))
    const result = await runRenderer(entry, requestFile, { timeoutSec: pack.runtime.timeoutSec, onProgress: () => {} })
    writeFileSync(path.join(outDir, n.clips), JSON.stringify(result))
    return result
  }

  const cachedScene = (k) => {
    const f = path.join(outDir, narratedNames(job.id, `s${k + 1}`).clips)
    if (!existsSync(f)) return null
    try {
      const r = JSON.parse(readFileSync(f, 'utf8'))
      // 老格式（整幅、带黑板底、没有笔尖轨迹）和旧书写效果（上色时手来回扫）的缓存不复用
      if (!(r.rev >= 2) || !r.scene.elements.every((e) => Array.isArray(e.tip) && e.crop)) return null
      const files = [r.hand?.file, ...r.scene.elements.flatMap((e) => [e.video, e.hold])].filter(Boolean)
      return files.every((name) => existsSync(path.join(outDir, name))) ? r : null
    } catch { return null }
  }

  report('开始')
  // 单个元素失败不牵连其它元素和其它黑板：图齐的板照常渲染入轨，最后汇总报错，重试时只补缺的图
  const imageFails = []
  const renderFails = []
  await Promise.all(plan.scenes.map(async (s, k) => {
    const cached = cachedScene(k)
    if (cached) { publish(k, cached); return }
    const ok = await Promise.all(s.elements.map((el, j) => gate(async () => {
      const out = imageOf(k, j)
      if (existsSync(out)) return true
      try {
        await generateElementImage(config, withRetry, {
          prompt: assetPrompt(pack, el, req.params), model: pack.assets.models[0], size: '1:1', quality: pack.assets.resolution,
        }, out)
      } catch (e) {
        imageFails.push({ index: offsets[k] + j, scene: k, label: el.label, error: errText(e) })
        partial.failed = [...imageFails].sort((a, b) => a.index - b.index)
        saveParams(params)
        report('生成元素图')
        return false
      }
      imagesDone++
      report('生成元素图')
      return true
    })))
    if (!ok.every(Boolean)) return
    const run = renderQueue.then(async () => {
      report(`渲染第 ${k + 1} 块黑板`)
      publish(k, await renderScene(k))
      report(`第 ${k + 1} 块黑板已入轨`)
    })
    renderQueue = run.catch(() => {})
    await run.catch((e) => { renderFails.push(`第 ${k + 1} 块黑板渲染失败：${errText(e)}`) })
  }))
  if (imageFails.length || renderFails.length) {
    throw new Error([imageFails.length && imageFailMessage(imageFails, imagesDone, nEls), ...renderFails].filter(Boolean).join('；'))
  }

  const width = Number(String(req.params.size).split('x')[0]) || 1280
  const height = Number(String(req.params.size).split('x')[1]) || 720
  const output = {
    spec: SKILL_OUTPUT_SPEC,
    jobId: job.id,
    skill: { id: pack.id, version: pack.version, name: pack.name },
    prompt: req.prompt,
    params: req.params,
    plan: { title: plan.title, notes: plan.notes, source: plan.source || 'ai' },
    alpha: true,
    width,
    height,
    fps: Number(req.params.fps) || 30,
    duration: Math.round((duration + tail) * 1000) / 1000,
    audio: narration.audio,
    tail,
    total: partial.total,
    lanes: partial.lanes,
    hand: partial.hand,
    scenes: partial.scenes,
    narration,
    manifest: url(`${job.id}.json`),
  }
  writeFileSync(path.join(outDir, `${job.id}.json`), JSON.stringify(output, null, 2))
  return output
}

async function executeTtsJob(job, entry, ctx) {
  const { outDir, phase, withRetry } = ctx
  const req = job.params.request
  const { pack } = entry
  const names = ttsNames(job.id)
  const file = (k) => path.join(outDir, names[k])

  if (!existsSync(file('audio')) || !existsSync(file('timing'))) {
    phase('合成配音')
    await withRetry(() => synthTimeline(req.prompt, {
      job: `todo_${job.id}`, textFile: file('script'), audioFile: file('audio'), timingFile: file('timing'), ...ttsVoice(req.params),
    }))
  }
  const timing = JSON.parse(readFileSync(file('timing'), 'utf8'))
  const output = {
    spec: SKILL_OUTPUT_SPEC,
    jobId: job.id,
    skill: { id: pack.id, version: pack.version, name: pack.name },
    prompt: req.prompt,
    params: req.params,
    duration: timing.duration,
    audio: url(names.audio),
    narration: {
      text: req.prompt,
      duration: timing.duration,
      speaker: timing.speaker ?? null,
      audio: url(names.audio),
      timing: url(names.timing),
    },
    manifest: url(`${job.id}.json`),
  }
  writeFileSync(path.join(outDir, `${job.id}.json`), JSON.stringify(output, null, 2))
  return output
}

async function executeSubtitleJob(job, entry, ctx) {
  const { outDir, phase } = ctx
  const req = job.params.request
  const { pack } = entry
  const src = req.source
  const asr = src?.mode === 'asr'
  if (!src || (!asr && !src.jobId)) throw new Error('缺少字幕来源')
  let audio, timing = null
  if (asr) {
    audio = src.file
    if (!audio || !existsSync(audio)) throw new Error('素材文件已不存在，无法语音识别')
  } else {
    audio = path.join(outDir, path.basename(src.audio))
    timing = path.join(outDir, path.basename(src.timing))
    if (!existsSync(audio) || !existsSync(timing)) throw new Error('配音文件已不存在，请重新生成配音')
  }
  const names = subtitleNames(job.id)

  const request = {
    spec: SKILL_RENDER_SPEC,
    jobId: job.id,
    outDir,
    ffmpeg: resolveFfmpeg(),
    params: req.params,
    // asr：没有文案，渲染端先语音识别出逐字文本和时间，再按同一套规则切条
    mode: asr ? 'asr' : 'script',
    script: asr ? '' : req.prompt,
    audio,
    timing,
    outputs: { prefix: job.id, video: `${job.id}.webm`, still: `${job.id}_still.png`, subtitles: names.subtitles, ass: names.ass },
  }
  const requestFile = path.join(outDir, `${job.id}_request.json`)
  writeFileSync(requestFile, JSON.stringify(request, null, 2))
  phase('准备渲染（0%）')
  const result = await runRenderer(entry, requestFile, {
    timeoutSec: pack.runtime.timeoutSec,
    // 语音识别占前 60%，文案对时只占 20%
    onProgress: ({ phase: p, pct }) => {
      const head = asr ? 0.6 : 0.2
      phase(`${p}（${Math.round(100 * (p === '编码' ? head + (1 - head) * pct : head * pct))}%）`)
    },
  })

  const cues = JSON.parse(readFileSync(path.join(outDir, result.subtitles), 'utf8'))
  const output = {
    spec: SKILL_OUTPUT_SPEC,
    jobId: job.id,
    skill: { id: pack.id, version: pack.version, name: pack.name },
    prompt: req.prompt,
    params: req.params,
    alpha: !!result.alpha,
    width: result.width,
    height: result.height,
    fps: result.fps,
    frames: result.frames,
    duration: result.duration,
    video: url(result.video),
    still: url(result.still),
    source: { mode: asr ? 'asr' : 'script', jobId: src.jobId ?? null, audio: src.audio, name: src.name ?? null, duration: src.duration ?? result.audioDuration ?? null },
    ...(asr ? { transcript: String(result.text ?? '') } : {}),
    subtitles: {
      url: url(result.subtitles),
      ass: url(result.ass),
      cues: cues.map(({ text, start, end }) => ({ text, start, end })),
    },
    manifest: url(`${job.id}.json`),
  }
  writeFileSync(path.join(outDir, `${job.id}.json`), JSON.stringify(output, null, 2))
  return output
}
