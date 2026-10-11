/**
 * MCP server（stdio，JSON-RPC 2.0，零依赖）。
 *
 * 为什么是 MCP 而不是只给 REST：智能体接入的标准面是 MCP——工具清单自带 inputSchema 与
 * readOnly/destructive 提示，宿主能据此做审批与并行调度；长任务还能发 progress 通知。
 *
 * 本文件只做**只读 + 离线**的工具（工程在磁盘上是纯文本，不需要应用在运行）：
 *   todo_capabilities / todo_project_validate / todo_project_summary / todo_project_clips / todo_verify
 * 写操作（timeline.command / render / export）留到命令层落地后，按同一套 id 加进来。
 *
 * 启动: node server/cli.mjs mcp      （stdout 只走 JSON-RPC，日志一律进 stderr）
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilities } from './spec/capabilities.mjs'
import { PROJECT_CURRENT_VERSION, migrate, versionOf } from './spec/migrations.mjs'
import { describeCommands } from './core/commands.mjs'
import { openSession } from './core/session.mjs'
import { ProjectStore, listSnapshots } from './core/projectStore.mjs'
import { summarizeProject, validateProject } from './spec/projectSpec.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = path.join(HERE, '..', 'shared', 'spec')
const SUPPORTED_PROTOCOL = '2024-11-05'

const log = (...a) => process.stderr.write(`[todo-mcp] ${a.join(' ')}\n`)

const loadJson = (p) => {
  const abs = path.resolve(String(p ?? ''))
  if (!abs || !existsSync(abs)) throw new Error(`工程文件不存在: ${abs}`)
  return { abs, doc: JSON.parse(readFileSync(abs, 'utf8')) }
}

/** 工具表：描述与 HTTP 能力清单同源（id 对齐），参数 schema 直接给智能体看。 */
const TOOLS = [
  {
    name: 'todo_capabilities',
    title: '能力清单',
    description: '列出 TO DO 现在能做什么（操作 id、HTTP 路径、错误码、命令契约、时间基准）。规划任何操作前先读它。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => capabilities(),
  },
  {
    name: 'todo_project_validate',
    title: '校验工程',
    description: '按 todo-project 规范校验工程文件：交叉引用、悬空 id、派生镜像漂移、同轨重叠。返回 errors[].code/path/hint，可直接据此修复。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '工程文件路径（.todo.json）' } },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p }) => validateProject(loadJson(p).doc),
  },
  {
    name: 'todo_project_summary',
    title: '工程摘要',
    description: '把工程压成结构化摘要：画布、序列、轨道与片段数、时长、成片登记、素材清单。规划编辑前先读它，比读原始 JSON 省几百倍 token。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工程文件路径' },
        maxMedia: { type: 'integer', description: '素材样例上限，默认 40', minimum: 0, maximum: 500 },
      },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p, maxMedia }) => summarizeProject(loadJson(p).doc, { maxMedia: Number(maxMedia ?? 40) }),
  },
  {
    name: 'todo_project_clips',
    title: '列出片段',
    description: '列出时间轴片段（可按序列与时间窗过滤），含轨道、素材、入出点与 AI 溯源信息。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sequenceId: { type: 'string', description: '限定序列 id，缺省=全部序列' },
        from: { type: 'number', description: '时间窗起点，单位：秒' },
        to: { type: 'number', description: '时间窗终点，单位：秒' },
      },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p, sequenceId, from, to }) => {
      const { doc } = loadJson(p)
      const seqs = (doc.sequences ?? []).filter((s) => !sequenceId || s.id === sequenceId)
      if (sequenceId && !seqs.length) throw new Error(`没有序列 ${sequenceId}；可用: ${(doc.sequences ?? []).map((s) => s.id).join(', ')}`)
      const lo = from == null ? -Infinity : Number(from)
      const hi = to == null ? Infinity : Number(to)
      const media = new Map((doc.media ?? []).map((m) => [m.id, m]))
      const rows = []
      for (const sq of seqs) {
        for (const c of sq.clips ?? []) {
          const a = c.start ?? 0
          const b = a + (c.duration ?? 0)
          if (b <= lo || a >= hi) continue
          const m = media.get(c.mediaId)
          rows.push({
            id: c.id, seq: sq.id, trackId: c.trackId,
            trackKind: (sq.tracks ?? []).find((t) => t.id === c.trackId)?.kind ?? null,
            name: c.name ?? null, start: a, duration: c.duration ?? 0, end: b,
            mediaId: c.mediaId ?? null, mediaKind: m?.kind ?? null, relPath: m?.relPath ?? null,
            inPoint: c.inPoint, outPoint: c.outPoint, enabled: c.enabled !== false,
            source: c.meta?.source ?? null,
          })
        }
      }
      rows.sort((x, y) => x.start - y.start)
      return { ok: true, count: rows.length, clips: rows }
    },
  },
  {
    name: 'todo_project_migrate_plan',
    title: '迁移预演',
    description: '只读预演：这份工程的格式版本、本版本支持的版本、以及会执行哪些迁移边。读取未来版本会明确拒绝（不会半读半写）。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p }) => {
      const { doc, abs } = loadJson(p)
      const from = versionOf(doc)
      const r = migrate(doc)
      return r.ok
        ? { ok: true, file: abs, from, to: r.to, applied: r.applied, currentVersion: PROJECT_CURRENT_VERSION }
        : { ok: false, file: abs, from, error: r.error, currentVersion: PROJECT_CURRENT_VERSION }
    },
  },
  {
    name: 'todo_verify',
    title: '机读验收',
    description: '跑机读验收：规范校验 + 被引用素材是否在磁盘上 + 是否都可搬走（relPath）+ 悬空引用统计。返回 checks[] 与 warnings[]。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p }) => {
      const { doc, abs } = loadJson(p)
      const dir = path.dirname(abs)
      const report = validateProject(doc)
      const referenced = new Set()
      for (const sq of doc.sequences ?? []) for (const c of sq.clips ?? []) if (c.mediaId) referenced.add(c.mediaId)
      const media = (doc.media ?? []).filter((m) => m?.id && referenced.has(m.id))
      const missing = media.filter((m) => m.relPath && !existsSync(path.resolve(dir, m.relPath)))
        .map((m) => ({ id: m.id, name: m.name, relPath: m.relPath }))
      const noRef = media.filter((m) => !m.relPath).map((m) => ({ id: m.id, name: m.name }))
      const checks = [
        { id: 'spec.valid', ok: report.ok, detail: report.ok ? `spec=${report.spec}` : `${report.errors.length} 个错误` },
        { id: 'media.reachable', ok: missing.length === 0, detail: missing.length ? `${missing.length} 个缺失` : `${media.length} 个全部可达` },
        { id: 'media.portable', ok: noRef.length === 0, detail: noRef.length ? `${noRef.length} 个没有 relPath` : '全部有 relPath' },
      ]
      return { ok: checks.every((c) => c.ok), spec: report.spec, file: abs, checks, missing, noRef, stats: report.stats }
    },
  },

  {
    name: 'todo_commands_list',
    title: '命令注册表',
    description: '列出可写操作（命令）：id、标签、类别、是否破坏性、参数 schema。**改工程前先读它**——写入只能通过这些 id，不能直接改 JSON。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { withParams: { type: 'boolean', description: '是否附参数 schema（默认 true）' } },
      additionalProperties: false,
    },
    run: ({ withParams }) => ({ ok: true, commands: describeCommands({ withParams: withParams !== false }) }),
  },
  {
    name: 'todo_command_preview',
    title: '命令预演',
    description: '在内存里跑一条命令并返回结果：改了什么、新建了哪些 id、改动后是否仍合规、以及改动后的片段数。**不落盘**——智能体可以放心试。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工程文件路径' },
        command: { type: 'string', description: '命令 id，取自 todo_commands_list' },
        args: { type: 'object', description: '命令参数（按该命令的 schema）' },
      },
      required: ['path', 'command'], additionalProperties: false,
    },
    run: ({ path: p, command, args }) => {
      const opened = openSession(p)
      if (!opened.ok) throw new Error(opened.error.message)
      const s = opened.session
      const before = s.summary()
      const r = s.exec(String(command), args ?? {})
      if (!r.ok) return { ok: false, command, error: r.error, unchanged: true }
      const after = s.summary()
      return {
        ok: true, command, summary: r.summary, changed: r.changed, created: r.created,
        validationAfter: s.validate().ok ? 'valid' : 'invalid',
        clipsBefore: before.sequences?.[0]?.clips ?? null,
        clipsAfter: after.sequences?.[0]?.clips ?? null,
        durationAfter: after.sequences?.[0]?.duration ?? null,
        note: '预演未落盘；要落盘请在应用内执行同一条命令',
      }
    },
  },

  {
    name: 'todo_render_frame',
    title: '渲一帧看图',
    description: '把工程在某一时刻渲成 PNG 并**直接把画面回给你**（MCP image content）。改完时间轴用它确认画面：先 todo_command_preview 看改动，再渲一帧看图。返回同时带机器可读指标（meanLuma/nonBlackPct/blank/sha256）——空白帧会被标出来，不会假装成功。渲染走监视器同一条路径。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工程文件路径' },
        at: { type: 'number', description: '时刻，单位：秒' },
        edge: { type: 'integer', description: '目标长边像素（默认 960；给模型看图 640~960 够用）' },
      },
      required: ['path', 'at'], additionalProperties: false,
    },
    run: ({ path: p, at, edge }) => {
      const repoRoot = path.join(HERE, '..')
      const out = path.join(os.tmpdir(), `todo-frame-${Date.now()}.png`)
      const args = [path.join(repoRoot, 'scripts', 'render-frame.mjs'), path.resolve(String(p)), '--at', String(at), '--out', out]
      if (edge) args.push('--edge', String(Number(edge)))
      const r = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })
      let meta = null
      try { meta = JSON.parse((r.stdout || '').trim().split('\n').slice(-40).join('\n')) } catch { meta = null }
      if (!meta?.ok) throw new Error(`渲染失败：${(r.stderr || r.stdout || '').slice(-400)}`)
      const data = readFileSync(out).toString('base64')
      try { unlinkSync(out) } catch { /* 临时文件删不掉不影响 */ }
      const { file, ...rest } = meta
      return { __mcpImage: { data, mimeType: 'image/png' }, ...rest, bytes: Math.floor((data.length * 3) / 4) }
    },
  },

  {
    name: 'todo_app_inspect',
    title: '看运行中的应用状态',
    description: '读取**正在运行的编辑器**的实时状态：工程校验结果、结构化摘要、可用命令表、内存里的工程文档。区别于文件类工具：这里读的是应用内存中的活文档（磁盘文件只是快照）。需要应用以开发模式运行（命令桥只在开发模式挂载）。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'commands', 'document'], description: '缺省 inspect' },
        port: { type: 'integer', description: 'CDP 调试端口，默认 9222' },
      },
      additionalProperties: false,
    },
    run: ({ action, port }) => appCommand(action ?? 'inspect', null, null, port),
  },
  {
    name: 'todo_app_command',
    title: '在运行中的应用里执行命令',
    description: '把一条命令发给**正在运行的编辑器**执行（改的是它内存里的活文档）。闭环用法：todo_app_inspect 看状态 → 本工具 action:"preview" 试算 → action:"run" 落实 → todo_render_frame 看图。命令 id 取自 todo_commands_list，与 CLI 用的是同一份实现和同一道写入闸门。**run 会改动应用里的工程**（可用应用自身的撤销回退）。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'preview'], description: 'run=写回并进撤销栈；preview=只试算不提交' },
        command: { type: 'string', description: '命令 id' },
        args: { type: 'object', description: '命令参数' },
        port: { type: 'integer', description: 'CDP 调试端口，默认 9222' },
      },
      required: ['action', 'command'], additionalProperties: false,
    },
    run: ({ action, command, args, port }) => appCommand(action, command, args ?? {}, port),
  },

  {
    name: 'todo_project_snapshots',
    title: '列环形备份',
    description: '列出该工程的环形自动保存备份（新→旧）：文件名、时间、大小。工程搬不动/改坏了可以从这里找回上一版。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p }) => {
      const abs = path.resolve(String(p ?? ''))
      const list = listSnapshots(abs, { limit: 99 })
      return { ok: true, file: abs, count: list.length, snapshots: list }
    },
  },
  {
    name: 'todo_recovery_plan',
    title: '崩溃恢复预演',
    description: '检查该工程有没有崩溃残留的未保存编辑（读 .journal.jsonl），并**在内存里重放命令**给出恢复结果与可用的备份。只读，不落盘。',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    },
    run: ({ path: p }) => {
      const opened = ProjectStore.open(p, { lock: false })
      if (!opened.ok) throw new Error(opened.error.message)
      const plan = opened.store.recoveryPlan()
      const snaps = opened.store.snapshots()
      return { ok: plan.ok, file: opened.path, ...plan, snapshotCount: snaps.length, snapshots: snaps.slice(0, 5) }
    },
  },
]


/** 调用 scripts/app-command.mjs：把命令发给运行中的应用（唯一入口，避免两条实现）。 */
function appCommand(action, command, args, port) {
  const repoRoot = path.join(HERE, '..')
  const argv = [path.join(repoRoot, 'scripts', 'app-command.mjs'), action]
  if (command) argv.push(command)
  if (args) argv.push('--args', JSON.stringify(args))
  if (port) argv.push('--port', String(port))
  const r = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  if (!out) throw new Error(r.stderr?.trim() || '连不上应用（没在跑，或没用 --debug-port 启动？）')
  let parsed = null
  try { parsed = JSON.parse(out) } catch { throw new Error(`应用返回的不是 JSON：${out.slice(0, 200)}`) }
  if (parsed.ok === false && parsed.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return parsed
}
const RESOURCES = [
  { uri: 'todo://capabilities', name: '能力清单', mimeType: 'application/json', file: null, build: () => JSON.stringify(capabilities(), null, 2) },
  { uri: 'todo://spec/project-v2', name: '工程文件 JSON Schema', mimeType: 'application/json', file: path.join(SPEC_DIR, 'project-v2.schema.json') },
  { uri: 'todo://spec/readme', name: '规范索引与权威字段表', mimeType: 'text/markdown', file: path.join(SPEC_DIR, 'README.md') },
]

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcErr = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return rpcOk(id, {
        protocolVersion: asked === SUPPORTED_PROTOCOL ? asked : SUPPORTED_PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
        serverInfo: { name: 'todo-editor', version: '1.0.0' },
        instructions: 'TO DO 是本地优先的剪辑引擎。先用 todo_project_summary 了解工程，再用 todo_project_clips 读时间轴；改工程前用 todo_project_validate 确认合规；todo_capabilities 给出全部可用操作（含尚未实现的，标注 planned）。',
      })
    }
    case 'ping':
      return rpcOk(id, {})
    case 'tools/list':
      return rpcOk(id, {
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return rpcErr(id, -32602, `未知工具 ${params?.name}`, { available: TOOLS.map((t) => t.name) })
      const args = params?.arguments ?? {}
      const unknown = Object.keys(args).filter((k) => !(k in (tool.inputSchema.properties ?? {})))
      if (unknown.length) {
        return rpcErr(id, -32602, `未知参数 ${unknown.join(', ')}`, { accepted: Object.keys(tool.inputSchema.properties ?? {}) })
      }
      try {
        const result = tool.run(args)
        if (result && result.__mcpImage) {
          const { __mcpImage, ...meta } = result
          return rpcOk(id, {
            content: [
              { type: 'image', data: __mcpImage.data, mimeType: __mcpImage.mimeType },
              { type: 'text', text: JSON.stringify(meta, null, 2) },
            ],
            structuredContent: meta, isError: false,
          })
        }
        return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false })
      } catch (e) {
        return rpcOk(id, { content: [{ type: 'text', text: `工具执行失败: ${e.message}` }], isError: true })
      }
    }
    case 'resources/list':
      return rpcOk(id, { resources: RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })) })
    case 'resources/read': {
      const r = RESOURCES.find((x) => x.uri === params?.uri)
      if (!r) return rpcErr(id, -32602, `未知资源 ${params?.uri}`, { available: RESOURCES.map((x) => x.uri) })
      const text = r.file ? readFileSync(r.file, 'utf8') : r.build()
      return rpcOk(id, { contents: [{ uri: r.uri, mimeType: r.mimeType, text }] })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null // 通知：不回包
    default:
      return rpcErr(id, -32601, `未实现的方法 ${method}`)
  }
}

export async function runMcpServer() {
  log(`ready (protocol ${SUPPORTED_PROTOCOL}, tools=${TOOLS.length}, resources=${RESOURCES.length})`)
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        let msg = null
        try {
          msg = JSON.parse(line)
        } catch {
          process.stdout.write(`${JSON.stringify(rpcErr(null, -32700, 'JSON 解析失败'))}\n`)
        }
        if (msg) {
          const reply = handle(msg)
          if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
        }
      }
      nl = buf.indexOf('\n')
    }
  }
  log('stdin closed, exiting')
}
