/**
 * 直连**运行中的应用**执行命令 —— 让外部智能体操作你正在编辑的那个工程。
 *
 *   node scripts/app-command.mjs inspect
 *   node scripts/app-command.mjs commands
 *   node scripts/app-command.mjs document
 *   node scripts/app-command.mjs preview timeline.split_clip --args '{"clipId":"cl_x","at":3}'
 *   node scripts/app-command.mjs run     timeline.razor_at   --args '{"at":3}'
 *
 * 为什么走 CDP 而不是自己读工程文件：
 *   工程的真身是**渲染进程内存里的文档**，磁盘上的文件只是一个快照。外部工具若直接改文件，
 *   应用不会知道（下次保存就把你的改动覆盖掉）。只有让应用自己执行命令，才谈得上「人机同入口」。
 *
 * 前提：应用以开发模式启动（`node scripts/open-todo-app.mjs --debug-port 9222`）——
 * 命令桥 `window.__TODO_CMD__` 只在开发模式挂载，打包版不暴露这个入口。
 *
 * 与 CLI 里 `exec` 的区别：
 *   `exec`  作用于**磁盘上的工程文件**（离线、无 UI、可批量、可 CI）
 *   `app run` 作用于**运行中的应用内存**（在线、改完立刻能看到画面）
 * 两者用的是同一批命令 id、同一份校验器与写入闸门。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const action = argv.find((a) => !a.startsWith('--')) ?? 'inspect'
const flag = (name, dflt = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const port = flag('--port', process.env.TODO_DEBUG_PORT || '9222')
const commandId = argv.slice(1).find((a) => !a.startsWith('--') && a !== flag('--args')) ?? null
const rawArgs = flag('--args', '{}')

let args = {}
try {
  args = JSON.parse(rawArgs)
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: { code: 'bad_request', message: `--args 不是合法 JSON: ${e.message}` } }, null, 2))
  process.exit(2)
}

const needCommand = action === 'run' || action === 'preview'
if (needCommand && !commandId) {
  console.log(JSON.stringify({ ok: false, error: { code: 'bad_request', message: `${action} 需要命令 id，例如: node scripts/app-command.mjs run timeline.razor_at --args '{"at":3}'` } }, null, 2))
  process.exit(2)
}

// 在应用里执行的表达式：只用命令桥，不碰内部实现。
// 注意 todo-cdp.mjs 会把这段包进函数体，所以这里直接写 return，不要再套一层 IIFE。
const expr = `
  const b = window.__TODO_CMD__
  if (!b) return JSON.stringify({ ok: false, error: { code: 'unsupported',
    message: '命令桥未挂载：应用需要以开发模式启动（open-todo-app.mjs --debug-port 9222）' } })
  try {
    const st = b.store.getState()
    const base = { title: document.title, started: st.started, dirty: st.dirty }
    ${needCommand
      ? `const r = b.${action === 'run' ? 'run' : 'preview'}(${JSON.stringify(commandId)}, ${JSON.stringify(args)})
         return JSON.stringify({ ok: r.ok, action: ${JSON.stringify(action)}, command: ${JSON.stringify(commandId)},
           summary: r.summary, changed: r.changed, created: r.created, error: r.error, live: base })`
      : (action === 'undo' || action === 'redo')
        ? (() => { const st = b.store.getState(); if (!st.started) return JSON.stringify({ ok: false, error: { code: 'conflict', message: '没有打开工程' } }); if (action === 'undo') st.undo(); else st.redo(); const st2 = b.store.getState(); return JSON.stringify({ ok: true, action, summaryAfter: b.inspect().summary, live: { title: document.title, started: st2.started, dirty: st2.dirty } }) })()
      : action === 'commands'
        ? `return JSON.stringify({ ok: true, commands: b.commands(), live: base })`
        : action === 'document'
          ? `return JSON.stringify({ ok: true, document: b.document(), live: base })`
          : `const i = b.inspect()
             return JSON.stringify({ ok: i.validate.ok, validate: { spec: i.validate.spec, ok: i.validate.ok,
               errors: i.validate.errors, warnings: i.validate.warnings.length, stats: i.validate.stats },
               summary: i.summary, live: base })`}
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: 'internal', message: String(e && e.message ? e.message : e) } })
  }
`

const r = spawnSync(process.execPath, [path.join(here, 'todo-cdp.mjs'), '--port', String(port), expr], { encoding: 'utf8' })
const out = (r.stdout || '').trim()
if (!out) {
  console.log(JSON.stringify({
    ok: false,
    error: { code: 'unavailable', message: r.stderr?.trim() || '连不上应用（是不是没在跑，或没用 --debug-port 启动？）' },
  }, null, 2))
  process.exit(1)
}
// todo-cdp.mjs 会打印结果本身；这里原样透出并给出退出码
console.log(out)
process.exit(/\"ok\":\s*false/.test(out) ? 1 : 0)
