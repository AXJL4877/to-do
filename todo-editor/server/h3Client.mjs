/**
 * 本地 MiniMax H3：经 h3-studio（默认 :8787，背后是 ComfyUI :8188）出片。
 * 环境变量：H3_STUDIO_BASE、H3_STUDIO_DIR、H3_COMFY_DIR（用于按需自动启动）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const H3_BASE = (process.env.H3_STUDIO_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const STUDIO_DIR = process.env.H3_STUDIO_DIR || 'D:\\desktop\\jiaohuanji1\\h3-studio'
const COMFY_DIR = process.env.H3_COMFY_DIR || 'E:\\ComfyUI\\ComfyUI_windows_portable'
/** 8GB 显存实测：0.4MP 稳定，0.7MP 可能爆显存 */
export const H3_QUALITIES = [0.4, 0.55, 0.7]
export const H3_SEGMENT_SECONDS = 5

async function call(method, url, body, timeoutMs = 20000) {
  const res = await fetch(`${H3_BASE}${url}`, {
    method,
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { error: text.slice(0, 300) } }
  if (!res.ok) throw new Error(json.error || json.status || `H3 ${method} ${url} → ${res.status}`)
  return json
}

export async function h3Health() {
  try {
    const h = await call('GET', '/api/health', null, 8000)
    return { studio: true, comfy: !!h.comfy_up }
  } catch {
    return { studio: false, comfy: false }
  }
}

function launch(cmd, args, cwd) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', H3_STUDIO_HOST: '127.0.0.1' }
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

let starting = null

/** 本地服务没起时自动拉起 ComfyUI + h3-studio，等到 ComfyUI 就绪（首次约 2~4 分钟） */
export function ensureH3(onPhase = () => {}) {
  if (starting) return starting
  starting = (async () => {
    let h = await h3Health()
    if (h.studio && h.comfy) return h
    if (!h.comfy) {
      const py = path.join(COMFY_DIR, 'python_embeded', 'python.exe')
      if (!existsSync(py)) throw new Error(`找不到本地 ComfyUI：${COMFY_DIR}（可设 H3_COMFY_DIR）`)
      onPhase('启动本地 ComfyUI…')
      launch(py, ['-s', 'ComfyUI\\main.py', '--windows-standalone-build', '--listen', '127.0.0.1', '--port', '8188'], COMFY_DIR)
    }
    if (!h.studio) {
      if (!existsSync(path.join(STUDIO_DIR, 'server.py'))) throw new Error(`找不到 h3-studio：${STUDIO_DIR}（可设 H3_STUDIO_DIR）`)
      onPhase('启动 h3-studio…')
      launch('python', ['server.py'], STUDIO_DIR)
    }
    const deadline = Date.now() + 6 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000))
      h = await h3Health()
      if (h.studio && h.comfy) return h
      onPhase(h.studio ? '等待 ComfyUI 加载节点…' : '等待 h3-studio…')
    }
    throw new Error('本地 H3 启动超时（6 分钟），请查看 ComfyUI 窗口日志')
  })().finally(() => { starting = null })
  return starting
}

/** 首帧图上传到 ComfyUI input，返回 comfy 文件名 */
export async function h3UploadImage(file) {
  const fd = new FormData()
  fd.append('file', new Blob([readFileSync(file)]), path.basename(file))
  const r = await call('POST', '/api/upload', fd, 120000)
  return r.comfy_name
}

/** 用户自然语言 → H3 结构化提示词（已是结构化的原样返回） */
export function h3Prompt(text, seconds) {
  const s = String(text || '').trim()
  if (/integrated_multimodal_description\s*:/i.test(s)) return s
  return [
    `integrated_multimodal_description: [Shot 1] ${seconds}-second continuous shot. ${s}`,
    '',
    'overall_soundscape: Natural ambient sound that matches the scene.',
    'non_diegetic_music: None.',
  ].join('\n')
}

/**
 * 提交并等待完成。seconds>5 时按 5 秒一段、Motion Context 接续。
 * @returns {Promise<{ jobId: string, url: string }>}
 */
export async function h3Generate({ prompt, seconds, qualityMp, firstFrame }, onPhase = () => {}) {
  const n = Math.max(1, Math.ceil(seconds / H3_SEGMENT_SECONDS))
  const per = seconds / n
  const segments = Array.from({ length: n }, (_, i) => ({ index: i, seconds: per, prompt: h3Prompt(prompt, Math.round(per)) }))
  const job = await call('POST', '/api/generate', {
    mode: firstFrame ? 'i2v' : 't2v',
    segments,
    segment_seconds: per,
    quality_mp: qualityMp,
    steps: 8,
    first_frame: firstFrame || undefined,
    nonce: `todo-${Date.now()}`,
  }, 60000)
  const id = job.id
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    let j
    try { j = await call('GET', `/api/jobs/${id}`, null, 20000) } catch { continue }
    if (j.status === 'done' && j.url) return { jobId: id, url: j.url }
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || `H3 任务${j.status}`)
    const p = j.progress || {}
    const seg = n > 1 ? `第 ${(p.segment ?? 0) + 1}/${n} 段 · ` : ''
    if (j.phase === 'decoding') onPhase(`${seg}解码中…`)
    else if (p.max) onPhase(`${seg}采样 ${p.value ?? 0}/${p.max}`)
    else onPhase(`${seg}本地 H3 生成中…`)
  }
  throw new Error('本地 H3 超时（60 分钟）')
}

export async function h3Download(url, dest) {
  const res = await fetch(`${H3_BASE}${url}`, { signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error(`H3 成片下载失败 (${res.status})`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}
