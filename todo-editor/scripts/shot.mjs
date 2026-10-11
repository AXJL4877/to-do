/**
 * shot.mjs — 用 CDP 给当前窗口截图，存成 PNG。
 * 用法: node scripts/shot.mjs <输出路径> [--port 9222]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const out = argv[0]
const portIdx = argv.indexOf('--port')
const port = portIdx >= 0 ? argv[portIdx + 1] : (process.env.TODO_DEBUG_PORT || '9222')
if (!out) { console.error('用法: node scripts/shot.mjs <输出路径>'); process.exit(2) }

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('没有可连页面'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, { res, rej })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })

// 让布局稳定再截
await send('Runtime.evaluate', { expression: 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))', awaitPromise: true })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
writeFileSync(path.resolve(out), Buffer.from(shot.data, 'base64'))
console.log(`✓ 截图 ${out}  ${Math.round(Buffer.from(shot.data, 'base64').length / 1024)} KB`)
ws.close()
