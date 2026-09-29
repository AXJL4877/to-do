import electron from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('./test-chalk-integration.cjs', import.meta.url))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [script], { env, stdio: 'inherit', windowsHide: true })
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1 }, 120000)
child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1 })
