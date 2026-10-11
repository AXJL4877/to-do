/** 用扩展产物叠一条可解码 mp4，核对时长与非空画面。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.TODO_EXTENSION_SOURCE
if (!source) throw new Error('TODO_EXTENSION_SOURCE missing')
const lib = pathToFileURL(path.join(source, 'checks', 'lib.mjs')).href
const { makePng, render, request } = await import(lib)
const out = path.join(repo, 'native', 'test-output', 'spongebob-koubo')
mkdirSync(out, { recursive: true })
const work = path.join(out, 'export-work')
mkdirSync(work, { recursive: true })
const image = path.join(work, 'sprite.png')
makePng(image)
const result = render(request(work, image))
const hero = result.scene.elements[0]
const mp4 = path.join(out, 'export.mp4')
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const enc = spawnSync(ffmpeg, [
  '-y', '-i', path.join(work, hero.video),
  '-f', 'lavfi', '-i', 'color=c=0x1a4a6a:s=1280x720:d=1',
  '-filter_complex', '[1:v][0:v]overlay=format=auto',
  '-t', '0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4,
], { encoding: 'utf8' })
if (enc.status !== 0) {
  console.error(enc.stderr?.slice(-500))
  process.exit(1)
}
// 只用 ffmpeg 读时长：本机 ffprobe 常缺（WinGet 只装了 ffmpeg），别让检查栽在工具链上。
// 与 server/production/sourceWorkflow.mjs 的 probeFilm 同一套解析。
const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', mp4], { encoding: 'utf8' })
const text = `${probe.stderr || ''}\n${probe.stdout || ''}`
const hit = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
const dur = hit ? Number(hit[1]) * 3600 + Number(hit[2]) * 60 + Number(hit[3]) : NaN
if (!(dur > 0.5)) {
  console.error('bad duration', dur, text.slice(-400))
  process.exit(1)
}
writeFileSync(path.join(out, 'export.json'), JSON.stringify({ ok: true, dur, id: hero.id }, null, 2))
console.log('export ok', dur)
