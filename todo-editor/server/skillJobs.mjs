/**
 * 技能任务执行，按 pack.pipeline 分流，渲染端统一走 todo-skill-render/1，产出清单 todo-skill-output/1：
 *   elements：规划 → 元素生图 → 渲染。元素图 <id>_el<N>.png 落盘后重试直接复用，不重复扣费。
 *   tts：文案 → 配音（TTS_timeline），产出 <id>_voice.wav + <id>_timing.json，已存在则重试直接复用。
 *   subtitle：取一条 tts 任务的文案 / 配音 / 时间戳 → 渲染（按逐字时间戳切条 + 透明底烧录）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { saveImageResult, submitImageGeneration } from './huniuClient.mjs'
import { assetAspect, assetPrompt, fallbackPlan, getSkillEntry, planSkill } from './skillPacks.mjs'
import { synthTimeline } from './ttsTimeline.mjs'
import { resolveFfmpeg } from './animBuild.mjs'

export const SKILL_RENDER_SPEC = 'todo-skill-render/1'
export const SKILL_OUTPUT_SPEC = 'todo-skill-output/1'
const PYTHON = process.env.TODO_PYTHON || 'python'

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

function runRenderer(entry, requestFile, { timeoutSec, onProgress }) {
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
  const run = { tts: executeTtsJob, subtitle: executeSubtitleJob }[entry.pack.pipeline] ?? executeElementsJob
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
  await Promise.all(els.map(async (el, i) => {
    const file = path.join(outDir, elementImageName(job.id, i))
    if (existsSync(file)) return
    const tmp = `${file}.part`
    await withRetry(async () => {
      const submitted = await submitImageGeneration(config, {
        prompt: assetPrompt(pack, el, req.params), model: pack.assets.models[0], size: aspect, quality: pack.assets.resolution,
      })
      await saveImageResult(config, submitted, tmp)
    })
    // 下载完才改名，中途失败不会留下半张图被重试误复用
    renameSync(tmp, file)
    done++
    phase(`生成元素图 ${done}/${els.length}（${pctOf('assets', done / els.length)}%）`)
  }))

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
