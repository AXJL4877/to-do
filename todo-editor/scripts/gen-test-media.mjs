/**
 * B1.0：用 FFmpeg 生成 tests/media/ 测试素材（大文件不提交，只提交 hashes）。
 *   gop250.mp4  / intra.mp4 / 4k.mp4 / alpha PNG(+序列)
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveFfmpeg } = require('../electron/exportSequence.cjs')

const root = fileURLToPath(new URL('../', import.meta.url))
const mediaDir = resolve(root, 'tests/media')
const alphaSeqDir = resolve(mediaDir, 'alpha_seq')
const nativeBin = resolve(root, 'native/bin')

mkdirSync(alphaSeqDir, { recursive: true })

const ffmpeg = resolveFfmpeg(nativeBin)
if (!ffmpeg || (ffmpeg !== 'ffmpeg' && !existsSync(ffmpeg))) {
  throw new Error(`找不到 ffmpeg（native/bin 或 PATH）: ${ffmpeg}`)
}

const fontCandidates = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/consola.ttf',
]
const sysFont = fontCandidates.find((p) => existsSync(p))
if (!sysFont) throw new Error('找不到系统字体（arial/msyh/consola），无法 drawtext 烧帧号')

// 拷到无盘符冒号的相对路径，避免 Windows filtergraph 对 C: 的转义坑
const fontLocal = resolve(mediaDir, '_drawtext.ttf')
copyFileSync(sysFont, fontLocal)
const fontRel = relative(process.cwd(), fontLocal).replaceAll('\\', '/')
const drawFrame = (size) =>
  `drawtext=fontfile=${fontRel}:text=%{n}:x=40:y=40:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.55`

function run(args) {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-1200)}\nargs=${args.join(' ')}`)
  }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

console.log('ffmpeg=', ffmpeg)
console.log('font=', sysFont, '→', fontRel)

const gop250 = resolve(mediaDir, 'gop250.mp4')
const intra = resolve(mediaDir, 'intra.mp4')
const uhd = resolve(mediaDir, '4k.mp4')
const alphaCircle = resolve(mediaDir, 'alpha_circle.png')
const alphaChecker = resolve(mediaDir, 'alpha_checker.png')

console.log('生成 gop250.mp4 (1080p30 10s, -g 250)…')
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
  '-vf', drawFrame(72),
  '-t', '10',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '250', '-keyint_min', '250',
  '-pix_fmt', 'yuv420p',
  gop250,
])

console.log('生成 intra.mp4 (同内容, -g 1 -bf 0)…')
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
  '-vf', drawFrame(72),
  '-t', '10',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '1', '-keyint_min', '1', '-bf', '0',
  '-pix_fmt', 'yuv420p',
  intra,
])

console.log('生成 4k.mp4 (3840x2160 30fps 5s)…')
run([
  '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30',
  '-vf', drawFrame(120),
  '-t', '5',
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30',
  '-pix_fmt', 'yuv420p',
  uhd,
])

console.log('生成 alpha_circle.png…')
run([
  '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:d=1,format=rgba',
  '-vf',
  "geq=r='if(lt(hypot(X-320,Y-180),140),220,0)':g='if(lt(hypot(X-320,Y-180),140),60,0)':b='if(lt(hypot(X-320,Y-180),140),40,0)':a='if(lt(hypot(X-320,Y-180),140),255,0)'",
  '-frames:v', '1',
  alphaCircle,
])

console.log('生成 alpha_checker.png（半透明棋盘，遮挡剔除用）…')
run([
  '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:d=1,format=rgba',
  '-vf',
  "geq=r='if(mod(floor(X/40)+floor(Y/40)\\,2)\\,200\\,0)':g='if(mod(floor(X/40)+floor(Y/40)\\,2)\\,200\\,40)':b='if(mod(floor(X/40)+floor(Y/40)\\,2)\\,40\\,200)':a='if(mod(floor(X/40)+floor(Y/40)\\,2)\\,255\\,0)'",
  '-frames:v', '1',
  alphaChecker,
])

console.log('生成 alpha_seq/（5 帧 RGBA，移动色块）…')
for (let i = 0; i < 5; i++) {
  const x = 80 + i * 70
  const out = resolve(alphaSeqDir, `frame_${String(i).padStart(3, '0')}.png`)
  run([
    '-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:d=1,format=rgba',
    '-vf',
    `drawbox=x=${x}:y=100:w=120:h=120:color=0x33AAFF@1.0:t=fill`,
    '-frames:v', '1',
    out,
  ])
}

const files = [
  gop250, intra, uhd, alphaCircle, alphaChecker,
  ...readdirSync(alphaSeqDir).filter((n) => n.endsWith('.png')).sort().map((n) => join(alphaSeqDir, n)),
]

const hashes = {
  generatedAt: new Date().toISOString(),
  ffmpeg,
  font: sysFont,
  files: {},
}
for (const p of files) {
  const rel = relative(mediaDir, p).replaceAll('\\', '/')
  hashes.files[rel] = {
    sha256: sha256File(p),
    bytes: readFileSync(p).byteLength,
  }
}
// 本地字体副本不入库
try { unlinkSync(fontLocal) } catch { /* */ }

const hashPath = resolve(mediaDir, 'hashes.json')
writeFileSync(hashPath, JSON.stringify(hashes, null, 2) + '\n', 'utf8')
console.log(`已写入 ${hashPath}（${Object.keys(hashes.files).length} 个文件）`)
console.log('gen-test-media 完成（mp4/png 勿提交，hashes.json 提交）')
