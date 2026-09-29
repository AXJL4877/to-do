#!/usr/bin/env node
/**
 * 技能包标准指令（走 AI HTTP 服务；每条命令 stdout 输出一行 JSON）。协议见 server/skills/<id>/PROTOCOL.md。
 *
 *   node scripts/skill-job.mjs list
 *   node scripts/skill-job.mjs start --skill builtin.chalk-hand --prompt "整段口播" [--set drawSpeed=1.5 --set background=transparent ...]
 *   node scripts/skill-job.mjs plan  --skill <elements 包> --prompt "……" [--set key=value ...]
 *   node scripts/skill-job.mjs start --skill <elements 包> --prompt "……" \
 *        [--set duration=10 ...] [--plan plan.json] \
 *        [--image 1=元素1.png --image 2=元素2.png]（上传元素图须同时给 --plan）
 *   node scripts/skill-job.mjs start --skill builtin.tts-voice --prompt "口播文案"
 *   node scripts/skill-job.mjs start --skill builtin.voice-subtitle --source <配音 jobId> [--set font=kaiti --set fontPx=64 --set bottomPct=16 ...]
 *   node scripts/skill-job.mjs status <jobId>
 *   node scripts/skill-job.mjs fetch <jobId> --out <目录> [--wait] [--timeout 1800]
 *
 * 服务地址：--base 或环境变量 TODO_AI_BASE，默认 http://127.0.0.1:5173（npm run dev）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const cmd = argv.shift()

function take(name) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] != null) { out.push(argv[i + 1]); argv.splice(i, 2); i-- }
  }
  return out
}
function flag(name) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return false
  argv.splice(i, 1)
  return true
}
const one = (name) => take(name).pop()
const num = (name) => { const v = one(name); return v == null ? undefined : Number(v) }

const base = (one('base') || process.env.TODO_AI_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '')

/** 不用 process.exit：Windows 上 fetch 的连接还在关闭时退出会触发 libuv 断言崩溃 */
class Done extends Error {}
function print(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exitCode = code
  throw new Done()
}

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function download(url, file) {
  const res = await fetch(`${base}${url}`)
  if (!res.ok) throw new Error(`下载失败 ${url} (${res.status})`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

/** 服务端按参数类型校验并转换，这里只做数字字面量的初步识别 */
function readParams() {
  const params = {}
  for (const kv of take('set')) {
    const i = kv.indexOf('=')
    if (i <= 0) print({ ok: false, error: `--set 须为 key=value：${kv}` }, 2)
    const v = kv.slice(i + 1)
    params[kv.slice(0, i)] = v !== '' && Number.isFinite(Number(v)) && !/^0\d/.test(v) ? Number(v) : v
  }
  return params
}

function readImages() {
  const images = []
  for (const kv of take('image')) {
    const m = /^(\d+)=(.+)$/.exec(kv)
    if (!m) print({ ok: false, error: `--image 须为 序号=文件：${kv}` }, 2)
    const ext = path.extname(m[2]).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png'
    images[Number(m[1]) - 1] = `data:image/${ext};base64,${readFileSync(m[2]).toString('base64')}`
  }
  return images.length ? Array.from(images, (v) => v ?? null) : undefined
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  if (cmd === 'list') {
    const r = await api('GET', '/api/ai-skills')
    print({
      ok: !!r.ok,
      skills: (r.skills || []).map((s) => ({
        id: s.id, name: s.name, version: s.version, output: s.output,
        params: s.params.map((p) => ({ id: p.id, type: p.type, default: p.default, ...(p.options ? { options: p.options.map((o) => o.value) } : { min: p.min, max: p.max }) })),
      })),
      errors: r.errors || [],
    })
  }

  if (cmd === 'plan' || cmd === 'start') {
    const skillId = one('skill')
    const prompt = one('prompt')
    const sourceJobId = one('source')
    if (!skillId || !(prompt || sourceJobId)) print({ ok: false, error: '缺少 --skill，或 --prompt / --source' }, 2)
    const params = readParams()
    if (cmd === 'plan') {
      const r = await api('POST', '/api/ai-skill-plan', { skillId, prompt, params })
      if (!r.ok) print({ ok: false, error: r.error }, 1)
      print({ ok: true, plan: r.plan })
    }
    const planFile = one('plan')
    const r = await api('POST', '/api/ai-jobs', {
      kind: 'skill',
      skillId,
      prompt,
      sourceJobId,
      params,
      plan: planFile ? JSON.parse(readFileSync(planFile, 'utf8')) : undefined,
      images: readImages(),
    })
    if (!r.ok) print({ ok: false, error: r.error }, 1)
    print({ ok: true, jobId: r.job.id, status: r.job.status })
  }

  if (cmd === 'status') {
    const id = argv.shift()
    const r = await api('GET', `/api/ai-jobs/${encodeURIComponent(id || '')}`)
    if (!r.ok) print({ ok: false, error: r.error }, 1)
    print({ ok: true, jobId: r.job.id, status: r.job.status, phase: r.job.phase, error: r.job.error })
  }

  if (cmd === 'fetch') {
    const id = argv.shift()
    const out = one('out')
    const wait = flag('wait')
    const deadline = Date.now() + (num('timeout') ?? 1800) * 1000
    if (!id || !out) print({ ok: false, error: '用法: fetch <jobId> --out <目录> [--wait]' }, 2)
    let r = await api('GET', `/api/ai-jobs/${encodeURIComponent(id)}/output`)
    while (wait && !r.ok && (r.status === 'queued' || r.status === 'running') && Date.now() < deadline) {
      await sleep(3000)
      r = await api('GET', `/api/ai-jobs/${encodeURIComponent(id)}/output`)
    }
    if (!r.ok) print({ ok: false, status: r.status, phase: r.phase, error: r.error }, 1)
    const o = r.output
    if (o.spec !== 'todo-skill-output/1') print({ ok: false, error: `${id} 不是技能包任务` }, 1)
    mkdirSync(out, { recursive: true })
    const local = (u) => path.join(out, path.basename(u))
    const files = {}
    if (o.video) {
      files.video = await download(o.video, local(o.video))
      files.still = await download(o.still, local(o.still))
    }
    if (o.elements) {
      files.masks = []
      for (const e of o.elements) files.masks.push(await download(e.mask, local(e.mask)))
    }
    if (o.narration) {
      files.audio = await download(o.narration.audio, local(o.narration.audio))
      files.timing = await download(o.narration.timing, local(o.narration.timing))
    }
    if (o.subtitles) {
      files.subtitles = await download(o.subtitles.url, local(o.subtitles.url))
      files.ass = await download(o.subtitles.ass, local(o.subtitles.ass))
    }
    const manifest = path.join(out, `${id}.json`)
    writeFileSync(manifest, JSON.stringify({ ...o, files }, null, 2))
    print({ ok: true, jobId: id, manifest, ...files, masks: undefined, alpha: o.alpha, duration: o.duration, width: o.width, height: o.height })
  }

  print({ ok: false, error: `未知命令 ${cmd ?? ''}（list / plan / start / status / fetch）` }, 2)
} catch (e) {
  if (!(e instanceof Done)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`)
    process.exitCode = 1
  }
}
