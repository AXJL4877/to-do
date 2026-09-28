/**
 * AI 生成队列（SQLite）+ 单 worker 串行。
 * ponytail: 并发=1；要并行多路时再加 claimNext 槽位。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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
import { compileAnimById, framePrompt, sheetPrompt } from './animPacks.mjs'
import { normalizeFrames, resolveFfmpeg, sliceGrid, writeAnimation } from './animBuild.mjs'
import { H3_QUALITIES, ensureH3, h3Download, h3Generate, h3UploadImage } from './h3Client.mjs'

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
    mode: body.mode,
    frames: body.frames,
    fps: body.fps,
    loop: body.loop,
    repeat: body.repeat,
    aspectRatio: body.size,
    resolution: body.quality,
    model: body.model,
    alpha: body.alpha,
    beats: body.beats,
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
  let refPath = null
  if (body.imageDataUrl) {
    const b64 = String(body.imageDataUrl).replace(/^data:image\/\w+;base64,/, '')
    refPath = path.join(AI_OUT, `${id}_ref.png`)
    writeFileSync(refPath, Buffer.from(b64, 'base64'))
  }
  insertJob.run(id, 'anim', plan.basePrompt, JSON.stringify(params), refPath, now, now)
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
}
const laneRunning = { cloud: 0, h3: 0 }
let staleCleared = false

function laneOf(row) {
  if (row.kind !== 'video') return 'cloud'
  try { return JSON.parse(row.params || '{}').engine === 'h3' ? 'h3' : 'cloud' } catch { return 'cloud' }
}

const TRANSIENT_RE = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|UND_ERR|network|timed? ?out|\b(429|502|503|504)\b/i
const AUTO_RETRIES = 2

async function runJob(job) {
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
 * 风格动画：拼图模式 1 次生图后切格；逐帧模式首帧文生图（或参考图），其余帧以首帧为参考图生图。
 * 产物：<id>.webm|mp4、<id>_fNN.png、拼图 <id>_sheet.png、清单 <id>.json（todo-anim-output/1）。
 */
async function runAnimJob(job) {
  const params = job.params
  const plan = params.plan
  const config = readAiConfig({ revealKey: true })
  const row = getJob.get(job.id)
  const refUrl = row?.ref_path && existsSync(row.ref_path) ? fileToDataUrl(row.ref_path) : ''
  const n = plan.frames

  let keyframes
  let sheetName = null
  if (plan.mode === 'sheet') {
    setPhase.run(`生成关键帧拼图（${n} 帧）…`, Date.now(), job.id)
    const sheetPath = path.join(AI_OUT, `${job.id}_sheet_raw`)
    const sheet = await generateImage(config, plan, sheetPrompt(plan, { hasRef: !!refUrl }), refUrl, sheetPath)
    sheetName = `${job.id}_sheet.png`
    writeFileSync(path.join(AI_OUT, sheetName), encodePng(sheet))
    keyframes = sliceGrid(sheet, plan.grid.cols, plan.grid.rows)
  } else {
    keyframes = []
    let anchorUrl = refUrl
    for (let i = 0; i < n; i++) {
      setPhase.run(`关键帧 ${i + 1}/${n}…`, Date.now(), job.id)
      const fromRef = !!anchorUrl
      const out = path.join(AI_OUT, `${job.id}_k${i + 1}_raw`)
      keyframes.push(await generateImage(config, plan, framePrompt(plan, i, { fromRef }), anchorUrl, out))
      if (!anchorUrl) anchorUrl = fileToDataUrl(out)
    }
  }

  setPhase.run(plan.cutout ? '逐帧抠像 · 对齐…' : '对齐关键帧…', Date.now(), job.id)
  const frames = normalizeFrames(keyframes, { cutout: plan.cutout, align: plan.align })
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
    mode: plan.mode,
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
    sheet: sheetName ? url(sheetName) : null,
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
