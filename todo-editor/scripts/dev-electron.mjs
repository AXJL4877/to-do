/**
 * 桌面开发启动：先让系统分配一个空闲端口，再把 Vite 和 Electron 都绑到这个地址。
 * 和正式包里 AI 服务的 `--port 0` 同一套做法，不再钉死 5173。
 */
import net from 'node:net'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron')

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      probe.close((err) => err ? reject(err) : resolve(port))
    })
  })
}

const port = await allocatePort()
if (!port) {
  console.error('没有分到空闲端口')
  process.exit(1)
}

const server = await createServer({
  root,
  server: { host: '127.0.0.1', port, strictPort: true },
})
await server.listen()
const bound = server.httpServer?.address()
const actual = bound && typeof bound === 'object' ? bound.port : 0
if (actual !== port) {
  console.error(`开发服务没有绑到分配的端口 ${port}`)
  await server.close()
  process.exit(1)
}

const url = `http://127.0.0.1:${actual}`
console.log(`开发服务 ${url}`)

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
  stdio: 'inherit',
})

let closing = false
async function shutdown(code = 0) {
  if (closing) return
  closing = true
  if (child.exitCode == null && !child.killed) child.kill()
  await server.close()
  process.exit(code)
}

child.on('exit', (code) => { void shutdown(code ?? 0) })
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
