import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'native/test-output/media-management');mkdirSync(out,{recursive:true})
const bundle=await build({entryPoints:[resolve(root,'tests/media-management.browser.tsx')],bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"','import.meta.env.DEV':'false'}})
const assets=resolve(root,'dist/assets'),css=existsSync(assets)?readdirSync(assets).filter(n=>n.endsWith('.css')).map(n=>readFileSync(resolve(assets,n),'utf8')).join('\n'):''
writeFileSync(resolve(out,'index.html'),`<!doctype html><meta charset="utf-8"><style>${css}</style>`)
writeFileSync(resolve(out,'bundle.js'),bundle.outputFiles[0].text)
writeFileSync(resolve(out,'run.cjs'),`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(resolve(out,'profile'))});
app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,width:480,height:850,webPreferences:{backgroundThrottling:false}});await win.loadFile(${JSON.stringify(resolve(out,'index.html'))});const result=await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(resolve(out,'bundle.js'))},'utf8')+'\\nwindow.mediaManagementTests');fs.writeFileSync(${JSON.stringify(resolve(out,'results.json'))},JSON.stringify(result,null,2));await new Promise(r=>setTimeout(r,500));await win.webContents.capturePage();await new Promise(r=>setTimeout(r,100));fs.writeFileSync(${JSON.stringify(resolve(out,'preview.png'))},(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('window.mediaProgressPreview()');win.setContentSize(430,330);await new Promise(r=>setTimeout(r,500));result.progress=await win.webContents.executeJavaScript("[...document.querySelectorAll('[role=progressbar]')].map(p=>({percent:p.getAttribute('aria-valuenow'),fill:p.querySelector('.cp-sketch-fill').getBoundingClientRect().width,track:p.querySelector('.cp-sketch-track').getBoundingClientRect().width}))");for(const p of result.progress){if(p.percent!==null){const ok=Math.abs(p.fill/p.track-Number(p.percent)/100)<.005;result.results.push({name:'drawn fill equals '+p.percent+'%',ok});if(!ok)result.failed++}}await win.webContents.capturePage();await new Promise(r=>setTimeout(r,100));fs.writeFileSync(${JSON.stringify(resolve(out,'progress.png'))},(await win.webContents.capturePage()).toPNG());fs.writeFileSync(${JSON.stringify(resolve(out,'results.json'))},JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(result.failed?1:0)}catch(e){console.error(e);app.exit(1)}})
`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[resolve(out,'run.cjs')],{env,stdio:'inherit',windowsHide:true});const timer=setTimeout(()=>{child.kill();process.exitCode=1},60000);child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
