/**
 * 安装版/win-unpacked 运行证据：原生引擎 probe+compose，AI 文件存在，主程序可启动并存活。
 * 默认读 C:\\todo-editor-release\\win-unpacked（electron-builder 产物）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output')
mkdirSync(out, { recursive: true })

const appOut = process.env.TODO_PACK_DIR || 'C:\\todo-editor-release\\win-unpacked'
const exe = join(appOut, 'TO DO.exe')
const engine = join(appOut, 'resources', 'native', 'todo-media-engine.exe')
const ffmpeg = join(appOut, 'resources', 'native', 'ffmpeg.exe')
const ai = join(appOut, 'resources', 'app.asar.unpacked', 'server', 'aiServer.mjs')

function fail(msg) {
  throw new Error(msg)
}

if (!existsSync(appOut)) fail(`缺少 win-unpacked：${appOut}（先 electron-builder --dir）`)
if (!existsSync(exe)) fail(`缺少主程序：${exe}`)
if (!existsSync(engine)) fail(`缺少 packaged engine：${engine}`)
if (!existsSync(ffmpeg)) fail(`缺少 packaged ffmpeg：${ffmpeg}`)
if (!existsSync(ai)) fail(`缺少 packaged AI：${ai}`)

const sample = resolve(out, 'native_av.mp4')
if (!existsSync(sample)) fail('缺少 native/test-output/native_av.mp4（先 npm run native:test）')

const probe = spawnSync(engine, ['probe', sample], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
if (probe.status !== 0) fail(`packaged probe 失败: ${probe.stderr || probe.stdout}`)
const probeJson = JSON.parse((probe.stdout || '').trim().split('\n').pop())
if (!probeJson.ok) fail(`packaged probe not ok: ${JSON.stringify(probeJson)}`)

const graph = resolve(out, 'pack_smoke_graph.json')
const bmp = resolve(out, 'pack_smoke_compose.bmp')
writeFileSync(graph, JSON.stringify({
  version: 1,
  clips: [{ mediaPath: sample.replaceAll('\\', '/'), start: 0, duration: 1, inPoint: 0, trackId: 'v1', enabled: true, kind: 'video' }],
  tracks: [{ id: 'v1', kind: 'video' }],
  settings: { width: 320, height: 180, fps: 25 },
  workIn: 0, workOut: 1,
}))
const compose = spawnSync(engine, ['compose', graph, '0.2', bmp], {
  encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, PATH: `${join(appOut, 'resources', 'native')};${process.env.PATH || ''}` },
})
if (compose.status !== 0) fail(`packaged compose 失败: ${compose.stderr || compose.stdout}`)
const composeJson = JSON.parse((compose.stdout || '').trim().split('\n').pop())
if (!composeJson.ok || !existsSync(bmp)) fail(`packaged compose not ok: ${JSON.stringify(composeJson)}`)

/** 启动主程序，短暂存活即视为路径可运行 */
const child = spawn(exe, [], {
  cwd: appOut,
  windowsHide: false,
  detached: true,
  stdio: 'ignore',
})
child.unref()
await new Promise((r) => setTimeout(r, 2500))
let appLaunchedAlive = false
try {
  process.kill(child.pid, 0)
  appLaunchedAlive = true
} catch {
  appLaunchedAlive = false
}
try { process.kill(child.pid) } catch { /* already exited */ }

const report = {
  ok: true,
  appOutDir: appOut,
  engine,
  packagedProbe: !!probeJson.ok,
  packagedComposeBmp: existsSync(bmp),
  packagedAi: existsSync(ai),
  appLaunchedAlive,
  composeBackend: composeJson.backend,
  at: new Date().toISOString(),
}
writeFileSync(resolve(out, 'pack-smoke-report.json'), JSON.stringify(report, null, 2))
writeFileSync(resolve(out, 'pack-dir-report.json'), JSON.stringify({
  ok: true,
  appOutDir: appOut,
  checks: {
    exe: existsSync(exe),
    engine: existsSync(engine),
    ffmpeg: existsSync(ffmpeg),
    ai: existsSync(ai),
    probe: !!probeJson.ok,
    gpu: composeJson.backend === 'todo-cpp-d3d11-compose',
    asar: existsSync(join(appOut, 'resources', 'app.asar')),
  },
  at: new Date().toISOString(),
}, null, 2))

if (!appLaunchedAlive) fail('主程序启动后未存活')
console.log('pack:smoke 通过', report)
