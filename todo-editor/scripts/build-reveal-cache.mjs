/**
 * 把「显现」类短文动画（VP9-alpha，~0.4s）预解成 PNG 序列，用来**免掉视频解码**。
 *
 * 为什么这么做（这是有依据的优化，不是拍脑袋）：
 *   · 我实测过：**画布合成本身只要 0.2~0.5ms/帧**，不是瓶颈；
 *   · 瓶颈是 VP9-alpha 的**软件解码**（整屏 1080p 带 alpha 的层曾量到中位 0.167s、最大 0.433s 的滞后）；
 *   · 而 `显现` 动画只有 ~12 帧，且**每次播放都完全相同** —— 属于"可以预解、且值得预解"的东西。
 *   预解成 PNG 后，渲染时直接命中原有的图片缓存（`ImageCache`），不再有 seek/解码抖动。
 *
 * 产物：<工程目录>/cache/reveal/<mediaId>/f0000.png …（按预览分辨率，默认长边 960）
 * 用法：node scripts/build-reveal-cache.mjs <工程.todo.json> [--edge 960] [--force]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const argv = process.argv.slice(2)
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const project = path.resolve(argv.find((a) => !a.startsWith('--') && a !== flag('--edge')) ?? '')
const edge = Number(flag('--edge', '960'))
const force = argv.includes('--force')

if (!project || !existsSync(project)) {
  console.log(JSON.stringify({ ok: false, error: { code: 'not_found', message: `工程文件不存在: ${project}` } }, null, 2))
  process.exit(2)
}

const ffmpeg = [path.join(root, 'native', 'bin', 'ffmpeg.exe'), path.join(root, 'native', 'bin', 'ffmpeg'), 'ffmpeg']
  .find((c) => (path.isAbsolute(c) ? existsSync(c) : true) && spawnSync(c, ['-version'], { encoding: 'utf8' }).status === 0)
if (!ffmpeg) { console.log(JSON.stringify({ ok: false, error: { code: 'unavailable', message: '找不到 ffmpeg' } })); process.exit(1) }

const doc = JSON.parse(readFileSync(project, 'utf8'))
const projDir = path.dirname(project)
const resolveMedia = (m) => {
  if (m.path && existsSync(m.path)) return m.path
  if (m.relPath) {
    const c = path.resolve(projDir, m.relPath)
    if (existsSync(c)) return c
  }
  return null
}

// 目标：带 alpha 的**短视频**（≤ 2s）——长视频不适合逐帧 PNG（体积会失控）
const targets = (doc.media ?? []).filter((m) => {
  if (m.kind !== 'video' || !m.alpha) return false
  const d = Number(m.duration ?? 0)
  return d > 0 && d <= 2
})

const outRoot = path.join(projDir, 'cache', 'reveal')
mkdirSync(outRoot, { recursive: true })

const results = []
let totalBytes = 0
let totalFrames = 0

for (const m of targets) {
  const src = resolveMedia(m)
  const dir = path.join(outRoot, m.id)
  if (!src) { results.push({ id: m.id, name: m.name, skipped: '素材不可达' }); continue }
  if (existsSync(dir) && !force) {
    const n = readdirSync(dir).filter((f) => f.endsWith('.png')).length
    const bytes = readdirSync(dir).reduce((s, f) => s + statSync(path.join(dir, f)).size, 0)
    results.push({ id: m.id, name: m.name, cached: n, kb: Math.round(bytes / 1024) })
    totalFrames += n; totalBytes += bytes
    continue
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const r = spawnSync(ffmpeg, [
    '-y', '-i', src,
    '-vf', `scale=${edge}:-2:flags=fast_bilinear`,
    path.join(dir, 'f%04d.png'),
  ], { encoding: 'utf8' })
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : []
  if (r.status !== 0 || !files.length) {
    results.push({ id: m.id, name: m.name, error: (r.stderr || '').slice(-160) })
    continue
  }
  const bytes = files.reduce((s, f) => s + statSync(path.join(dir, f)).size, 0)
  totalFrames += files.length
  totalBytes += bytes
  results.push({ id: m.id, name: m.name, frames: files.length, kb: Math.round(bytes / 1024), from: path.basename(src) })
}

const report = {
  ok: true,
  project,
  edge,
  targets: targets.length,
  frames: totalFrames,
  cacheMb: +(totalBytes / 1024 / 1024).toFixed(2),
  dir: outRoot,
  results,
  note: '预解成 PNG 后，渲染时命中图片缓存，不再有 VP9-alpha 解码/seek 抖动。**渲染端尚未接线**（下一轮：monitorDraw 的 video 分支优先用缓存帧）。',
}
writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify({ edge, builtAt: new Date().toISOString(), entries: results }, null, 2))
console.log(JSON.stringify(report, null, 2))
