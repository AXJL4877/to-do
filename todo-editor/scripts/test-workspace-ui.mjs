import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'native/test-output/workspace-ui')
mkdirSync(out, { recursive: true })
const bundle = await build({ entryPoints: [resolve(root, 'tests/workspace-ui.browser.tsx')], bundle: true,
  write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' } })
const assets = resolve(root, 'dist/assets')
const css = readdirSync(assets).filter(f => f.endsWith('.css')).map(f => readFileSync(resolve(assets, f), 'utf8')).join('\n')
writeFileSync(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Workspace UI regression</title><style>${css}</style>`)
writeFileSync(resolve(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(resolve(out, 'run.cjs'), `
const {app, BrowserWindow} = require('electron');
const {readFileSync, writeFileSync} = require('node:fs');
app.setPath('userData', ${JSON.stringify(resolve(out, 'profile'))});
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({show:false, width:1440, height:900, useContentSize:true, webPreferences:{backgroundThrottling:false}});
    await win.loadFile(${JSON.stringify(resolve(out, 'index.html'))});
    const result = await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out, 'bundle.js'))}, 'utf8') + '\\nwindow.workspaceTests');
    for (const [width,height] of [[1440,900],[1024,768],[800,650],[640,560]]) {
      win.setContentSize(width,height);
      const layout = await win.webContents.executeJavaScript('window.workspaceCheck()');
      result.results.push({name:'layout '+width+'x'+height,ok:layout.fits,details:layout});
      const screenshot = await win.webContents.capturePage();
      writeFileSync(${JSON.stringify(out)} + '/workspace-'+width+'.png', screenshot.toPNG());
    }
    result.results.push(...await win.webContents.executeJavaScript('window.workspaceOverlayCheck()'));
    win.setContentSize(1440,900);
    result.results.push(...await win.webContents.executeJavaScript('window.workspaceApp()'));
    writeFileSync(${JSON.stringify(out)} + '/app-1440.png', (await win.webContents.capturePage()).toPNG());
    result.failed = result.results.filter(r => !r.ok).length;
    writeFileSync(${JSON.stringify(resolve(out, 'results.json'))},JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
    app.exit(result.failed ? 1 : 0);
  } catch(e) { console.error(e); app.exit(1); }
});
`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const watchdog = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60000)
child.on('exit', code => { clearTimeout(watchdog); process.exitCode = code ?? 1 })
