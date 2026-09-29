/**
 * AI 生成队列（SQLite）+ 单 worker 串行。
 * ponytail: 并发=1；要并行多路时再加 claimNext 槽位。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import {
  saveImageResult,
  submitImageGeneration,
} from './huniuClient.mjs'
import { readAiConfig } from './huniuConfig.mjs'
import { compileStyleById } from './stylePacks.mjs'
import { cutoutFile, decodeImage, encodePng } from './imageCutout.mjs'
import { characterPrompt, compileAnimById, spritePrompt } from './animPacks.mjs'
import { composeContinuationRef, normalizeFrames, resolveFfmpeg, sliceSprite, writeAnimation } from './animBuild.mjs'
import { H3_QUALITIES, ensureH3, h3Download, h3Generate, h3UploadImage } from './h3Client.mjs'
import { compileSkillJob, getSkillEntry } from './skillPacks.mjs'
import { elementImageName, executeSkillJob } from './skillJobs.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.join(ROOT, '.data')
/** 成果目录：与 /ai-generated/* URL 对应，正式包由 AI 服务托管 */
export const AI_OUT = path.join(DATA_DIR, 'ai-generated')
// 协作者可设 MISHI_ROOT；默认本机桌面「密匙」
const MISHI_ROOT = process.env.MISHI_ROOT || 'd:\\Desktop\\密匙'
const MISHI = path.join(MISHI_ROOT, 'run.py')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(AI_OUT, { recursive: true })

const db = new DatabaseSync(path.join(DATA_DIR, 'ai-assets.sqlite'))
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    params TEXT NOT NULL,
    ref_path TEXT,
    result_name TEXT,
    result_url TEXT,
    result_kind TEXT,
    duration REAL,
    error TEXT,
    phase TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs(status, created_at);
`)

const insertJob = db.prepare(`
  INSERT INTO ai_jobs
  (id, kind, status, prompt, params, ref_path, created_at, updated_at, phase)
  VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, '排队中')
`)
const listJobs = db.prepare(`
  SELECT id, kind, status, prompt, params, result_name, result_url, result_kind,
         duration, error, phase, created_at, updated_at
  FROM ai_jobs ORDER BY created_at DESC LIMIT ?
`)
const getJob = db.prepare('SELECT * FROM ai_jobs WHERE id = ?')
const listQueued = db.prepare(`
  SELECT id, kind, params FROM ai_jobs WHERE status='queued' ORDER BY created_at ASC
`)
const requeueJob = db.prepare(`
  UPDATE ai_jobs SET status='queued', phase='排队中', error=NULL, result_name=NULL, result_url=NULL,
    result_kind=NULL, updated_at=? WHERE id=? AND status='error'
`)
const claimById = db.prepare(`
  UPDATE ai_jobs SET status='running', phase=?, updated_at=? WHERE id=? AND status='queued'
`)
const listRunning = db.prepare(`SELECT id FROM ai_jobs WHERE status='running'`)
const updateJob = db.prepare(`
  UPDATE ai_jobs SET status=?, phase=?, result_name=?, result_url=?, result_kind=?,
    duration=?, error=?, updated_at=? WHERE id=?
`)
const setPhase = db.prepare(`UPDATE ai_jobs SET phase=?, updated_at=? WHERE id=?`)
const setParams = db.prepare(`UPDATE ai_jobs SET params=?, updated_at=? WHERE id=?`)
const deleteJob = db.prepare('DELETE FROM ai_jobs WHERE id=?')
const cancelQueued = db.prepare(`DELETE FROM ai_jobs WHERE id=? AND status='queued'`)
const ackDone = db.prepare(`
  UPDATE ai_jobs SET status='imported', phase='已入库', updated_at=?
  WHERE id=? AND status='done'
`)

function runPy(args) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
      ALL_PROXY: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*', MISHI_DIRECT: '1',
    }
    const p = spawn('python', [MISHI, ...args], { cwd: path.dirname(MISHI), env })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: (err || out || 'python exited').slice(0, 500) })
      }
    })
    p.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
}

function rowToJob(r) {
  if (!r) return null
  let params = {}
  try { params = JSON.parse(r.params || '{}') } catch { /* */ }
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    prompt: r.prompt,
    params,
    resultName: r.result_name || null,
    resultUrl: r.result_url || null,
    resultKind: r.result_kind || null,
    duration: r.duration ?? null,
    error: r.error || null,
    phase: r.phase || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function enqueueAiJob(body) {
  if (body.kind === 'skill' || body.skillId) return enqueueSkillJob(body)
  if (body.kind === 'anim' || body.animId) return enqueueAnimJob(body)
  if (body.styleId) return enqueueStyledJob(body)
  const kind = body.kind === 'video' ? 'video' : 'image'
  const prompt = String(body.prompt || '').trim()
  if (!prompt) throw new Error('缺少提示词')

  const id = `${kind === 'video' ? 'v' : 'i'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const engine = kind === 'video' && body.engine === 'h3' ? 'h3' : undefined
  const qualityMp = Number(body.qualityMp ?? H3_QUALITIES[0])
  if (engine && !H3_QUALITIES.includes(qualityMp)) throw new Error(`本地 H3 画质须为 ${H3_QUALITIES.join(' / ')}`)
  const params = {
    size: body.size || '',
    model: engine ? 'minimax-h3-local' : body.model || '',
    quality: body.quality || '',
    engine,
    qualityMp: engine ? qualityMp : undefined,
    duration: Math.min(10, Math.max(3, Number(body.duration) || 5)),
    autoTimeline: !!body.autoTimeline,
    width: body.width || null,
    height: body.height || null,
    /** texture = 花字纹理，由花字面板取用，不入媒体库 */
    purpose: body.purpose === 'texture' ? 'texture' : undefined,
  }

  let refPath = null
  if (body.imageDataUrl) {
    const b64 = String(body.imageDataUrl).replace(/^data:image\/\w+;base64,/, '')
    refPath = path.join(AI_OUT, `${id}_ref.png`)
    writeFileSync(refPath, Buffer.from(b64, 'base64'))
  }

  insertJob.run(id, kind, prompt, JSON.stringify(params), refPath, now, now)
  kickWorker()
  return rowToJob(getJob.get(id))
}

/** 风格包任务：提示词 / 画幅 / 模型全部由风格包编译，忽略前端自由字段 */
function enqueueStyledJob(body) {
  if (body.kind && body.kind !== 'image') throw new Error('风格包目前只支持生图')
  const compiled = compileStyleById(body.styleId, {
    inputs: body.styleInputs,
    aspectRatio: body.size,
    resolution: body.quality,
    model: body.model,
    cutout: body.cutout,
  })
  const id = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const params = {
    size: compiled.size,
    model: compiled.model,
    quality: compiled.quality,
    duration: 5,
    autoTimeline: !!body.autoTimeline,
    width: null,
    height: null,
    style: compiled.meta,
    cutout: compiled.cutout,
  }
  let refPath = compiled.refPath
  if (body.imageDataUrl) {
    const b64 = String(body.imageDataUrl).replace(/^data:image\/\w+;base64,/, '')
    refPath = path.join(AI_OUT, `${id}_ref.png`)
    writeFileSync(refPath, Buffer.from(b64, 'base64'))
  }
  insertJob.run(id, 'image', compiled.prompt, JSON.stringify(params), refPath, now, now)
  kickWorker()
  return rowToJob(getJob.get(id))
}

/** 风格动画任务：关键帧计划全部由动画包编译；imageDataUrl 作为角色参考 */
function enqueueAnimJob(body) {
  if (!body.animId) throw new Error('缺少 animId')
  const plan = compileAnimById(body.animId, {
    inputs: body.animInputs,
    fps: body.fps,
    loop: body.loop,
    repeat: body.repeat,
    resolution: body.quality,
    model: body.model,
    alpha: body.alpha,
    beats: body.beats,
    segments: body.segments,
  })
  const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const params = {
    size: plan.aspectRatio,
    model: plan.model,
    quality: plan.resolution,
    duration: 0,
    autoTimeline: !!body.autoTimeline,
    width: null,
    height: null,
    anim: plan.meta,
    plan,
    output: null,
  }
  // 角色参照：上传图 > 沿用某个旧动画任务的角色设定图 > 运行时自动生成
  let refPath = null
  if (body.imageDataUrl) {
    const b64 = String(body.imageDataUrl).replace(/^data:image\/\w+;base64,/, '')
    refPath = path.join(AI_OUT, `${id}_ref.png`)
    writeFileSync(refPath, Buffer.from(b64, 'base64'))
  } else if (body.characterFrom != null) {
    const from = String(body.characterFrom)
    if (!/^a_[a-z0-9_]+$/.test(from)) throw new Error('characterFrom 不合法')
    const src = path.join(AI_OUT, `${from}_char.png`)
    if (!existsSync(src)) throw new Error('找不到要沿用的角色参照图')
    refPath = path.join(AI_OUT, `${id}_ref.png`)
    writeFileSync(refPath, readFileSync(src))
    params.characterFrom = from
  }
  insertJob.run(id, 'anim', plan.basePrompt, JSON.stringify(params), refPath, now, now)
  kickWorker()
  return rowToJob(getJob.get(id))
}

/**
 * 技能包任务：提示词 + 参数按技能包编译；plan 可选（用户在工作台编辑过的规划）。
 * images[i] 为 dataUrl 时第 i 个元素直接用上传图，不再生图（须同时给 plan）。
 * subtitle 管线不收文案，二选一：
 * - sourceJobId：带配音（output.narration）的任务，文案 / 配音 / 时间戳都取自它；
 * - sourceMedia：{ url, path?, name? } 任意音视频，渲染端做语音识别出文案和时间。
 */
const ASR_MEDIA_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])

function narrationSource(sourceJobId) {
  const job = rowToJob(getJob.get(String(sourceJobId || '')))
  const n = job?.params?.output?.narration
  if (!job || !n?.text || !n.timing || !['done', 'imported'].includes(job.status)) return null
  return { mode: 'script', jobId: job.id, text: n.text, audio: n.audio, timing: n.timing, duration: n.duration }
}

/** 语音识别来源：AI 产物按 /ai-generated/ 文件名找；其余只认本机绝对路径上的音视频文件 */
function mediaSource(m) {
  if (!m || typeof m !== 'object') return null
  const url = typeof m.url === 'string' ? m.url.slice(0, 2000) : ''
  const name = (typeof m.name === 'string' ? m.name : '').replace(/[\r\n]/g, ' ').trim().slice(0, 80)
  let file = null
  const ai = /\/ai-generated\/([^/?#]+)(?:[?#].*)?$/.exec(url)
  if (ai) file = path.join(AI_OUT, path.basename(decodeURIComponent(ai[1])))
  else if (typeof m.path === 'string' && path.isAbsolute(m.path)) file = path.resolve(m.path)
  if (!file) throw new Error('这段素材没有本地文件（浏览器里导入的素材读不到，请在桌面版里烧录）')
  if (!ASR_MEDIA_EXT.has(path.extname(file).toLowerCase())) throw new Error(`不支持的音视频格式：${path.extname(file) || '无扩展名'}`)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`找不到素材文件：${path.basename(file)}`)
  return { mode: 'asr', jobId: null, text: '', audio: url, file, name: name || path.basename(file), duration: null }
}

function subtitleSource(body) {
  const narration = body.sourceJobId ? narrationSource(body.sourceJobId) : null
  const source = narration ?? mediaSource(body.sourceMedia)
  if (!source) throw new Error('这段音频没有配音文案和时间戳，也没有给出素材文件，烧不了字幕')
  return source
}

function enqueueSkillJob(body) {
  const entry = getSkillEntry(body.skillId)
  const source = entry.pack.pipeline === 'subtitle' ? subtitleSource(body) : null
  // 语音识别没有文案，任务标题用素材名；渲染端不读它
  const prompt = !source ? body.prompt : source.mode === 'asr' ? `语音识别 · ${source.name}` : source.text
  const compiled = compileSkillJob(entry, { prompt, params: body.params, plan: body.plan })
  const images = body.images == null ? [] : body.images
  if (!Array.isArray(images)) throw new Error('images 必须是数组')
  if (images.some(Boolean) && !compiled.plan) throw new Error('上传元素图时必须同时提供 plan')
  if (compiled.plan && images.length > compiled.plan.elements.length) throw new Error('images 多于规划元素')
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  images.forEach((dataUrl, i) => {
    if (!dataUrl) return
    const m = /^data:image\/(png|jpe?g|webp);base64,/.exec(String(dataUrl))
    if (!m) throw new Error(`images[${i}] 须为 png/jpg/webp 的 dataUrl`)
    writeFileSync(path.join(AI_OUT, elementImageName(id, i)), Buffer.from(String(dataUrl).slice(m[0].length), 'base64'))
  })
  const [w, h] = String(compiled.params.size || '').split('x').map(Number)
  const params = {
    size: compiled.params.size,
    model: '',
    quality: '',
    duration: compiled.params.duration,
    autoTimeline: !!body.autoTimeline,
    // 字幕要对齐的时间线片段（前端自用，服务端只透传）
    anchorClipId: typeof body.anchorClipId === 'string' ? body.anchorClipId.slice(0, 64) : null,
    width: w || null,
    height: h || null,
    skill: compiled.meta,
    request: { skillId: compiled.meta.id, prompt: compiled.prompt, params: compiled.params, plan: compiled.plan, ...(source ? { source } : {}) },
    output: null,
  }
  insertJob.run(id, 'skill', compiled.prompt, JSON.stringify(params), null, now, now)
  kickWorker()
  return rowToJob(getJob.get(id))
}

export function listAiJobs(limit = 40) {
  return listJobs.all(Math.min(100, Math.max(1, limit))).map(rowToJob)
}

export function getAiJob(id) {
  return rowToJob(getJob.get(id))
}

export function cancelAiJob(id) {
  const r = getJob.get(id)
  if (!r) return { ok: false, error: 'not found' }
  if (r.status === 'queued') {
    cancelQueued.run(id)
    return { ok: true, canceled: true }
  }
  if (r.status === 'done' || r.status === 'error' || r.status === 'imported') {
    deleteJob.run(id)
    return { ok: true, removed: true }
  }
  return { ok: false, error: '任务进行中，无法取消' }
}

/** CAS：仅 done → imported，避免多窗重复入库 */
export function ackAiJob(id) {
  const changes = ackDone.run(Date.now(), id).changes
  return { ok: changes > 0, imported: changes > 0 }
}

/** 失败任务重新入队（保留参数与参考图） */
export function retryAiJob(id) {
  const changes = requeueJob.run(Date.now(), id).changes
  if (!changes) return { ok: false, error: getJob.get(id) ? '只有失败的任务可以重试' : 'not found' }
  kickWorker()
  return { ok: true, job: rowToJob(getJob.get(id)) }
}

/** 云端生图 / 生视频互不阻塞；本地 H3 独占 GPU 且 h3-studio 拒绝并行，单独一条道 */
const LANE_LIMIT = {
  cloud: Math.max(1, Math.min(16, Number(process.env.TODO_AI_CONCURRENCY) || 4)),
  h3: 1,
  // 技能渲染吃满 CPU，本地串行
  skill: 1,
}
const laneRunning = { cloud: 0, h3: 0, skill: 0 }
let staleCleared = false

function laneOf(row) {
  if (row.kind === 'skill') return 'skill'
  if (row.kind !== 'video') return 'cloud'
  try { return JSON.parse(row.params || '{}').engine === 'h3' ? 'h3' : 'cloud' } catch { return 'cloud' }
}

const TRANSIENT_RE = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|UND_ERR|network|timed? ?out|\b(429|502|503|504)\b/i
const AUTO_RETRIES = 2

async function withTransientRetry(jobId, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= AUTO_RETRIES || !TRANSIENT_RE.test(String(e))) throw e
      const wait = 2000 * (attempt + 1)
      setPhase.run(`网络波动，${wait / 1000}s 后自动重试（${attempt + 1}/${AUTO_RETRIES}）`, Date.now(), jobId)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

async function runSkillJob(job) {
  const output = await executeSkillJob(job, {
    outDir: AI_OUT,
    config: readAiConfig({ revealKey: true }),
    phase: (s) => setPhase.run(s, Date.now(), job.id),
    saveParams: (p) => setParams.run(JSON.stringify(p), Date.now(), job.id),
    withRetry: (fn) => withTransientRetry(job.id, fn),
  })
  const params = job.params
  params.width = output.width
  params.height = output.height
  params.duration = output.duration
  params.output = output
  setParams.run(JSON.stringify(params), Date.now(), job.id)
  const result = output.video ?? output.audio
  updateJob.run(
    'done', output.alpha ? '完成 · 透明通道' : '完成', path.basename(result), result, output.video ? 'video' : 'audio',
    output.duration, null, Date.now(), job.id,
  )
}

async function runJob(job) {
  if (job.kind === 'skill') return runSkillJob(job)
  if (job.kind === 'anim') return runAnimJob(job)
  if (job.kind === 'video') return runVideoJob(job)
  for (let attempt = 0; ; attempt++) {
    try {
      return await runImageJob(job)
    } catch (e) {
      if (attempt >= AUTO_RETRIES || !TRANSIENT_RE.test(String(e))) throw e
      const wait = 2000 * (attempt + 1)
      setPhase.run(`网络波动，${wait / 1000}s 后自动重试（${attempt + 1}/${AUTO_RETRIES}）`, Date.now(), job.id)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

export function kickWorker() {
  if (!staleCleared) {
    staleCleared = true
    // 仅清启动前残留（崩溃留下的 running）
    for (const r of listRunning.all()) {
      updateJob.run('error', '中断', null, null, null, null, 'worker 重启，任务中断', Date.now(), r.id)
    }
  }
  for (const row of listQueued.all()) {
    const lane = laneOf(row)
    if (laneRunning[lane] >= LANE_LIMIT[lane]) continue
    if (!claimById.run('启动…', Date.now(), row.id).changes) continue
    const job = rowToJob(getJob.get(row.id))
    if (!job) continue
    laneRunning[lane]++
    void runJob(job)
      .catch((e) => {
        updateJob.run('error', '失败', null, null, null, null, String(e).slice(0, 400), Date.now(), job.id)
      })
      .finally(() => {
        laneRunning[lane]--
        kickWorker()
      })
  }
}

async function runImageJob(job) {
  const filePath = path.join(AI_OUT, `${job.id}.png`)
  const params = job.params
  setPhase.run('提交生图…', Date.now(), job.id)

  const config = readAiConfig({ revealKey: true })
  const row = getJob.get(job.id)
  let imageDataUrl = ''
  if (row?.ref_path && existsSync(row.ref_path)) {
    const buf = readFileSync(row.ref_path)
    const ext = path.extname(row.ref_path).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    imageDataUrl = `data:${mime};base64,${buf.toString('base64')}`
  }

  const submitted = await submitImageGeneration(config, {
    prompt: job.prompt,
    model: params.model || 'gpt-image-2',
    size: params.size || '',
    quality: params.quality || '',
    imageDataUrl,
  })

  setPhase.run('下载图片…', Date.now(), job.id)
  if (!params.cutout) {
    const file = await saveImageResult(config, submitted, filePath)
    const name = path.basename(file)
    updateJob.run(
      'done', '完成', name, `/ai-generated/${name}`, 'image',
      null, null, Date.now(), job.id,
    )
    return
  }

  const rawPath = path.join(AI_OUT, `${job.id}_raw`)
  await saveImageResult(config, submitted, rawPath)
  setPhase.run('抠像中…', Date.now(), job.id)
  let name = path.basename(filePath)
  let phase = '完成 · 透明底'
  try {
    const { width, height } = cutoutFile(rawPath, filePath, params.cutout)
    params.width = width
    params.height = height
    setParams.run(JSON.stringify(params), Date.now(), job.id)
  } catch (e) {
    // 抠像失败保留原图，不丢生成结果
    const ext = readFileSync(rawPath)[0] === 0xff ? '.jpg' : '.png'
    name = `${job.id}${ext}`
    writeFileSync(path.join(AI_OUT, name), readFileSync(rawPath))
    phase = `完成 · 未抠像（${String(e instanceof Error ? e.message : e).slice(0, 60)}）`
  }
  updateJob.run(
    'done', phase, name, `/ai-generated/${name}`, 'image',
    null, null, Date.now(), job.id,
  )
}

function fileToDataUrl(file) {
  const buf = readFileSync(file)
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function generateImage(config, plan, prompt, imageDataUrl, outPath) {
  const submitted = await submitImageGeneration(config, {
    prompt, model: plan.model, size: plan.aspectRatio, quality: plan.resolution, imageDataUrl,
  })
  await saveImageResult(config, submitted, outPath)
  return decodeImage(readFileSync(outPath))
}

/**
 * 风格动画：先定角色参照图，再逐段生成 N×N 精灵图（续段首帧接上一段末帧），切格后统一抠像 / 对齐 / 合成。
 * 产物：<id>.webm|mp4、<id>_fNN.png、拼图 <id>_sheet[k].png、角色 <id>_char.png、清单 <id>.json（todo-anim-output/1）。
 */
async function runAnimJob(job) {
  const params = job.params
  const plan = params.plan
  const config = readAiConfig({ revealKey: true })
  const row = getJob.get(job.id)
  const n = plan.frames
  const { cols, rows } = plan.grid
  const segs = plan.segments?.length ?? 1

  const withRetry = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        if (attempt >= AUTO_RETRIES || !TRANSIENT_RE.test(String(e))) throw e
        const wait = 2000 * (attempt + 1)
        setPhase.run(`网络波动，${wait / 1000}s 后自动重试（${attempt + 1}/${AUTO_RETRIES}）`, Date.now(), job.id)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }

  // 1. 角色参照：有上传/沿用的参考图就用它，否则先按同风格生成一张角色设定图；存成 <id>_char.png 供以后沿用
  const charName = `${job.id}_char.png`
  let character
  if (row?.ref_path && existsSync(row.ref_path)) {
    character = decodeImage(readFileSync(row.ref_path))
  } else {
    setPhase.run('生成角色参照图…', Date.now(), job.id)
    character = await withRetry(() => generateImage(config, plan, characterPrompt(plan), '', path.join(AI_OUT, `${job.id}_char_raw`)))
  }
  writeFileSync(path.join(AI_OUT, charName), encodePng(character))
  const charUrl = `data:image/png;base64,${encodePng(character).toString('base64')}`

  // 2. 逐段生成精灵图：第 1 段参照角色图，之后参照「角色图 | 上一段末帧」拼图，首帧接上一段末帧
  const sheetNames = []
  const allCells = []
  let lastCell = null
  for (let k = 0; k < segs; k++) {
    const tag = segs > 1 ? `第 ${k + 1}/${segs} 段 · ` : ''
    setPhase.run(`${tag}生成 ${cols}×${rows} 精灵图（${n} 帧）…`, Date.now(), job.id)
    const continuation = k > 0 && !!lastCell
    const refUrl = continuation
      ? `data:image/png;base64,${encodePng(composeContinuationRef(character, lastCell)).toString('base64')}`
      : charUrl
    const sheet = await withRetry(() => generateImage(
      config, plan, spritePrompt(plan, { hasRef: true, segment: k, continuation }), refUrl,
      path.join(AI_OUT, `${job.id}_sheet${k + 1}_raw`),
    ))
    const sheetName = segs > 1 ? `${job.id}_sheet${k + 1}.png` : `${job.id}_sheet.png`
    writeFileSync(path.join(AI_OUT, sheetName), encodePng(sheet))
    sheetNames.push(sheetName)
    const cells = sliceSprite(sheet, cols, rows)
    // 续段首帧是上一段末帧的重画，丢掉避免同一姿势停顿
    allCells.push(...(k > 0 ? cells.slice(1) : cells))
    lastCell = cells[cells.length - 1]
  }
  const sheetName = sheetNames[0]

  const total = allCells.length
  setPhase.run(plan.cutout ? `切成 ${total} 帧 · 抠像 · 对齐…` : `切成 ${total} 帧 · 对齐…`, Date.now(), job.id)
  const frames = normalizeFrames(allCells, { cutout: plan.cutout, align: plan.align })
  setPhase.run(plan.cutout ? '合成透明动画…' : '合成动画…', Date.now(), job.id)
  const built = await writeAnimation(frames, {
    outDir: AI_OUT, id: job.id, fps: plan.fps, loop: plan.loop, repeat: plan.repeat, alpha: !!plan.cutout,
  })

  const url = (name) => `/ai-generated/${name}`
  const output = {
    spec: 'todo-anim-output/1',
    jobId: job.id,
    anim: { id: plan.meta.id, version: plan.meta.version, name: plan.meta.name },
    alpha: !!plan.cutout,
    grid: plan.grid,
    fps: plan.fps,
    loop: plan.loop,
    repeat: plan.repeat,
    frameCount: frames.length,
    playFrames: built.playFrames,
    duration: built.duration,
    width: built.width,
    height: built.height,
    video: url(built.video),
    frames: built.frames.map(url),
    sheet: url(sheetName),
    sheets: sheetNames.map(url),
    segments: plan.segments ?? [],
    character: url(charName),
    manifest: url(`${job.id}.json`),
  }
  writeFileSync(path.join(AI_OUT, `${job.id}.json`), JSON.stringify(output, null, 2))
  params.width = built.width
  params.height = built.height
  params.duration = built.duration
  params.output = output
  setParams.run(JSON.stringify(params), Date.now(), job.id)
  updateJob.run(
    'done', plan.cutout ? '完成 · 透明通道' : '完成', built.video, url(built.video), 'video',
    built.duration, null, Date.now(), job.id,
  )
}

function probeVideo(file) {
  try {
    const ffprobe = resolveFfmpeg().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'))
    const out = execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
    ], { encoding: 'utf8', windowsHide: true })
    const j = JSON.parse(out)
    const s = j.streams?.[0]
    return s ? { width: s.width, height: s.height, duration: Number(j.format?.duration) || undefined } : null
  } catch {
    return null
  }
}

/** 本地 MiniMax H3：h3-studio 出片后拉回 AI_OUT */
async function runH3VideoJob(job) {
  const phase = (s) => setPhase.run(s, Date.now(), job.id)
  const row = getJob.get(job.id)
  await ensureH3(phase)
  let firstFrame = null
  if (row?.ref_path && existsSync(row.ref_path)) {
    phase('上传首帧…')
    firstFrame = await h3UploadImage(row.ref_path)
  }
  phase('提交本地 H3…')
  const dur = job.params.duration || 5
  const { url } = await h3Generate({ prompt: job.prompt, seconds: dur, qualityMp: job.params.qualityMp, firstFrame }, phase)
  phase('拉回成片…')
  const name = `${job.id}.mp4`
  const file = await h3Download(url, path.join(AI_OUT, name))
  const probed = probeVideo(file)
  if (probed) {
    Object.assign(job.params, probed)
    setParams.run(JSON.stringify(job.params), Date.now(), job.id)
  }
  updateJob.run('done', '完成 · 本地 H3', name, `/ai-generated/${name}`, 'video', probed?.duration ?? dur, null, Date.now(), job.id)
}

async function runVideoJob(job) {
  if (job.params.engine === 'h3') return runH3VideoJob(job)
  const row = getJob.get(job.id)
  const refPath = row?.ref_path
  const outPath = path.join(AI_OUT, `${job.id}.mp4`)
  const dur = job.params.duration || 5

  let imageUrl = null
  if (refPath && existsSync(refPath)) {
    setPhase.run('上传参考图…', Date.now(), job.id)
    const host = await runPy([
      'host', '--file', refPath, '--path', `mishi-smoke/todo-editor/${job.id}.png`,
    ])
    if (!host.ok || !host.url) {
      updateJob.run('error', '上传失败', null, null, null, null, String(host.error || 'host 失败').slice(0, 400), Date.now(), job.id)
      return
    }
    imageUrl = String(host.url)
  }

  setPhase.run(imageUrl ? '提交图生视频…' : '提交文生视频…', Date.now(), job.id)
  const args = [
    'video', '--kind', 'grok', '--prompt', job.prompt,
    '--duration', String(dur), '--name', job.id, '--out', outPath, '--no-wait',
  ]
  if (imageUrl) args.push('--image', imageUrl)

  const submitted = await runPy(args)
  if (submitted.ok === false && submitted.error) {
    updateJob.run('error', '提交失败', null, null, null, null, String(submitted.error).slice(0, 400), Date.now(), job.id)
    return
  }

  setPhase.run('生成中…', Date.now(), job.id)
  const polled = await runPy(['video', '--poll', job.id])
  if (!polled.ok) {
    updateJob.run('error', '生成失败', null, null, null, null, String(polled.error || '生视频失败').slice(0, 400), Date.now(), job.id)
    return
  }
  const file = String(polled.file || outPath)
  const name = path.basename(file)
  updateJob.run(
    'done', '完成', name, `/ai-generated/${name}`, 'video',
    dur, null, Date.now(), job.id,
  )
}
