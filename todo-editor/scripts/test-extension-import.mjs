import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, 'native/test-output/extension-import')
mkdirSync(out, { recursive: true })
const bundle = await build({ entryPoints: [path.join(root, 'tests/extension-import.browser.ts')], bundle: true, write: false, format: 'iife' })
writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8">')
writeFileSync(path.join(out, 'bundle.js'), bundle.outputFiles[0].text)
writeFileSync(path.join(out, 'run.cjs'), `
const {app,BrowserWindow}=require('electron'); const {readFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});
app.whenReady().then(async()=>{ try {
const win=new BrowserWindow({show:false}); await win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});
const result=await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(path.join(out, 'bundle.js'))},'utf8')+'\\nwindow.extensionTests');
console.log(JSON.stringify(result)); app.exit(0);
}catch(e){console.error(e);app.exit(1)}});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.join(out, 'run.cjs')], { env, stdio: 'inherit', windowsHide: true })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60000)
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
