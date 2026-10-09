import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve('.'), out = path.join(root,'native/test-output/corner-chain')
mkdirSync(out,{recursive:true})
const bundle = await build({entryPoints:['tests/corner-chain.browser.ts'],bundle:true,write:false,format:'iife'})
writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8">')
writeFileSync(path.join(out,'bundle.js'),bundle.outputFiles[0].text)
writeFileSync(path.join(out,'run.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});await win.loadFile(${JSON.stringify(path.join(out,'index.html'))});const r=await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(path.join(out,'bundle.js'))},'utf8')+'\\nwindow.cornerTests');fs.writeFileSync(${JSON.stringify(path.join(out,'fixtures.json'))},JSON.stringify(r.fixtures));fs.writeFileSync(${JSON.stringify(path.join(out,'gallery.png'))},Buffer.from(r.gallery.split(',')[1],'base64'));delete r.fixtures;delete r.gallery;console.log(JSON.stringify(r));app.exit(0)}catch(e){console.error(e);app.exit(1)}})`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[path.join(out,'run.cjs')],{env,stdio:'inherit',windowsHide:true})
const timer=setTimeout(()=>{child.kill();process.exitCode=1},60000);child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
