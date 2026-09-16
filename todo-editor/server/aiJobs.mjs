/**
 * AI 生成队列（SQLite）+ 单 worker 串行。
 * ponytail: 并发=1；要并行多路时再加 claimNext 槽位。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  saveImageResult,
  submitImageGeneration,
} from './huniuClient.mjs'
import { readAiConfig } from './huniuConfig.mjs'

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
const nextQueued = db.prepare(`
  SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1
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
  const kind = body.kind === 'video' ? 'video' : 'image'
  const prompt = String(body.prompt || '').trim()
  if (!prompt) throw new Error('缺少提示词')

  const id = `${kind === 'video' ? 'v' : 'i'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const params = {
    size: body.size || '',
    model: body.model || '',
    quality: body.quality || '',
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

let busy = false

export function kickWorker() {
  if (busy) return
  busy = true
  void (async () => {
    try {
      // 仅清启动前残留（崩溃留下的 running）
      for (const r of listRunning.all()) {
        updateJob.run('error', '中断', null, null, null, null, 'worker 重启，任务中断', Date.now(), r.id)
      }
      while (true) {
        const next = nextQueued.get()
        if (!next) break
        const cas = claimById.run('启动…', Date.now(), next.id)
        if (!cas.changes) continue
        const job = rowToJob(getJob.get(next.id))
        if (!job) continue
        try {
          if (job.kind === 'image') await runImageJob(job)
          else await runVideoJob(job)
        } catch (e) {
          updateJob.run('error', '失败', null, null, null, null, String(e).slice(0, 400), Date.now(), job.id)
        }
      }
    } finally {
      busy = false
      if (nextQueued.get()) setTimeout(() => kickWorker(), 30)
    }
  })()
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
    imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`
  }

  const submitted = await submitImageGeneration(config, {
    prompt: job.prompt,
    model: params.model || 'gpt-image-2',
    size: params.size || '',
    quality: params.quality || '',
    imageDataUrl,
  })

  setPhase.run('下载图片…', Date.now(), job.id)
  const file = await saveImageResult(config, submitted, filePath)
  const name = path.basename(file)
  updateJob.run(
    'done', '完成', name, `/ai-generated/${name}`, 'image',
    null, null, Date.now(), job.id,
  )
}

async function runVideoJob(job) {
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
