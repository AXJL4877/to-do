/**
 * 真实工程预览逐帧取样：把已绑定的分层成片入轨，用宿主同一套 renderProgramFrame 出帧，
 * 统计「近黑占比 / 彩色占比」，用来判定预览是否黑屏。
 * 用法: node scripts/preview-koubo-real.mjs [productionId] [t1,t2,...]
 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/koubo-preview-real')
const data = process.env.TODO_DATA_DIR || resolve(process.env.APPDATA || '', 'todo-editor/data')
const id = process.argv[2] || 'p_mvmin_wipe1'
const times = (process.argv[3] || '0.5,2,4.4,5.2,7,12').split(',').map(Number)

const src = resolve(data, 'productions', `${id}.json`)
if (!existsSync(src)) {
  console.error('missing production', src)
  process.exit(1)
}
mkdirSync(out, { recursive: true })

const prod = (await import('../server/production/doc.mjs')).publicProduction(
  JSON.parse(readFileSync(src, 'utf8')),
)
// 本机绝对路径：file:///<data>/ai-generated/<file>
const aiRoot = join(data, 'ai-generated').replace(/\\/g, '/')
const aiBase = data.replace(/\\/g, '/')

const bundle = await build({
  entryPoints: [resolve(root, 'tests/preview-koubo-real.browser.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
writeFileSync(join(out, 'bundle.js'), bundle.outputFiles[0].text)

writeFileSync(join(out, 'run.cjs'), `
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const out = ${JSON.stringify(out)}
app.setPath('userData', path.join(out, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 900, height: 600,
    webPreferences: { backgroundThrottling: false, webSecurity: false, offscreen: false },
  })
  await win.loadFile(path.join(out, 'index.html'))
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', level, message, sourceId ? sourceId + ':' + line : '')
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer gone]', JSON.stringify(details))
  })
  await win.webContents.executeJavaScript(\`
    window.todoDesktop = {
      isDesktop: true, platform: 'win32',
      getAiBaseUrl: () => ${JSON.stringify(aiBase)},
      aiBaseUrl: () => ${JSON.stringify(aiBase)},
      getPaths: async () => ({ root: ${JSON.stringify(data)}, projects: '', cache: '', exports: '' }),
    };
    window.__AI_ROOT__ = ${JSON.stringify(aiRoot)};
    window.__TIMES__ = ${JSON.stringify(times)};
    window.spongebobProductionFixture = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(${JSON.stringify(Buffer.from(JSON.stringify(prod), 'utf8').toString('base64'))}), (c) => c.charCodeAt(0))
    ));
  \`)
  await win.webContents.executeJavaScript(readFileSync(path.join(out, 'bundle.js'), 'utf8'))
  const result = await win.webContents.executeJavaScript(\`
    (async () => {
      for (let i = 0; i < 1200; i++) {
        if (window.kouboPreviewResult) return window.kouboPreviewResult
        await new Promise(r => setTimeout(r, 100))
      }
      return { failed: true, error: 'timeout' }
    })()
  \`)
  const allFrames = [...(result.frames || []), ...(result.brokenFrames || []), ...(result.repairedFrames || [])]
  for (const f of allFrames) {
    if (!f.dataUrl) continue
    writeFileSync(path.join(out, 'frame_' + f.tag + '_' + String(f.t).replace('.', 'p') + '.png'),
      Buffer.from(f.dataUrl.replace(/^data:image\\/png;base64,/, ''), 'base64'))
    delete f.dataUrl
  }
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(result && result.failed ? 1 : 0)
})
`)

writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Koubo Preview</title>
<style>html,body{margin:0;background:#111;color:#eee;font:13px/1.4 sans-serif}</style>
<div id="meta"></div><canvas id="cv" width="960" height="540"></canvas>`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', join(out, 'run.cjs')], {
  env, stdio: 'inherit', windowsHide: true,
})
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 180000)
child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
