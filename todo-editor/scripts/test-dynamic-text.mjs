import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/dynamic-text')
mkdirSync(out, { recursive: true })
const bundle = await build({ entryPoints: [resolve(root, 'tests/dynamic-text.browser.tsx')], bundle: true,
  write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
const assets = resolve(root, 'dist/assets')
const css = readdirSync(assets).filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(assets, f), 'utf8')).join('\n')
writeFileSync(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Dynamic text regression</title><style>${css}</style>`)
writeFileSync(resolve(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(resolve(out, 'run.cjs'), `
const {app, BrowserWindow} = require('electron');
const {readFileSync, writeFileSync} = require('node:fs');
app.setPath('userData', ${JSON.stringify(resolve(out, 'profile'))});
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({show:false, width:1100, height:800, webPreferences:{backgroundThrottling:false}});
    await win.loadFile(${JSON.stringify(resolve(out, 'index.html'))});
    const result = await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out, 'bundle.js'))}, 'utf8') + '\\nwindow.dynamicTests');
    if (result.gallery) writeFileSync(${JSON.stringify(resolve(out, 'gallery.png'))}, Buffer.from(result.gallery.split(',')[1], 'base64'));
    if (result.exportFixtures) writeFileSync(${JSON.stringify(resolve(out, 'export-fixtures.json'))}, JSON.stringify(result.exportFixtures));
    writeFileSync(${JSON.stringify(resolve(out, 'full-export-fixtures.json'))}, JSON.stringify(result.fullExportFixtures));
    delete result.fullExportFixtures;
    delete result.exportFixtures;
    if (result.fullGallery) writeFileSync(${JSON.stringify(resolve(out, 'full-gallery.png'))}, Buffer.from(result.fullGallery.split(',')[1], 'base64'));
    delete result.fullGallery;
    delete result.gallery;
    writeFileSync(${JSON.stringify(resolve(out, 'results.json'))}, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    app.exit(result.failed ? 1 : 0);
  } catch (error) { console.error(error); app.exit(1); }
});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60000)
child.on('exit', code => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
