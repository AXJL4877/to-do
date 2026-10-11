/**
 * 用 DevTools 协议直连 APP 的渲染进程（Electron 就是 Chromium）。
 *
 * 用法:
 *   node scripts/todo-cdp.mjs "表达式"                 求值并打印结果
 *   node scripts/todo-cdp.mjs --file script.js         求值文件里的表达式
 *   node scripts/todo-cdp.mjs --json "表达式"          只打印 JSON
 *   node scripts/todo-cdp.mjs --targets                列出可连目标
 * 端口用 --port 指定，默认 9222（启动器: node scripts/open-todo-app.mjs --debug-port 9222）
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const port = portIdx >= 0 ? argv[portIdx + 1] : (process.env.TODO_DEBUG_PORT || '9222')
const listTargets = argv.includes('--targets')
const fileIdx = argv.indexOf('--file')
const expr = fileIdx >= 0 ? readFileSync(argv[fileIdx + 1], 'utf8') : argv.filter((a) => !a.startsWith('--') && a !== port).join(' ')

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page')
if (listTargets) {
  for (const p of pages) console.log(`${p.title}\t${p.url}\t${p.webSocketDebuggerUrl}`)
  process.exit(0)
}
if (!pages.length) { console.error('没有可连的页面目标；APP 是不是没用 --debug-port 启动？'); process.exit(1) }
if (!expr) { console.error('给一个表达式，例如: node scripts/todo-cdp.mjs "document.title"'); process.exit(1) }

const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, { res, rej })
  ws.send(JSON.stringify({ id: mid, method, params }))
})

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })

try {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  })
  if (r.exceptionDetails) {
    console.error('表达式抛错:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails).slice(0, 500))
    process.exitCode = 1
  } else {
    const v = r.result?.value
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  }
} finally {
  ws.close()
}
