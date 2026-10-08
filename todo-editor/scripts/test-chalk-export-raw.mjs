import electron from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [fileURLToPath(new URL('./test-chalk-export-raw.cjs', import.meta.url))], { env, stdio: 'inherit', windowsHide: true })
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1 }, 120000)
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1 })
