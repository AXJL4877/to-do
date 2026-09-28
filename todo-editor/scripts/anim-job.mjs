#!/usr/bin/env node
/**
 * 风格动画标准指令（走 AI HTTP 服务；每条命令 stdout 输出一行 JSON）。
 *
 *   node scripts/anim-job.mjs list
 *   node scripts/anim-job.mjs start --anim builtin.doodle-figure \
 *        --set character="圆脑袋火柴小人" --set action="拿起水杯喝水再放下" \
 *        [--mode sheet|sequence] [--frames 6] [--beat "伸手拿杯" --beat ...] \
 *        [--fps 6] [--loop forward|pingpong] [--repeat 1] [--aspect 1:1] [--resolution 2K] \
 *        [--alpha | --no-alpha] [--ref 角色参考.png]
 *   node scripts/anim-job.mjs status <jobId>
 *   node scripts/anim-job.mjs fetch <jobId> --out <目录> [--wait] [--timeout 900]
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

function print(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  if (cmd === 'list') {
    const r = await api('GET', '/api/ai-anims')
    print({ ok: !!r.ok, anims: (r.anims || []).map((a) => ({ id: a.id, name: a.name, inputs: a.inputs, keyframes: a.keyframes, playback: a.playback, alpha: !!a.cutout })), errors: r.errors || [] })
  }

  if (cmd === 'start') {
    const animId = one('anim')
    if (!animId) print({ ok: false, error: '缺少 --anim' }, 2)
    const inputs = {}
    for (const kv of take('set')) {
      const i = kv.indexOf('=')
      if (i <= 0) print({ ok: false, error: `--set 须为 key=value：${kv}` }, 2)
      inputs[kv.slice(0, i)] = kv.slice(i + 1)
    }
    const ref = one('ref')
    const alpha = flag('alpha') ? true : flag('no-alpha') ? false : undefined
    const beats = take('beat')
    const r = await api('POST', '/api/ai-jobs', {
      kind: 'anim',
      animId,
      animInputs: inputs,
      mode: one('mode'),
      frames: num('frames'),
      beats: beats.length ? beats : undefined,
      fps: num('fps'),
      loop: one('loop'),
      repeat: num('repeat'),
      size: one('aspect'),
      quality: one('resolution'),
      alpha,
      imageDataUrl: ref ? `data:image/png;base64,${readFileSync(ref).toString('base64')}` : undefined,
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
    const deadline = Date.now() + (num('timeout') ?? 900) * 1000
    if (!id || !out) print({ ok: false, error: '用法: fetch <jobId> --out <目录> [--wait]' }, 2)
    let r = await api('GET', `/api/ai-jobs/${encodeURIComponent(id)}/output`)
    while (wait && !r.ok && (r.status === 'queued' || r.status === 'running') && Date.now() < deadline) {
      await sleep(3000)
      r = await api('GET', `/api/ai-jobs/${encodeURIComponent(id)}/output`)
    }
    if (!r.ok) print({ ok: false, status: r.status, phase: r.phase, error: r.error }, 1)
    const o = r.output
    mkdirSync(out, { recursive: true })
    const local = (u) => path.join(out, path.basename(u))
    const files = {
      video: await download(o.video, local(o.video)),
      frames: [],
      sheet: o.sheet ? await download(o.sheet, local(o.sheet)) : null,
    }
    for (const f of o.frames || []) files.frames.push(await download(f, local(f)))
    const manifest = path.join(out, `${id}.json`)
    writeFileSync(manifest, JSON.stringify({ ...o, files }, null, 2))
    print({ ok: true, jobId: id, manifest, ...files, alpha: o.alpha, duration: o.duration, width: o.width, height: o.height })
  }

  print({ ok: false, error: `未知命令 ${cmd ?? ''}（list / start / status / fetch）` }, 2)
} catch (e) {
  print({ ok: false, error: e instanceof Error ? e.message : String(e) }, 1)
}
