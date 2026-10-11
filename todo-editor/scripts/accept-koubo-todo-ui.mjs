/**
 * 实机验收：在 Electron 里加载真实分层成片 → 入轨 → 检查开场红字/可编辑/音轨(BGM)。
 * 用法: node scripts/accept-koubo-todo-ui.mjs [productionId]
 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/spongebob-koubo/ui-accept')
const data = process.env.TODO_DATA_DIR || resolve(process.env.APPDATA || '', 'todo-editor/data')
const id = process.argv[2] || 'p_mv1x27lf_pchr'
const src = resolve(data, 'productions', `${id}.json`)
if (!existsSync(src)) {
  console.error('missing production', src)
  process.exit(1)
}

mkdirSync(out, { recursive: true })
const publicProd = JSON.parse(readFileSync(src, 'utf8'))
const outDir = resolve(data, 'ai-generated')
for (const seg of publicProd.segments) {
  if (seg.voice) seg.voice.audioUrl = `/ai-generated/${seg.voice.audio}`
  for (const b of seg.boards || []) {
    for (const e of b.elements || []) {
      for (const v of e.variants || []) {
        if (v.file) v.url = `/ai-generated/${v.file}`
      }
    }
    for (const el of b.render?.result?.elements || []) {
      if (el.video && !el.video.startsWith('/')) el.video = `/ai-generated/${el.video}`
      if (el.hold && !el.hold.startsWith('/')) el.hold = `/ai-generated/${el.hold}`
    }
  }
}
writeFileSync(join(out, 'production.json'), JSON.stringify(publicProd))

const vite = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:8736'
const bundle = await build({
  entryPoints: [resolve(root, 'tests/accept-koubo-todo.browser.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
writeFileSync(join(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Koubo Accept</title>
<style>html,body{margin:0;background:#111;color:#eee;font:14px/1.4 sans-serif}#stage{width:960px;height:540px;background:#000;margin:12px}canvas{width:100%;height:100%}</style>
<div id="meta"></div><div id="stage"><canvas id="cv" width="1920" height="1080"></canvas></div>`)

writeFileSync(join(out, 'run.cjs'), `
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const out = ${JSON.stringify(out)}
app.setPath('userData', path.join(out, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true,
    width: 1100,
    height: 720,
    webPreferences: { backgroundThrottling: false, webSecurity: false },
  })
  await win.loadFile(path.join(out, 'index.html'))
  // Serve holds via file URLs for canvas draw
  const prod = JSON.parse(readFileSync(path.join(out, 'production.json'), 'utf8'))
  const aiRoot = ${JSON.stringify(outDir.replace(/\\\\/g, '/'))}
  await win.webContents.executeJavaScript('window.__AI_ROOT__ = ' + JSON.stringify(aiRoot))
  await win.webContents.executeJavaScript('window.spongebobProductionFixture = ' + JSON.stringify(prod))
  await win.webContents.executeJavaScript(readFileSync(path.join(out, 'bundle.js'), 'utf8'))
  // wait for async main()
  const result = await win.webContents.executeJavaScript(\`
    (async () => {
      for (let i = 0; i < 100; i++) {
        if (window.kouboAcceptTests) return window.kouboAcceptTests
        await new Promise(r => setTimeout(r, 100))
      }
      return { failed: true, results: [{ name: 'timeout', ok: false, error: 'kouboAcceptTests missing' }] }
    })()
  \`)
  const img = await win.capturePage()
  writeFileSync(path.join(out, 'window.png'), img.toPNG())
  // also dump canvas
  try {
    const dataUrl = await win.webContents.executeJavaScript('document.getElementById("cv").toDataURL("image/png")')
    const b64 = dataUrl.replace(/^data:image\\/png;base64,/, '')
    writeFileSync(path.join(out, 'canvas-intro.png'), Buffer.from(b64, 'base64'))
  } catch {}
  writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
`)

const env = { ...process.env, VITE_DEV_SERVER_URL: vite }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [join(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: false })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 120000)
child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
