/**
 * 合成测试媒体 → exportSequence（优先 C++）→ ffprobe；另测 JS 回退与中文路径。
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const {
  exportSequence,
  exportViaFfmpegCli,
  resolveFfmpeg,
  resolveFfprobe,
  resolveEngine,
} = require('../electron/exportSequence.cjs')

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output')
const nativeBin = resolve(root, 'native/bin')
mkdirSync(out, { recursive: true })

const ffmpeg = resolveFfmpeg(nativeBin)
const ffprobe = resolveFfprobe(nativeBin)
const engine = resolveEngine(nativeBin)

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout || '').slice(0, 800)}`)
  return r.stdout.trim()
}

function whichOk(bin) {
  if (bin === 'ffmpeg' || bin === 'ffprobe') {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true })
    return r.status === 0
  }
  return existsSync(bin)
}

function probeMp4(mp4) {
  const probeOut = run(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    mp4,
  ])
  const probe = JSON.parse(probeOut)
  const duration = Number(probe.format?.duration || 0)
  const streams = probe.streams || []
  return {
    duration,
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    width: streams.find((s) => s.codec_type === 'video')?.width,
    height: streams.find((s) => s.codec_type === 'video')?.height,
    raw: probeOut,
  }
}

if (!whichOk(ffmpeg)) throw new Error(`找不到 ffmpeg: ${ffmpeg}`)
if (!whichOk(ffprobe)) throw new Error(`找不到 ffprobe: ${ffprobe}`)
if (!engine || !existsSync(engine)) {
  throw new Error(`缺少 todo-media-engine.exe（先 npm run native:build）: ${engine}`)
}

const v1 = resolve(out, 'export_src_v1.mp4')
const v2 = resolve(out, 'export_src_v2.mp4')
const a1 = resolve(out, 'export_src_a1.m4a')
const still = resolve(out, 'export_src_still.png')
const mp4 = resolve(out, 'export_seq_out.mp4')
const mp4Js = resolve(out, 'export_seq_out_js.mp4')
const zhMedia = resolve(out, '导出素材 中文.mp4')
const zhOut = resolve(out, '导出结果 中文.mp4')
const zhGraph = resolve(out, 'editgraph_zh.json')

console.log('ffmpeg=', ffmpeg)
console.log('engine=', engine)
console.log('生成测试媒体…')
run(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', v1,
])
run(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v2,
])
run(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.2',
  '-c:a', 'aac', a1,
])
run(ffmpeg, [
  '-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:d=1',
  '-frames:v', '1', still,
])
copyFileSync(v1, zhMedia)

/** Timeline: V1 @0–2s, still @2–2.8s, V2 @2.8–4.3s; A1 @0.5–1.7s → ~4.3s */
const seq = {
  version: 1,
  clips: [
    { mediaPath: v1, start: 0, duration: 2, inPoint: 0, trackId: 'tv1', kind: 'video', enabled: true },
    { mediaPath: still, start: 2, duration: 0.8, inPoint: 0, trackId: 'tv1', kind: 'image', enabled: true },
    { mediaPath: v2, start: 2.8, duration: 1.5, inPoint: 0, trackId: 'tv1', kind: 'video', enabled: true },
    { mediaPath: a1, start: 0.5, duration: 1.2, inPoint: 0, trackId: 'ta1', kind: 'audio', enabled: true },
  ],
  tracks: [
    { id: 'tv1', kind: 'video', muted: false },
    { id: 'ta1', kind: 'audio', muted: false },
  ],
  settings: { width: 640, height: 360, fps: 30 },
}

const expected = 4.3

let lastProgress = 0
console.log('导出序列（优先 C++）…')
const result = await exportSequence(seq, mp4, {
  nativeBin,
  onProgress: (p) => { lastProgress = p },
})

if (!result.ok) throw new Error(`导出失败: ${result.error}`)
if (!existsSync(mp4)) throw new Error('未生成 mp4')
if (result.backend !== 'todo-cpp-compose-ffmpeg' && result.backend !== 'todo-cpp-ffmpeg') {
  throw new Error(`期望 backend=todo-cpp-compose-ffmpeg|todo-cpp-ffmpeg，得到 ${result.backend}`)
}

const cppProbe = probeMp4(mp4)
if (!cppProbe.hasVideo) throw new Error(`C++ 导出无视频流: ${cppProbe.raw}`)
if (!(cppProbe.duration >= expected - 0.35 && cppProbe.duration <= expected + 0.5)) {
  throw new Error(`C++ 导出时长异常: got ${cppProbe.duration}, expected ~${expected}`)
}

/** Direct CLI evidence */
const directGraph = resolve(out, 'editgraph_direct.json')
const directMp4 = resolve(out, 'export_cli_direct.mp4')
writeFileSync(directGraph, JSON.stringify(seq), 'utf8')
const cli = spawnSync(engine, ['export', directGraph, directMp4], { encoding: 'utf8', windowsHide: true })
if (cli.status !== 0) throw new Error(`CLI export 失败: ${cli.stdout || cli.stderr}`)
const cliJson = JSON.parse(String(cli.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop())
if (!cliJson.ok || (cliJson.backend !== 'todo-cpp-compose-ffmpeg' && cliJson.backend !== 'todo-cpp-ffmpeg') || !existsSync(directMp4)) {
  throw new Error(`CLI export JSON 异常: ${cli.stdout}`)
}

/** Chinese path: media + out */
const zhSeq = {
  version: 1,
  clips: [
    { mediaPath: zhMedia, start: 0, duration: 1, inPoint: 0, trackId: 'tv1', kind: 'video', enabled: true },
  ],
  tracks: [{ id: 'tv1', kind: 'video', muted: false }],
  settings: { width: 320, height: 180, fps: 30 },
}
writeFileSync(zhGraph, JSON.stringify(zhSeq), 'utf8')
const zhCli = spawnSync(engine, ['export', zhGraph, zhOut], { encoding: 'utf8', windowsHide: true })
if (zhCli.status !== 0) throw new Error(`中文路径 export 失败: ${zhCli.stdout || zhCli.stderr}`)
const zhJson = JSON.parse(String(zhCli.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop())
if (!zhJson.ok || !existsSync(zhOut)) throw new Error(`中文路径导出异常: ${zhCli.stdout}`)
const zhProbe = probeMp4(zhOut)
if (!zhProbe.hasVideo || !(zhProbe.duration >= 0.7 && zhProbe.duration <= 1.4)) {
  throw new Error(`中文路径 ffprobe 异常: ${JSON.stringify(zhProbe)}`)
}

/** JS fallback still works */
console.log('导出序列（JS ffmpeg-cli）…')
const jsResult = await exportViaFfmpegCli(seq, mp4Js, { nativeBin })
if (!jsResult.ok || jsResult.backend !== 'ffmpeg-cli') {
  throw new Error(`JS 回退失败: ${JSON.stringify(jsResult)}`)
}
const jsProbe = probeMp4(mp4Js)
if (!jsProbe.hasVideo) throw new Error('JS 导出无视频流')

const report = {
  ok: true,
  backend: result.backend,
  cliBackend: cliJson.backend,
  jsBackend: jsResult.backend,
  out: mp4,
  duration: cppProbe.duration,
  hasVideo: cppProbe.hasVideo,
  hasAudio: cppProbe.hasAudio,
  width: cppProbe.width,
  height: cppProbe.height,
  lastProgress,
  zhOut,
  zhDuration: zhProbe.duration,
  at: new Date().toISOString(),
}
writeFileSync(resolve(out, 'export-test-report.json'), JSON.stringify(report, null, 2))
console.log('export:test 通过', report)
