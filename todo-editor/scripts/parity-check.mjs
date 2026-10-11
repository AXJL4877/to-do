/**
 * I4 parity 检查：**监视器渲染路径 vs 导出成片**，量化差异。
 *
 * 背景：不变量 I4 说「预览 = 导出，走同一个 render 函数」。实际是两条路：
 *   监视器：canvas 合成（renderProgramFrame）——编辑窗里看到的
 *   导出  ：ffmpeg / 原生引擎——文件里的
 * 与其声称一致，不如**把差异量化成可回归的数字**：同工程、同时刻、同分辨率，
 * 一条路渲 PNG，另一条从成片里取帧，再算 PSNR / SSIM。
 *
 * 用法：
 *   node scripts/parity-check.mjs <工程.todo.json> <成片.mp4> --at 12 [--width 1280]
 *
 * 输出 JSON：{ ok, at, width, height, monitorPng, exportPng, psnr, ssim, verdict }
 * verdict 判定线（务实，不假装是标准）：ssim ≥ 0.98 视为"同一画面"；0.90~0.98 视为"仅缩放/压缩差异"；< 0.90 视为"两条路确实不同"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const positional = argv.filter((a) => !a.startsWith('--') && a !== flag('--at') && a !== flag('--width') && a !== flag('--out'))
const [projectArg, videoArg] = positional
const at = Number(flag('--at', '0'))
const width = Number(flag('--width', '1280'))

if (!projectArg || !videoArg || !existsSync(projectArg) || !existsSync(videoArg)) {
  console.log(JSON.stringify({ ok: false, error: { code: 'bad_request', message: '需要 <工程.todo.json> <成片.mp4> --at <秒>' } }, null, 2))
  process.exit(2)
}

/** 找 ffmpeg：bundled 优先（工程自带的依赖才算"不依赖机器全局"）。 */
function findFfmpeg() {
  const candidates = [
    process.env.TODO_FFMPEG,
    path.join(root, 'native', 'bin', 'ffmpeg.exe'),
    path.join(root, 'native', 'bin', 'ffmpeg'),
    path.join(root, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    path.join(root, 'runtime', 'python', 'ffmpeg.exe'),
    'ffmpeg',
  ].filter(Boolean)
  for (const c of candidates) {
    if (path.isAbsolute(c) && !existsSync(c)) continue
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' })
    if (r.status === 0) return c
  }
  return null
}

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log(JSON.stringify({ ok: false, error: { code: 'unavailable', message: '找不到 ffmpeg（bundled 或 PATH）' } }, null, 2))
  process.exit(1)
}

const outDir = path.join(root, 'native', 'test-output', 'parity')
mkdirSync(outDir, { recursive: true })
const stamp = `${at.toFixed(3)}`.replace('.', '_')
const monitorPng = path.join(outDir, `monitor-${stamp}-${width}.png`)
const exportPng = path.join(outDir, `export-${stamp}-${width}.png`)

// 1) 监视器路径：渲一帧（走 renderProgramFrame，与编辑窗一致）
const render = spawnSync(process.execPath, [
  path.join(root, 'scripts', 'render-frame.mjs'), path.resolve(projectArg),
  '--at', String(at), '--edge', String(width), '--out', monitorPng,
], { cwd: root, encoding: 'utf8' })
let monitorMeta = null
try { monitorMeta = JSON.parse((render.stdout || '').trim().split('\n').slice(-40).join('\n')) } catch { monitorMeta = null }
if (!monitorMeta?.ok) {
  console.log(JSON.stringify({
    ok: false,
    error: { code: 'render_failed', message: monitorMeta?.error?.message ?? '监视器渲染失败', stderr: (render.stderr || '').slice(-300) },
  }, null, 2))
  process.exit(1)
}
const w = monitorMeta.width
const h = monitorMeta.height

// 2) 导出路径：从成片里取同一时刻的帧，缩放到同一分辨率（缩放差异也是 parity 的一部分，如实量）
const grab = spawnSync(ffmpeg, [
  '-y', '-ss', String(at), '-i', path.resolve(videoArg),
  '-frames:v', '1', '-vf', `scale=${w}:${h}`, exportPng,
], { encoding: 'utf8' })
if (grab.status !== 0 || !existsSync(exportPng)) {
  console.log(JSON.stringify({
    ok: false,
    error: { code: 'export_grab_failed', message: `从成片取帧失败：${(grab.stderr || '').slice(-300)}` },
  }, null, 2))
  process.exit(1)
}

// 3) 量化：PSNR 与 SSIM（ffmpeg 内置滤波器，不需要额外依赖）
const stat = spawnSync(ffmpeg, [
  '-i', monitorPng, '-i', exportPng,
  '-lavfi', `[0:v][1:v]ssim=stats_file=-;[0:v][1:v]psnr`,
  '-f', 'null', '-',
], { encoding: 'utf8' })
const log = `${stat.stderr || ''}`
const psnrMatch = log.match(/average:\s*([0-9.]+|inf)/)
const ssimMatch = log.match(/All:([0-9.]+)/) ?? log.match(/SSIM.*?All:([0-9.]+)/)
const psnr = psnrMatch ? (psnrMatch[1] === 'inf' ? Infinity : Number(psnrMatch[1])) : null
const ssim = ssimMatch ? Number(ssimMatch[1]) : null

const verdict = ssim == null
  ? 'unknown'
  : ssim >= 0.98 ? 'same_picture'
  : ssim >= 0.90 ? 'scaling_or_compression_only'
  : 'paths_differ'

const report = {
  ok: true,
  at,
  width: w,
  height: h,
  monitorPng,
  exportPng,
  monitor: { meanLuma: monitorMeta.meanLuma, nonBlackPct: monitorMeta.nonBlackPct, sha256: monitorMeta.sha256, activeClips: monitorMeta.activeClips },
  psnr: psnr === Infinity ? 'inf' : psnr,
  ssim,
  verdict,
  note: '监视器 = canvas 合成（renderProgramFrame）；导出 = ffmpeg/原生引擎。这两条路**没有共享同一个渲染器**，所以本检查是"量化差异"而不是"证明一致"。',
}
writeFileSync(path.join(outDir, `report-${stamp}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(verdict === 'same_picture' ? 0 : 3)
