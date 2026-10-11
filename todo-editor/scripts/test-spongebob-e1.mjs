/** 真实海绵宝宝分层成片 → Electron store 入轨与缩放编辑验收。 */
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/spongebob-e1')
const data = process.env.TODO_DATA_DIR || resolve(process.env.APPDATA || '', 'todo-editor/data')
const id = process.argv[2] || 'p_mv1x27lf_pchr'
const src = resolve(data, 'productions', `${id}.json`)
if (!existsSync(src)) {
  console.error('missing production', src)
  process.exit(1)
}
mkdirSync(out, { recursive: true })
const publicProd = JSON.parse(readFileSync(src, 'utf8'))
// attach url fields like API publicView roughly
const outDir = resolve(data, 'ai-generated')
for (const seg of publicProd.segments) {
  if (seg.voice) {
    seg.voice.audioUrl = `/ai-generated/${seg.voice.audio}`
  }
  for (const b of seg.boards || []) {
    for (const e of b.elements || []) {
      for (const v of e.variants || []) {
        if (v.file) v.url = `/ai-generated/${v.file}`
      }
    }
    if (b.render?.result?.elements) {
      for (const el of b.render.result.elements) {
        el.video = el.video?.startsWith('/') ? el.video : `/ai-generated/${el.video}`
        el.hold = el.hold?.startsWith('/') ? el.hold : `/ai-generated/${el.hold}`
      }
    }
  }
}
writeFileSync(resolve(out, 'production.json'), JSON.stringify(publicProd))

const bundle = await build({
  entryPoints: [resolve(root, 'tests/spongebob-e1.browser.ts')],
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
writeFileSync(resolve(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Spongebob E1</title>')
writeFileSync(resolve(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(resolve(out, 'run.cjs'), `
const {app, BrowserWindow} = require('electron');
const {readFileSync} = require('node:fs');
app.setPath('userData', ${JSON.stringify(resolve(out, 'profile'))});
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({show:false, webPreferences:{backgroundThrottling:false}});
    await win.loadFile(${JSON.stringify(resolve(out, 'index.html'))});
    await win.webContents.executeJavaScript('window.spongebobProductionFixture = ' + readFileSync(${JSON.stringify(resolve(out, 'production.json'))}, 'utf8'));
    const result = await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out, 'bundle.js'))}, 'utf8') + '\\nwindow.spongebobE1Tests');
    console.log(JSON.stringify(result, null, 2));
    app.exit(result.failed ? 1 : 0);
  } catch (e) { console.error(e); app.exit(1); }
});
`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 90000)
child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
