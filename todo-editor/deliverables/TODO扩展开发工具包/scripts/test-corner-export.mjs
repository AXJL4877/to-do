import electron from 'electron'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,[fileURLToPath(new URL('./test-corner-export.cjs',import.meta.url))],{env,stdio:'inherit',windowsHide:true})
const timer=setTimeout(()=>{child.kill();process.exitCode=1},120000)
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
