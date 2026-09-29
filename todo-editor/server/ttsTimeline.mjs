/**
 * TTS_timeline 调用封装：只走其唯一入口 `run.py synth`，宿主不自带任何 TTS 客户端，密钥由它经「密匙」读取。
 * 其硬锁要求 --out 落在它自己的 outputs/<作业>/，拿到产物后拷进业务目录并只删这一个作业目录。
 */
import { copyFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const TTS_TIMELINE_ROOT = process.env.TTS_TIMELINE_ROOT || 'd:\\video_Tools\\TTS_timeline'
const PYTHON = process.env.TODO_PYTHON || 'python'
const TIMEOUT_MS = 600_000

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
 *   作业名与业务目录里的落盘路径；speaker / resourceId 不给则用密匙默认
 * @returns {Promise<{ duration: number, speaker: string|null }>}
 */
export async function synthTimeline(text, { job, textFile, audioFile, timingFile, speaker, resourceId }) {
  writeFileSync(textFile, text, 'utf8')
  const out = path.join(TTS_TIMELINE_ROOT, 'outputs', job)
  const args = [path.join(TTS_TIMELINE_ROOT, 'run.py'), 'synth', '--text-file', textFile, '--out', out]
  if (speaker) args.push('--speaker', speaker)
  if (resourceId) args.push('--resource-id', resourceId)
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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
    copyFileSync(res.audio, audioFile)
    copyFileSync(res.timing, timingFile)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  return { duration: Number(res.duration) || 0, speaker: res.speaker ?? null }
}
