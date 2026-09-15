import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createMediaProbe } from '../electron/mediaProbe.cjs'
import { createNativePlayer, rgb24ToBmpDataUrl } from '../electron/nativePlayer.cjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const bin = resolve(root, 'native/bin')
const engine = resolve(bin, 'todo-media-engine.exe')
const probe = resolve(bin, 'todo-media-probe.exe')
const gpu = resolve(bin, 'todo-gpu-view.exe')
const out = resolve(root, 'native/test-output')
mkdirSync(out, { recursive: true })

function need(p, label) {
  if (!existsSync(p)) throw new Error(`缺少 ${label}: ${p}。先 npm run native:build`)
}

need(engine, 'C++ 引擎')
need(probe, '兼容探测器')
need(gpu, 'GPU 视图')

const ffmpeg = process.env.FFMPEG
  || resolve(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe')
if (!existsSync(ffmpeg)) throw new Error('找不到 ffmpeg，无法合成测试媒体')

const av = resolve(out, 'native_av.mp4')
const audio = resolve(out, 'native_a.m4a')
const zh = resolve(out, '原生 中文.mp4')
const ppm = resolve(out, 'native_frame.ppm')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', av])
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5', '-c:a', 'aac', audio])
run('powershell.exe', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${av.replaceAll("'", "''")}' -Destination '${zh.replaceAll("'", "''")}' -Force`])

const probeJson = JSON.parse(run(engine, ['probe', zh, '10000']))
if (!probeJson.ok || probeJson.width !== 320 || Math.abs(probeJson.duration - 2) > 0.05) {
  throw new Error(`probe 结果异常: ${JSON.stringify(probeJson)}`)
}
const frameJson = JSON.parse(run(engine, ['frame', zh, '0.5', ppm, '10000']))
if (!frameJson.ok || !existsSync(ppm)) throw new Error(`frame 失败: ${JSON.stringify(frameJson)}`)
const gpuJson = JSON.parse(run(gpu, [zh, '0.4', '--smoke']))
if (!gpuJson.ok || gpuJson.backend !== 'd3d11') throw new Error(`gpu smoke 失败: ${JSON.stringify(gpuJson)}`)

/** EditGraph compose：与 export 同层序 letterbox + D3D11 上传 */
const composeGraph = resolve(out, 'compose_graph.json')
const composeBmp = resolve(out, 'compose_frame.bmp')
writeFileSync(composeGraph, JSON.stringify({
  version: 1,
  clips: [{
    mediaPath: zh.replaceAll('\\', '/'),
    start: 0, duration: 2, inPoint: 0, trackId: 'v1', enabled: true, kind: 'video',
  }],
  tracks: [{ id: 'v1', kind: 'video' }],
  settings: { width: 640, height: 360, fps: 25 },
  workIn: 0, workOut: 2,
}))
const composeJson = JSON.parse(run(engine, ['compose', composeGraph, '0.5', composeBmp]))
if (!composeJson.ok || composeJson.backend !== 'todo-cpp-d3d11-compose' || !existsSync(composeBmp)) {
  throw new Error(`compose 失败: ${JSON.stringify(composeJson)}`)
}
if (composeJson.gpuComposite !== true) {
  throw new Error(`compose 未走 GPU 层合成: ${JSON.stringify(composeJson)}`)
}
if (!(composeJson.layers >= 1) || composeJson.width !== 640 || composeJson.height !== 360) {
  throw new Error(`compose 尺寸/层数异常: ${JSON.stringify(composeJson)}`)
}

/** 字幕 + 特效：同 EditGraph 规则进 compose（GDI 字 + blur/filter） */
const composeTextGraph = resolve(out, 'compose_text_graph.json')
const composeTextBmp = resolve(out, 'compose_text_frame.bmp')
writeFileSync(composeTextGraph, JSON.stringify({
  version: 1,
  clips: [
    {
      mediaPath: zh.replaceAll('\\', '/'),
      start: 0, duration: 2, inPoint: 0, trackId: 'v1', enabled: true, kind: 'video',
      effects: [{ type: 'filter', strength: 0.4, enabled: true }],
    },
    {
      mediaPath: '',
      start: 0, duration: 2, inPoint: 0, trackId: 'v1', enabled: true, kind: 'text',
      text: {
        content: 'TODO字幕',
        fontFamily: 'Segoe UI',
        fontSize: 42,
        color: '#F5F2EC',
        align: 'center',
        bilingual: 'SUBTITLE',
        strokeWidth: 2,
        strokeColor: '#000000',
      },
      y: 0.35,
      opacity: 1,
    },
  ],
  tracks: [{ id: 'v1', kind: 'video' }],
  settings: { width: 640, height: 360, fps: 25 },
  workIn: 0, workOut: 2,
}))
const composeTextJson = JSON.parse(run(engine, ['compose', composeTextGraph, '0.5', composeTextBmp]))
if (!composeTextJson.ok || !existsSync(composeTextBmp)) {
  throw new Error(`compose text 失败: ${JSON.stringify(composeTextJson)}`)
}
if (!(composeTextJson.layers >= 2)) {
  throw new Error(`compose text 层数不足: ${JSON.stringify(composeTextJson)}`)
}

/** 蒙版 + 裁剪 + 速度：同 EditGraph 进 compose */
const composeMaskGraph = resolve(out, 'compose_mask_graph.json')
const composeMaskBmp = resolve(out, 'compose_mask_frame.bmp')
writeFileSync(composeMaskGraph, JSON.stringify({
  version: 1,
  clips: [{
    mediaPath: zh.replaceAll('\\', '/'),
    start: 0, duration: 2, inPoint: 0, outPoint: 2, trackId: 'v1', enabled: true, kind: 'video',
    speed: 1.5, reverse: false,
    cropL: 0.1, cropR: 0.1, cropT: 0.05, cropB: 0.05,
    mask: { type: 'ellipse', feather: 0.2, expand: 0.1, invert: false },
  }],
  tracks: [{ id: 'v1', kind: 'video' }],
  settings: { width: 640, height: 360, fps: 25 },
  workIn: 0, workOut: 2,
}))
const composeMaskJson = JSON.parse(run(engine, ['compose', composeMaskGraph, '0.4', composeMaskBmp]))
if (!composeMaskJson.ok || !existsSync(composeMaskBmp)) {
  throw new Error(`compose mask 失败: ${JSON.stringify(composeMaskJson)}`)
}
if (!(composeMaskJson.layers >= 1)) {
  throw new Error(`compose mask 层数异常: ${JSON.stringify(composeMaskJson)}`)
}

/** 转场：片尾 dissolve 降低不透明度仍合成成功 */
const composeTransGraph = resolve(out, 'compose_trans_graph.json')
const composeTransBmp = resolve(out, 'compose_trans_frame.bmp')
writeFileSync(composeTransGraph, JSON.stringify({
  version: 1,
  clips: [{
    mediaPath: zh.replaceAll('\\', '/'),
    start: 0, duration: 2, inPoint: 0, trackId: 'v1', enabled: true, kind: 'video',
    transitionOut: { type: 'dissolve', duration: 0.8 },
  }],
  tracks: [{ id: 'v1', kind: 'video' }],
  settings: { width: 640, height: 360, fps: 25 },
  workIn: 0, workOut: 2,
}))
const composeTransJson = JSON.parse(run(engine, ['compose', composeTransGraph, '1.6', composeTransBmp]))
if (!composeTransJson.ok || !existsSync(composeTransBmp)) {
  throw new Error(`compose transition 失败: ${JSON.stringify(composeTransJson)}`)
}

const playJson = JSON.parse(run(engine, ['play-smoke', zh, '1', '15000']))
if (!playJson.ok || playJson.frames < 20 || playJson.frames > 30 || Math.abs(playJson.fps - 25) > 0.01) {
  throw new Error(`play-smoke 异常: ${JSON.stringify(playJson)}`)
}

const api = createMediaProbe({ enginePath: engine, nativePath: probe })
const viaIpc = await api({ filePath: zh, timeoutMs: 10000 })
if (!viaIpc.ok || viaIpc.backend !== 'todo-cpp-ffmpeg') {
  throw new Error(`IPC 探测未走 C++ 引擎: ${JSON.stringify(viaIpc)}`)
}

/** play-session：OPEN → SEEK → 若干 READ → AUDIO_CLOCK → QUIT */
const player = createNativePlayer({ enginePath: engine, timeoutMs: 10000 })
const opened = await player.open(zh, 10000)
if (!opened.ok) throw new Error(`play-session OPEN 失败: ${JSON.stringify(opened)}`)
const sought = await player.seek(0.2, 8000)
if (!sought.ok) throw new Error(`play-session SEEK 失败: ${JSON.stringify(sought)}`)
let reads = 0
let lastPts = -1
let lastRgb = null
let lastWh = null
for (let i = 0; i < 5; i++) {
  const fr = await player.read(8000)
  if (!fr.ok) throw new Error(`play-session READ 失败: ${JSON.stringify(fr)}`)
  if (!(fr.w > 0 && fr.h > 0 && fr.rgb?.length === fr.w * fr.h * 3)) {
    throw new Error(`play-session FRAME 尺寸异常: w=${fr.w} h=${fr.h} len=${fr.rgb?.length}`)
  }
  if (!(fr.pts >= lastPts - 1e-6)) throw new Error(`pts 未递增: ${lastPts} → ${fr.pts}`)
  lastPts = fr.pts
  lastRgb = fr.rgb
  lastWh = { w: fr.w, h: fr.h }
  reads++
}
if (reads < 5) throw new Error(`play-session READ 次数不足: ${reads}`)
const bmpUrl = rgb24ToBmpDataUrl(lastWh.w, lastWh.h, lastRgb)
if (!bmpUrl.startsWith('data:image/bmp;base64,')) throw new Error('BMP dataUrl 生成失败')
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
const clock = await player.audioClock(2000)
if (!clock.ok || clock.sec == null || !(clock.sec >= 0)) {
  throw new Error(`AUDIO_CLOCK 异常: ${JSON.stringify(clock)}`)
}
/** PCM/waveOut：泵一段时间后时钟应前进（相对纯包 PTS 的真播放证据） */
const clock0 = clock.sec
await sleep(120)
const clock1 = await player.audioClock(3000)
if (!clock1.ok || clock1.sec == null) throw new Error(`AUDIO_CLOCK 二次失败: ${JSON.stringify(clock1)}`)
if (!(clock1.sec > clock0 + 0.02)) {
  throw new Error(`PCM 时钟未前进: ${clock0} → ${clock1.sec}`)
}
await player.close()

const playSession = {
  ok: true, reads, lastPts, audioClock: clock1.sec, pcmDelta: +(clock1.sec - clock0).toFixed(3), bmpChars: bmpUrl.length,
}

/** 墙钟+PTS 限速读帧：帧间隔应大致接近 1/fps（证据） */
const paced = createNativePlayer({ enginePath: engine, timeoutMs: 10000 })
const po = await paced.open(zh, 10000)
if (!po.ok) throw new Error(`paced OPEN 失败: ${JSON.stringify(po)}`)
const ps = await paced.seek(0, 8000)
if (!ps.ok) throw new Error(`paced SEEK 失败: ${JSON.stringify(ps)}`)
const fpsExpect = 25
const nFrames = 20
const walls = []
let pts0 = null
const t0 = performance.now()
for (let i = 0; i < nFrames; i++) {
  const fr = await paced.read(8000)
  if (!fr.ok) throw new Error(`paced READ 失败: ${JSON.stringify(fr)}`)
  if (pts0 == null) pts0 = fr.pts
  const target = t0 + (fr.pts - pts0) * 1000
  const now = performance.now()
  if (target > now) await sleep(target - now)
  walls.push(performance.now())
}
await paced.close()
const intervals = []
for (let i = 1; i < walls.length; i++) intervals.push(walls[i] - walls[i - 1])
const meanMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
const expectMs = 1000 / fpsExpect
// 解码+调度抖动：允许 0.45x～2.8x；均值应仍贴近帧时长
if (!(meanMs >= expectMs * 0.45 && meanMs <= expectMs * 2.8)) {
  throw new Error(`paced 帧间隔异常: mean=${meanMs.toFixed(1)}ms expect≈${expectMs}ms intervals=${JSON.stringify(intervals.map((x) => +x.toFixed(1)))}`)
}
const pacedPlay = {
  ok: true,
  frames: nFrames,
  meanIntervalMs: +meanMs.toFixed(2),
  expectIntervalMs: expectMs,
  fpsExpect,
}

writeFileSync(resolve(out, 'native-test-report.json'), JSON.stringify({
  probeJson, frameJson, gpuJson, composeJson, composeTextJson, composeMaskJson, composeTransJson,
  playJson, viaIpc, playSession, pacedPlay, at: new Date().toISOString(),
}, null, 2))
console.log('native:test 通过（C++ probe/frame/compose+text/mask/trans/play-session/PCM+AUDIO_CLOCK/paced + D3D11 + Electron probe）')
console.log(`paced 证据: meanInterval=${meanMs.toFixed(1)}ms ≈ ${expectMs}ms (25fps); pcmDelta=${playSession.pcmDelta}s`)
