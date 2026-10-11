/**
 * 渲一帧（agent 的「改完看一眼」闭环）。
 *
 *   node scripts/render-frame.mjs <工程.todo.json> --at 5.2 [--out frame.png] [--edge 960] [--json]
 *
 * 为什么值得单独做成工具：智能体现在能读工程、能改（命令层）、能验证规范，
 * 但**看不到画面**——所以「这刀切得对不对」只能靠猜。渲一帧后既能让模型看图，也能让机器判定
 * （meanLuma / nonBlackPct / 两次渲染是否一致），把"看起来对不对"变成可回归的检查。
 *
 * 渲染走的是应用监视器同一条路径 renderProgramFrame（见 render-frame-entry.ts），不是另写的近似实现。
 * 输出 JSON 到 stdout；PNG 写 --out（缺省写到 <工程目录>/.frames/<秒>.png）。
 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, dflt = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const project = path.resolve(argv.find((a) => !a.startsWith('--') && a !== flag('--at') && a !== flag('--out') && a !== flag('--edge')) ?? '')
const at = Number(flag('--at', '0'))
const edge = Number(flag('--edge', '960'))
const quiet = argv.includes('--quiet')

if (!project || !existsSync(project)) {
  console.log(JSON.stringify({ ok: false, error: { code: 'not_found', message: `工程文件不存在: ${project}` } }))
  process.exit(2)
}
const outFile = path.resolve(flag('--out', path.join(path.dirname(project), '.frames', `${at.toFixed(3)}.png`)))
mkdirSync(path.dirname(outFile), { recursive: true })

const work = path.join(root, 'native', 'test-output', 'render-frame')
mkdirSync(work, { recursive: true })

const bundle = await build({
  entryPoints: [path.join(root, 'scripts', 'render-frame-entry.ts')],
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
})
writeFileSync(path.join(work, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(path.join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><body><canvas id="cv"></canvas></body>')

const projectB64 = Buffer.from(readFileSync(project, 'utf8'), 'utf8').toString('base64')
const dataDir = path.join(process.env.APPDATA || '', 'todo-editor', 'data').replace(/\\/g, '/')

writeFileSync(path.join(work, 'run.cjs'), `
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const work = ${JSON.stringify(work)}
app.setPath('userData', path.join(work, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600,
    webPreferences: { backgroundThrottling: false, webSecurity: false } })
  await win.loadFile(path.join(work, 'index.html'))
  await win.webContents.executeJavaScript(\`
    window.todoDesktop = { isDesktop: true, platform: 'win32',
      getAiBaseUrl: () => ${JSON.stringify(dataDir)},
      aiBaseUrl: () => ${JSON.stringify(dataDir)},
      getPaths: async () => ({ root: '', projects: '', cache: '', exports: '' }) };
    window.__FRAME__ = { at: ${at}, edge: ${edge} };
    window.__PROJECT__ = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(${JSON.stringify(projectB64)}), (c) => c.charCodeAt(0))));
  \`)
  await win.webContents.executeJavaScript(readFileSync(path.join(work, 'bundle.js'), 'utf8'))
  const result = await win.webContents.executeJavaScript(\`
    (async () => { for (let i = 0; i < 600; i++) {
      if (window.__FRAME_RESULT__) return window.__FRAME_RESULT__;
      await new Promise((r) => setTimeout(r, 100)) }
      return { ok: false, error: 'timeout' } })()\`)
  writeFileSync(path.join(work, 'result.json'), JSON.stringify(result))
  app.exit(result && result.ok ? 0 : 1)
})
`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['--no-sandbox', path.join(work, 'run.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { try { child.kill() } catch { /* */ } resolve(-1) }, 120000)
  child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0) })
})

const resultPath = path.join(work, 'result.json')
let result = null
try { result = JSON.parse(readFileSync(resultPath, 'utf8')) } catch { result = null }

if (!result?.ok) {
  console.log(JSON.stringify({
    ok: false,
    error: { code: code === -1 ? 'timeout' : 'internal', message: result?.error ?? `渲染进程退出码 ${code}`, hint: '看 native/test-output/render-frame/result.json' },
    log: quiet ? undefined : log.slice(-1500),
  }, null, 2))
  process.exit(1)
}

const png = Buffer.from(result.pngBase64, 'base64')
writeFileSync(outFile, png)
const { pngBase64, ...meta } = result
const report = {
  ok: true,
  file: outFile,
  bytes: png.length,
  ...meta,
  // 机器可读的判定：空白帧不该被当成"渲成功"
  blank: meta.meanLuma < 2 && meta.nonBlackPct < 0.2,
  sha256: (await import('node:crypto')).createHash('sha256').update(png).digest('hex').slice(0, 16),
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.blank ? 3 : 0)
