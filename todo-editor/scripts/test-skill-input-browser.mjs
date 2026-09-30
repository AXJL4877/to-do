import {build} from 'esbuild'
import electron from 'electron'
import {spawn} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const out=resolve('native/test-output/skill-input');mkdirSync(out,{recursive:true})
const bundle=await build({entryPoints:['tests/skill-input.browser.tsx'],bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
writeFileSync(resolve(out,'index.html'),'<!doctype html><meta charset="utf-8">')
writeFileSync(resolve(out,'bundle.js'),bundle.outputFiles[0].text)
writeFileSync(resolve(out,'run.cjs'),`const {app,BrowserWindow}=require('electron');const {readFileSync}=require('node:fs');app.setPath('userData',${JSON.stringify(resolve(out,'profile'))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadFile(${JSON.stringify(resolve(out,'index.html'))});const r=await win.webContents.executeJavaScript(readFileSync(${JSON.stringify(resolve(out,'bundle.js'))},'utf8')+';window.skillInputTests');console.log(JSON.stringify(r));app.exit(r.failed?1:0)}catch(e){console.error(e);app.exit(1)}})`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[resolve(out,'run.cjs')],{env,stdio:'inherit',windowsHide:true});const watchdog=setTimeout(()=>{child.kill();process.exitCode=1},60000);child.on('exit',code=>{clearTimeout(watchdog);process.exitCode=code??1})
