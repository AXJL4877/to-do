/**
 * MCP 会话冒烟测试：起 server，走一遍 initialize → tools/list → tools/call → resources/read。
 * 用法: node server/spec/__fixtures__/mcp-session.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', '..', 'cli.mjs')
const fixture = path.join(here, 'minimal.todo.json')

const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', (d) => {
  buf += String(d)
  let nl = buf.indexOf('\n')
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) {
      const msg = JSON.parse(line)
      const r = pending.get(msg.id)
      if (r) { pending.delete(msg.id); r(msg) }
    }
    nl = buf.indexOf('\n')
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, resolve)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时: ${method}`)) } }, 15000)
})
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

const results = []
try {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'todo-editor')
  notify('notifications/initialized', {})
  results.push(`initialize → ${init.result.protocolVersion} / ${init.result.serverInfo.name}`)

  const tools = await call('tools/list', {})
  const names = tools.result.tools.map((t) => t.name)
  assert.deepEqual(names.sort(), ['todo_app_command', 'todo_app_inspect', 'todo_capabilities', 'todo_command_preview', 'todo_commands_list', 'todo_project_clips', 'todo_project_migrate_plan', 'todo_project_snapshots', 'todo_project_summary', 'todo_project_validate', 'todo_recovery_plan', 'todo_render_frame', 'todo_verify'])
  for (const t of tools.result.tools) assert.ok(t.inputSchema?.type === 'object', `${t.name} 缺 inputSchema`)
  // 工具注解必须是**显式布尔**，且只读工具不得同时声明破坏性。
  // 早期这里断言"全部工具都 readOnlyHint:true"——加入第一个会改文档的工具（todo_app_command）后
  // 那条断言本身就错了：MCP 的语义是"每个工具都要如实声明"，不是"所有工具都只读"。
  assert.ok(tools.result.tools.every((t) => typeof t.annotations?.readOnlyHint === 'boolean' && typeof t.annotations?.destructiveHint === 'boolean'), '每个工具都要显式声明 readOnlyHint / destructiveHint')
  assert.ok(tools.result.tools.every((t) => !(t.annotations.readOnlyHint === true && t.annotations.destructiveHint === true)), '只读工具不能同时声明破坏性')
  const writeTools = tools.result.tools.filter((t) => t.annotations.readOnlyHint === false)
  assert.ok(writeTools.every((t) => t.annotations.destructiveHint === true), '会写文档的工具必须声明破坏性')
  results.push(`tools/list → ${names.length} 个工具，注解显式（会写文档的 ${writeTools.length} 个：${writeTools.map((t) => t.name).join(', ')}）`)

  const sum = await call('tools/call', { name: 'todo_project_summary', arguments: { path: fixture } })
  const sumData = sum.result.structuredContent
  assert.equal(sumData.ok, true)
  assert.equal(sumData.canvas.width, 1920)
  assert.equal(sumData.sequences[0].clips, 4)
  results.push(`tools/call summary → 画布 ${sumData.canvas.width}x${sumData.canvas.height}，片段 ${sumData.sequences[0].clips}，时长 ${sumData.sequences[0].duration}s`)

  const val = await call('tools/call', { name: 'todo_project_validate', arguments: { path: fixture } })
  assert.equal(val.result.structuredContent.ok, true)
  results.push(`tools/call validate → ok（warnings ${val.result.structuredContent.warnings.length}）`)

  const clips = await call('tools/call', { name: 'todo_project_clips', arguments: { path: fixture, from: 5, to: 11 } })
  assert.equal(clips.result.structuredContent.ok, true)
  results.push(`tools/call clips(5~11s) → ${clips.result.structuredContent.count} 个片段`)

  const bad = await call('tools/call', { name: 'todo_project_validate', arguments: { path: fixture, 未知参数: 1 } })
  assert.ok(bad.error && bad.error.code === -32602, '未知参数必须报 -32602')
  assert.ok(bad.error.data.accepted.includes('path'))
  results.push(`未知参数 → JSON-RPC -32602，并列出可接受参数 ${JSON.stringify(bad.error.data.accepted)}`)

  const missing = await call('tools/call', { name: 'todo_project_validate', arguments: { path: 'D:/不存在/x.todo.json' } })
  assert.equal(missing.result.isError, true)
  results.push(`文件不存在 → isError:true，文案「${missing.result.content[0].text}」`)

  const res = await call('resources/list', {})
  assert.equal(res.result.resources.length, 3)
  const read = await call('resources/read', { uri: 'todo://spec/project-v2' })
  const schema = JSON.parse(read.result.contents[0].text)
  assert.ok(schema.$defs.clip, 'schema 里应有 clip 定义')
  results.push(`resources/read → ${res.result.resources.length} 个资源；schema 解析成功（clip 定义存在）`)

  const cap = await call('tools/call', { name: 'todo_capabilities', arguments: {} })
  assert.equal(cap.result.structuredContent.spec, 'todo-capabilities/1')
  results.push(`capabilities → ${cap.result.structuredContent.operations.length} 条操作`)

  const cmds = await call('tools/call', { name: 'todo_commands_list', arguments: {} })
  const list = cmds.result.structuredContent.commands
  assert.ok(list.length >= 10, '命令表至少 10 条')
  assert.ok(list.every((c) => c.params?.type === 'object' && c.params.additionalProperties === false))
  results.push(`commands_list → ${list.length} 条命令，参数 schema 全部规范（additionalProperties:false）`)

  const before = readFileSync(fixture, 'utf8')
  const dry = await call('tools/call', {
    name: 'todo_command_preview',
    arguments: { path: fixture, command: 'timeline.add_clip', args: { trackId: 'tr_v1', mediaId: 'm_v1', start: 20, duration: 2 } },
  })
  const dryData = dry.result.structuredContent
  assert.equal(dryData.ok, true, JSON.stringify(dryData.error))
  assert.equal(dryData.clipsBefore, 4)
  assert.equal(dryData.clipsAfter, 5)
  assert.equal(dryData.validationAfter, 'valid')
  assert.equal(readFileSync(fixture, 'utf8'), before, '预演绝不能落盘')
  results.push(`command_preview → ${dryData.summary}；片段 ${dryData.clipsBefore}→${dryData.clipsAfter}；文件未被改动`)

  const dryBad = await call('tools/call', {
    name: 'todo_command_preview',
    arguments: { path: fixture, command: 'timeline.split_clip', args: { clipId: 'cl_v1', at: 999 } },
  })
  assert.equal(dryBad.result.structuredContent.ok, false)
  assert.match(dryBad.result.structuredContent.error.message, /必须落在片段内部/)
  assert.equal(readFileSync(fixture, 'utf8'), before, '失败的预演也不能改动文件')
  results.push(`command_preview 失败路径 → ${dryBad.result.structuredContent.error.code}：「${dryBad.result.structuredContent.error.message}」`)

  const frame = await call('tools/call', { name: 'todo_render_frame', arguments: { path: fixture, at: 2, edge: 320 } })
  const items = frame.result.content
  const img = items.find((i) => i.type === 'image')
  assert.ok(img?.data, '应返回图片内容')
  assert.equal(img.mimeType, 'image/png')
  assert.ok(img.data.length > 500, `PNG base64 太小：${img.data?.length}`)
  assert.equal(frame.result.structuredContent.blank, false, '空帧必须被标出来')
  assert.ok(frame.result.structuredContent.meanLuma > 0)
  results.push(`render_frame → ${frame.result.structuredContent.width}x${frame.result.structuredContent.height} PNG ${(img.data.length / 1024).toFixed(0)}KB(base64)，meanLuma=${frame.result.structuredContent.meanLuma}，blank=${frame.result.structuredContent.blank}，sha=${frame.result.structuredContent.sha256}`)

  console.log('MCP 会话冒烟通过：')
  for (const r of results) console.log('  ✔ ' + r)
  child.kill()
  process.exit(0)
} catch (e) {
  console.error('MCP 冒烟失败:', e.message)
  child.kill()
  process.exit(1)
}
