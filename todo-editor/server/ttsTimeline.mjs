/**
 * TTS_timeline 调用封装：只走内嵌 vendor/tts-timeline 的 run.py synth。
 * 密钥由内嵌 vendor/mishi/.env（火山 Volc）读取；宿主不自带 TTS 客户端。
 */
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveMishiRoot, resolvePython, resolveTtsTimelineRoot, ttsTimelineReady } from './toolRoots.mjs'

const PYTHON = resolvePython()
const TIMEOUT_MS = 600_000

/** @deprecated 用 resolveTtsTimelineRoot()；保留导出兼容旧引用 */
export const TTS_TIMELINE_ROOT = resolveTtsTimelineRoot()

/** stdout 只有一行 JSON；Python 侧偶有告警混进来，取最后一行 */
export function parseSynthStdout(stdout) {
  const last = String(stdout || '').trim().split(/\r?\n/).pop() || ''
  try {
    return JSON.parse(last)
  } catch {
    return { ok: false, error: last.slice(-200) || '无输出' }
  }
}

/**
 * @param {string} text 旁白原文
 * @param {{ job: string, textFile: string, audioFile: string, timingFile: string, speaker?: string, resourceId?: string }} o
 * @returns {Promise<{ duration: number, speaker: string|null }>}
 */
export async function synthTimeline(text, { job, textFile, audioFile, timingFile, speaker, resourceId }) {
  const root = resolveTtsTimelineRoot()
  const runPy = path.join(root, 'run.py')
  if (!ttsTimelineReady(root)) {
    throw new Error(`未找到内嵌配音模块：${runPy}（请确认仓库含 todo-editor/vendor/tts-timeline）`)
  }
  writeFileSync(textFile, text, 'utf8')
  const out = path.join(root, 'outputs', job)
  const args = [runPy, 'synth', '--text-file', textFile, '--out', out]
  if (speaker) args.push('--speaker', speaker)
  if (resourceId) args.push('--resource-id', resourceId)
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        // 让内嵌 TTS_timeline 找到 vendor/mishi（含 Volc Key）
        MISHI_ROOT: resolveMishiRoot(),
      },
    })
    let buf = ''
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* */ } }, TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => { buf += c })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { err = `${err}${c}`.slice(-400) })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? `找不到 Python（${PYTHON}，可设 TODO_PYTHON）` : e.message))
    })
    child.on('close', () => { clearTimeout(timer); resolve(buf.trim() ? buf : err) })
  })
  const res = parseSynthStdout(stdout)
  try {
    if (!res.ok) throw new Error(`配音失败：${res.error || '未知错误'}`)
    if (!res.audio || !existsSync(res.audio)) throw new Error('配音失败：未产出 audio.wav')
    if (!res.timing || !existsSync(res.timing)) throw new Error('配音失败：未产出 timing.json')
    copyFileSync(res.audio, audioFile)
    copyFileSync(res.timing, timingFile)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  return { duration: Number(res.duration) || 0, speaker: res.speaker ?? null }
}
