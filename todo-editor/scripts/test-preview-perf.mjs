/**
 * 预览帧成本实测：把真实工程装进 store，逐时刻跑 renderProgramFrame，
 * 统计每帧耗时 + 当帧参与的图层构成（图/视频/音频）。
 * 用法: node scripts/test-preview-perf.mjs [工程.todo.json] [t1,t2,...]
 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join, default as nodePath } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/preview-perf')
const target = process.argv[2] || 'D:/Desktop/演示草稿/演示草稿.todo.json'
const times = (process.argv[3] || '0.2,1,2,4.3,5,6,9,10,14.9,20,25').split(',').map(Number)
// 传 p_mv* = 按成片文档重建时间轴；否则传工程文件
const isProd = /^p_mv/.test(target)
if (!isProd && !existsSync(resolve(target))) { console.error('缺工程文件', resolve(target)); process.exit(1) }
mkdirSync(out, { recursive: true })

const bundle = await build({
  entryPoints: [resolve(root, 'tests/preview-perf.browser.ts')],
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info',
})
writeFileSync(join(out, 'bundle.js'), bundle.outputFiles[0].text)

const prodJson = isProd ? (await import('../server/production/doc.mjs')).publicProduction(JSON.parse(readFileSync(nodePath.join(process.env.APPDATA, 'todo-editor', 'data', 'productions', target + '.json'), 'utf8'))) : null
const prodB64 = prodJson ? Buffer.from(JSON.stringify(prodJson), 'utf8').toString('base64') : ''
const b64 = isProd ? '' : Buffer.from(readFileSync(resolve(target))).toString('base64')
console.log(`模式 ${isProd ? '成片 ' + target : '工程'}`)
console.log(`模式 ${isProd ? '成片 ' + target : '工程'}`, prodJson ? `分层 ${prodJson.segments?.[0]?.boards?.length ?? 0} 板` : '')

writeFileSync(join(out, 'run.cjs'), `
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const out = ${JSON.stringify(out)}
app.setPath('userData', path.join(out, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600,
    webPreferences: { backgroundThrottling: false, webSecurity: false } })
  await win.loadFile(path.join(out, 'index.html'))
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('[r]', msg) })
  await win.webContents.executeJavaScript(\`
    window.todoDesktop = { isDesktop: true, platform: 'win32',
      getAiBaseUrl: () => ${JSON.stringify((process.env.APPDATA || '').replace(/\\/g, '/') + '/todo-editor/data')},
      aiBaseUrl: () => ${JSON.stringify((process.env.APPDATA || '').replace(/\\/g, '/') + '/todo-editor/data')},
      getPaths: async () => ({ root: '', projects: '', cache: '', exports: '' }) };
    window.__TIMES__ = ${JSON.stringify(times)};
    window.__PLAY_FROM__ = Number(${JSON.stringify(process.env.PLAY_FROM || '')}) || 4.2;
    window.__PLAY_SECS__ = Number(${JSON.stringify(process.env.PLAY_SECS || '')}) || 2.2;
    window.__PRODUCTION__ = ${JSON.stringify(prodB64)} ? JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(${JSON.stringify(prodB64)}), c => c.charCodeAt(0))
    )) : undefined;
    window.__PROJECT__ = ${JSON.stringify(b64)} ? JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0))
    )) : undefined;
  \`)
  await win.webContents.executeJavaScript(readFileSync(path.join(out, 'bundle.js'), 'utf8'))
  const result = await win.webContents.executeJavaScript(\`
    (async () => { for (let i = 0; i < 1200; i++) {
      if (window.__PERF__) return window.__PERF__;
      await new Promise(r => setTimeout(r, 100)) }
      return { failed: true, error: 'timeout' } })() \`)
  writeFileSync(path.join(out, 'perf.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(result.failed ? 1 : 0)
})
`)
writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><body><canvas id="cv"></canvas></body>')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['--no-sandbox', '--disable-gpu', join(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const wd = setTimeout(() => { child.kill(); process.exitCode = 1 }, 300000)
child.on('exit', (c) => { clearTimeout(wd); process.exitCode = c ?? 1 })
