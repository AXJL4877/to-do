/**
 * B1.0 golden：对每个 fixture 取 20 个固定种子时间点，调用 todo_cmd_compose，
 * 抽出 RGB 存 tests/golden/out/，sha256 写入 tests/golden/hashes.json。
 *
 *   node scripts/golden.mjs           # 生成 / 更新 hashes
 *   node scripts/golden.mjs --check   # 逐个比对哈希；不一致输出差异点与 PSNR
 */
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync,
} from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixturesDir = resolve(root, 'tests/fixtures')
const mediaDir = resolve(root, 'tests/media')
const goldenDir = resolve(root, 'tests/golden')
const outDir = resolve(goldenDir, 'out')
const hashesPath = resolve(goldenDir, 'hashes.json')
const engine = process.env.TODO_ENGINE ? resolve(process.env.TODO_ENGINE) : resolve(root, 'native/bin/todo-media-engine.exe')

const SAMPLES = 20
const GLOBAL_SEED = 0xB10A0D01
const checkMode = process.argv.includes('--check')

if (!existsSync(engine)) {
  throw new Error(`缺少引擎: ${engine}（先 npm run native:build）`)
}
if (!existsSync(resolve(mediaDir, 'gop250.mp4'))) {
  throw new Error('缺少测试媒体，先运行: node scripts/gen-test-media.mjs')
}
if (!existsSync(fixturesDir)) {
  throw new Error('缺少 fixtures，先运行: node scripts/write-fixtures.mjs')
}

mkdirSync(outDir, { recursive: true })

/** mulberry32 — 固定种子可复现 */
function mulberry32(a) {
  return function next() {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s) {
  let h = GLOBAL_SEED
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b1)
  return h >>> 0
}

/** 在 [workIn, workOut) 内取 20 个固定伪随机时间点（排序后稳定） */
function sampleTimes(fixtureName, workIn, workOut) {
  const span = Math.max(1e-3, workOut - workIn)
  const rnd = mulberry32(hashStr(fixtureName) ^ GLOBAL_SEED)
  const times = []
  for (let i = 0; i < SAMPLES; i++) {
    // 避开精确边界；夹在区间内
    const u = (i + rnd()) / (SAMPLES + 1)
    times.push(workIn + u * span * 0.999)
  }
  times.sort((a, b) => a - b)
  return times.map((t) => +t.toFixed(6))
}

function resolveMediaPath(p) {
  if (!p) return p
  const norm = p.replaceAll('\\', '/')
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/')) return resolve(norm)
  if (norm.startsWith('tests/')) return resolve(root, norm)
  return resolve(root, norm)
}

function materializeGraph(graph) {
  const g = structuredClone(graph)
  for (const c of g.clips || []) {
    if (c.mediaPath) c.mediaPath = resolveMediaPath(c.mediaPath).replaceAll('\\', '/')
  }
  return g
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms | 0))
  } catch {
    spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms | 0})`], {
      windowsHide: true,
    })
  }
}

function runCompose(graphPath, timeSec, bmpPath, attempts = 5) {
  let lastErr = ''
  for (let a = 1; a <= attempts; a++) {
    if (!existsSync(engine)) {
      throw new Error(`引擎消失: ${engine}（可能被杀软隔离；请 npm run native:build 后重试）`)
    }
    const r = spawnSync(engine, ['compose', graphPath, String(timeSec), bmpPath], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      cwd: resolve(root, 'native/bin'),
    })
    const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
    let json
    try { json = JSON.parse(line) } catch {
      lastErr = `compose 非 JSON: status=${r.status} signal=${r.signal} out=${(r.stdout || '').slice(0, 200)} err=${(r.stderr || '').slice(0, 200)}`
      if (a < attempts) { sleepMs(400 * a); continue }
      throw new Error(lastErr)
    }
    if (r.status !== 0 || !json.ok) {
      lastErr = `compose 失败 t=${timeSec}: ${line || r.stderr}`
      if (a < attempts) { sleepMs(400 * a); continue }
      throw new Error(lastErr)
    }
    return json
  }
  throw new Error(lastErr || 'compose failed')
}

/** BMP24（compose 写出：底行优先、BGR、行 4 字节对齐）→ 顶行优先 RGB24 */
function bmpToRgb(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error('非法 BMP')
  }
  const dataOff = buf.readUInt32LE(10)
  const w = buf.readInt32LE(18)
  const hRaw = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  if (bpp !== 24) throw new Error(`仅支持 24bpp BMP，got ${bpp}`)
  const bottomUp = hRaw > 0
  const h = Math.abs(hRaw)
  const row = (w * 3 + 3) & ~3
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? (h - 1 - y) : y
    const srcOff = dataOff + srcY * row
    for (let x = 0; x < w; x++) {
      const si = srcOff + x * 3
      const di = (y * w + x) * 3
      rgb[di] = buf[si + 2]
      rgb[di + 1] = buf[si + 1]
      rgb[di + 2] = buf[si]
    }
  }
  return { w, h, rgb }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function psnrRgb(a, b) {
  if (a.length !== b.length) return { psnr: 0, mse: Infinity, maxDiff: 255, firstDiff: 0 }
  let sum = 0
  let maxDiff = 0
  let firstDiff = -1
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d) {
      if (firstDiff < 0) firstDiff = i
      if (d > maxDiff) maxDiff = d
      sum += d * d
    }
  }
  const mse = sum / a.length
  const psnr = mse <= 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
  return { psnr, mse, maxDiff, firstDiff }
}

function fixtureNames() {
  return readdirSync(fixturesDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/, ''))
    .sort()
}

const tmpGraphDir = resolve(tmpdir(), 'todo-golden-graphs')
mkdirSync(tmpGraphDir, { recursive: true })

const report = {
  generatedAt: new Date().toISOString(),
  engine,
  samplesPerFixture: SAMPLES,
  globalSeed: GLOBAL_SEED,
  fixtures: {},
}

let mismatches = 0
let total = 0
const prev = checkMode && existsSync(hashesPath)
  ? JSON.parse(readFileSync(hashesPath, 'utf8'))
  : null

if (checkMode && !prev) {
  throw new Error(`--check 需要已有 ${hashesPath}，请先无 --check 生成一次`)
}

for (const name of fixtureNames()) {
  const raw = JSON.parse(readFileSync(resolve(fixturesDir, `${name}.json`), 'utf8'))
  const g = materializeGraph(raw)
  const workIn = Number(g.workIn ?? 0)
  const workOut = Number(g.workOut ?? 1)
  const times = sampleTimes(name, workIn, workOut)

  const graphPath = resolve(tmpGraphDir, `${name}.json`)
  writeFileSync(graphPath, JSON.stringify(g), 'utf8')

  const entry = {
    workIn, workOut,
    settings: g.settings,
    times,
    frames: {},
  }

  console.log(`[${name}] ${times.length} samples, canvas ${g.settings?.width}x${g.settings?.height}`)

  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    const key = `t${String(i).padStart(2, '0')}_${t.toFixed(6)}`
    const bmpPath = resolve(tmpGraphDir, `${name}_${key}.bmp`)
    const meta = runCompose(graphPath, t, bmpPath)
    const { w, h, rgb } = bmpToRgb(readFileSync(bmpPath))
    try { unlinkSync(bmpPath) } catch { /* */ }

    const digest = sha256(rgb)
    const rgbName = `${name}__${key}.rgb`
    const rgbPath = join(outDir, rgbName)
    const metaName = `${name}__${key}.json`

    total++
    const frameInfo = {
      time: t,
      width: w,
      height: h,
      layers: meta.layers,
      sha256: digest,
      rgb: rgbName,
      composeWidth: meta.width,
      composeHeight: meta.height,
    }

    if (checkMode) {
      const expect = prev.fixtures?.[name]?.frames?.[key]
      if (!expect) {
        console.error(`  MISS key ${name}/${key}（hashes.json 无此项）`)
        mismatches++
      } else if (expect.sha256 !== digest) {
        mismatches++
        let psnrInfo = { psnr: NaN, mse: NaN, maxDiff: NaN, firstDiff: -1 }
        const oldRgbPath = join(outDir, expect.rgb || rgbName)
        if (existsSync(oldRgbPath)) {
          const oldRgb = readFileSync(oldRgbPath)
          psnrInfo = psnrRgb(oldRgb, rgb)
          const px = psnrInfo.firstDiff >= 0 ? Math.floor(psnrInfo.firstDiff / 3) : -1
          const ch = psnrInfo.firstDiff >= 0 ? psnrInfo.firstDiff % 3 : -1
          console.error(
            `  DIFF ${name}/${key} t=${t}\n` +
            `    expect=${expect.sha256}\n` +
            `    actual=${digest}\n` +
            `    PSNR=${Number.isFinite(psnrInfo.psnr) ? psnrInfo.psnr.toFixed(3) : 'inf'}dB` +
            ` mse=${psnrInfo.mse} maxDiff=${psnrInfo.maxDiff}` +
            ` firstByte=${psnrInfo.firstDiff} (px=${px} ch=${ch})`,
          )
        } else {
          console.error(
            `  DIFF ${name}/${key} t=${t}\n` +
            `    expect=${expect.sha256}\n` +
            `    actual=${digest}\n` +
            `    （无旧 RGB 文件，无法算 PSNR；可先无 --check 生成 out/）`,
          )
        }
        // check 模式仍写出实际帧便于排查
        writeFileSync(rgbPath, rgb)
        writeFileSync(join(outDir, metaName), JSON.stringify({ ...frameInfo, psnr: psnrInfo }, null, 2))
      } else {
        process.stdout.write('.')
      }
    } else {
      writeFileSync(rgbPath, rgb)
      writeFileSync(join(outDir, metaName), JSON.stringify(frameInfo, null, 2))
      process.stdout.write('.')
    }

    entry.frames[key] = {
      time: t,
      width: w,
      height: h,
      layers: meta.layers,
      sha256: digest,
      rgb: rgbName,
    }
  }
  process.stdout.write('\n')
  report.fixtures[name] = entry
}

if (checkMode) {
  // 也核对 prev 里多出来的 fixture
  for (const name of Object.keys(prev.fixtures || {})) {
    if (!report.fixtures[name]) {
      console.error(`  EXTRA fixture in hashes.json 未再生成: ${name}`)
      mismatches++
    }
  }
  if (mismatches === 0) {
    console.log(`golden --check OK：${total} 帧哈希 100% 一致`)
    process.exit(0)
  }
  console.error(`golden --check FAIL：${mismatches} 处不一致 / 共 ${total} 帧`)
  process.exit(1)
}

writeFileSync(hashesPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(`已写入 ${hashesPath}`)
console.log(`RGB → ${outDir}（gitignore）`)
console.log(`golden 生成完成：${Object.keys(report.fixtures).length} fixtures × ${SAMPLES} = ${total} 帧`)
