/**
 * 独立 AI HTTP 服务（Electron 正式包用不依赖 Vite）。
 * 用法: node server/aiServer.mjs [--port N|0]
 * 就绪后 stdout 一行: {"ok":true,"port":N}
 */
import http from 'node:http'
import { createAiMiddleware, kickAiWorker } from './aiHttp.mjs'

function parsePort(argv) {
  const i = argv.indexOf('--port')
  if (i >= 0 && argv[i + 1] != null) {
    const n = Number(argv[i + 1])
    if (Number.isFinite(n) && n >= 0) return n
  }
  return 0
}

const port = parsePort(process.argv.slice(2))
kickAiWorker()

const middleware = createAiMiddleware()
const server = http.createServer((req, res) => {
  void middleware(req, res, () => {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  const p = typeof addr === 'object' && addr ? addr.port : port
  process.stdout.write(`${JSON.stringify({ ok: true, port: p })}\n`)
})

server.on('error', (e) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(e) })}\n`)
  process.exit(1)
})
