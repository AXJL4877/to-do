#!/usr/bin/env node
/**
 * TO DO 命令行（智能体与 CI 的入口）。
 *
 * 设计原则：
 *   - **只输出 JSON**（`--human` 才给人看），退出码 0=通过 / 1=检查未过 / 2=用法或读取错误；
 *   - 每个子命令都能离线跑（不需要应用在运行），因为工程是磁盘上的纯文本；
 *   - 与 HTTP 面共用同一批能力 id（见 server/spec/capabilities.mjs），不另造一套命名。
 *
 * 用法:
 *   node server/cli.mjs capabilities
 *   node server/cli.mjs validate <工程.todo.json> [--human]
 *   node server/cli.mjs summary  <工程.todo.json>
 *   node server/cli.mjs clips    <工程.todo.json> [--seq <id>] [--from <秒>] [--to <秒>]
 *   node server/cli.mjs verify   <工程.todo.json> [--human]
 *   node server/cli.mjs migrate  <工程.todo.json>   # 迁移预演（只读）
 *   node server/cli.mjs mcp                       # 以 MCP server 启动（stdio）
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilities } from './spec/capabilities.mjs'
import { PROJECT_CURRENT_VERSION, migrate, versionOf } from './spec/migrations.mjs'
import { describeCommands } from './core/commands.mjs'
import { openSession } from './core/session.mjs'
import { ProjectStore, listSnapshots } from './core/projectStore.mjs'
import { detectSpec, summarizeProject, validateProject } from './spec/projectSpec.mjs'

const USAGE = `TO DO CLI

  capabilities [--catalog]                  打印能力清单（catalog=只给签名）
  validate  <工程.todo.json> [--human]       按规范校验
  summary   <工程.todo.json>                 结构化摘要
  clips     <工程.todo.json> [--seq --from --to]   列出片段（可过滤时间窗）
  verify    <工程.todo.json> [--human]       机读验收（规范 + 素材可达 + 交叉引用）
  migrate   <工程.todo.json>                 迁移预演（只读：版本落差与要跑的迁移边）
  frame     <工程.todo.json> --at 秒 [--out x.png] [--edge 960]   渲一帧（走监视器同一条渲染路径）
  commands  [--catalog]                     命令注册表（写操作的唯一入口）
  app       <inspect|commands|document|run|preview> [命令id] [--args JSON] [--port 9222]
                                             直接驱动运行中的应用（与 exec 同一批命令 id）
  snapshots <工程.todo.json>                 列出环形备份
  recover   <工程.todo.json>                 崩溃恢复预演（只读）
  exec      <工程> <commandId> --args JSON [--write]   执行一条命令（默认预演不落盘）
  mcp                                        以 MCP server 启动（stdio）

通用: --json（默认） --human  --quiet`

const out = (v, human, humanText) => {
  if (human && humanText) process.stdout.write(humanText.endsWith('\n') ? humanText : `${humanText}\n`)
  else process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
}

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--human') flags.human = true
    else if (a === '--quiet') flags.quiet = true
    else if (['--seq', '--from', '--to', '--args', '--at', '--out', '--edge'].includes(a)) { flags[a.slice(2)] = argv[++i] }
    else if (a.startsWith('--')) flags[a.slice(2)] = true
    else rest.push(a)
  }
  return { flags, rest }
}

function loadProject(file) {
  const abs = path.resolve(file)
  if (!existsSync(abs)) throw Object.assign(new Error(`工程文件不存在: ${abs}`), { code: 'not_found' })
  const stat = statSync(abs)
  if (!stat.isFile()) throw Object.assign(new Error(`不是文件: ${abs}`), { code: 'not_found' })
  const raw = readFileSync(abs, 'utf8')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw Object.assign(new Error(`工程 JSON 解析失败: ${e.message}`), { code: 'bad_request' })
  }
  return { abs, doc, bytes: stat.size }
}

/** 机读验收：规范校验 + 素材可达 + 交叉引用统计。 */
function verify(project) {
  const { abs, doc } = project
  const dir = path.dirname(abs)
  const report = validateProject(doc)
  const checks = []

  checks.push({
    id: 'spec.valid', ok: report.ok,
    detail: report.ok ? `spec=${report.spec}` : `${report.errors.length} 个错误`,
    errors: report.errors.map((e) => ({ code: e.code, path: e.path, message: e.message, hint: e.hint })),
  })

  const media = Array.isArray(doc.media) ? doc.media : []
  const referenced = new Set()
  for (const sq of doc.sequences ?? []) for (const c of sq.clips ?? []) if (c.mediaId) referenced.add(c.mediaId)

  const missing = []
  const noRef = []
  for (const m of media) {
    if (!m?.id || !referenced.has(m.id)) continue
    const rel = m.relPath
    if (!rel) { noRef.push({ id: m.id, name: m.name }); continue }
    const p = path.resolve(dir, rel)
    if (!existsSync(p)) missing.push({ id: m.id, name: m.name, relPath: rel })
  }
  checks.push({
    id: 'media.reachable', ok: missing.length === 0,
    detail: missing.length ? `${missing.length} 个被引用素材不在磁盘上` : `${referenced.size} 个被引用素材全部可达`,
    missing,
  })
  checks.push({
    id: 'media.portable', ok: noRef.length === 0,
    detail: noRef.length ? `${noRef.length} 个被引用素材没有可搬走的引用（relPath）` : '全部被引用素材都有 relPath',
    noRef,
  })

  const orphans = report.errors.filter((e) => e.code === 'orphan_media' || e.code === 'orphan_track').length
  checks.push({ id: 'refs.integrity', ok: orphans === 0, detail: orphans ? `${orphans} 个悬空引用` : '无悬空引用' })

  const unreferenced = media.filter((m) => m?.id && !referenced.has(m.id)).length
  checks.push({ id: 'media.unused', ok: true, detail: `${unreferenced} 个媒体未被时间轴引用（提示，不算失败）` })

  return {
    ok: checks.every((c) => c.ok),
    spec: detectSpec(doc),
    file: abs,
    checks,
    stats: report.stats,
    warnings: report.warnings.map((w) => ({ code: w.code, path: w.path, message: w.message })),
  }
}

const clipsView = (doc, { seq, from, to }) => {
  const seqs = Array.isArray(doc.sequences) ? doc.sequences : []
  const chosen = seq ? seqs.filter((s) => s.id === seq) : seqs
  if (seq && !chosen.length) return { ok: false, error: { code: 'not_found', message: `没有序列 ${seq}`, hint: `可用: ${seqs.map((s) => s.id).join(', ')}` } }
  const lo = from == null ? -Infinity : Number(from)
  const hi = to == null ? Infinity : Number(to)
  const media = new Map((doc.media ?? []).map((m) => [m.id, m]))
  const rows = []
  for (const sq of chosen) {
    for (const c of sq.clips ?? []) {
      const a = c.start ?? 0
      const b = a + (c.duration ?? 0)
      if (b <= lo || a >= hi) continue
      const m = media.get(c.mediaId)
      rows.push({
        id: c.id, seq: sq.id, trackId: c.trackId, track: (sq.tracks ?? []).find((t) => t.id === c.trackId)?.kind ?? null,
        name: c.name ?? null, start: a, duration: c.duration ?? 0, end: b,
        mediaId: c.mediaId ?? null, mediaKind: m?.kind ?? null, relPath: m?.relPath ?? null,
        inPoint: c.inPoint, outPoint: c.outPoint, enabled: c.enabled !== false,
        source: c.meta?.source ?? null, text: c.text ? (c.text.content ?? c.text.text ?? true) : null,
      })
    }
  }
  rows.sort((x, y) => x.start - y.start)
  return { ok: true, count: rows.length, window: [lo === -Infinity ? 0 : lo, hi === Infinity ? null : hi], clips: rows }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { flags, rest } = parseArgs(argv.slice(1))
  const file = rest[0]

  switch (cmd) {
    case 'capabilities': {
      const cap = capabilities({ view: flags.catalog ? 'catalog' : 'full' })
      out(cap, flags.human, [
        `${cap.app.name}  ${cap.spec}  工程规范 ${cap.projectSpec}`,
        `操作 ${cap.operations.length} 条：`,
        ...cap.operations.map((o) => `  [${o.status === 'stable' ? '可用' : '待建'}] ${o.id.padEnd(26)} ${o.method.padEnd(5)} ${o.path}`),
      ].join('\n'))
      return 0
    }
    case 'validate': {
      if (!file) { console.error(USAGE); return 2 }
      const p = loadProject(file)
      const r = validateProject(p.doc)
      out(r, flags.human, [
        `${p.abs}  (${(p.bytes / 1024).toFixed(1)} KB)`,
        `spec=${r.spec}  ok=${r.ok}  ${JSON.stringify(r.stats)}`,
        ...r.errors.map((e) => `  ERROR ${e.code} @ ${e.path}\n        ${e.message}${e.hint ? `\n        提示: ${e.hint}` : ''}`),
        ...r.warnings.map((w) => `  warn  ${w.code} @ ${w.path}\n        ${w.message}${w.hint ? `\n        提示: ${w.hint}` : ''}`),
      ].join('\n'))
      return r.ok ? 0 : 1
    }
    case 'summary': {
      if (!file) { console.error(USAGE); return 2 }
      const p = loadProject(file)
      out(summarizeProject(p.doc))
      return 0
    }
    case 'clips': {
      if (!file) { console.error(USAGE); return 2 }
      const p = loadProject(file)
      const r = clipsView(p.doc, { seq: flags.seq, from: flags.from, to: flags.to })
      out(r, flags.human, r.ok
        ? [`${p.abs}  窗口 ${JSON.stringify(r.window)}  共 ${r.count} 个片段`,
          ...r.clips.map((c) => `  ${c.start.toFixed(2)}s +${c.duration.toFixed(2)}s  ${String(c.track ?? '?').padEnd(8)} ${String(c.name ?? '').slice(0, 22).padEnd(24)} ${c.mediaId ?? ''}`)].join('\n')
        : JSON.stringify(r.error))
      return r.ok ? 0 : 1
    }
    case 'verify': {
      if (!file) { console.error(USAGE); return 2 }
      const p = loadProject(file)
      const r = verify(p)
      out(r, flags.human, [
        `${p.abs}   spec=${r.spec}   ok=${r.ok}`,
        ...r.checks.map((c) => `  ${c.ok ? 'OK  ' : 'NG  '}${c.id.padEnd(18)} ${c.detail}`),
      ].join('\n'))
      return r.ok ? 0 : 1
    }
    case 'migrate': {
      if (!file) { console.error(USAGE); return 2 }
      const p = loadProject(file)
      const from = versionOf(p.doc)
      const r = migrate(p.doc)
      const plan = r.ok
        ? { ok: true, file: p.abs, from, to: r.to, applied: r.applied, needsMigration: r.applied.length > 0 }
        : { ok: false, file: p.abs, from, error: r.error }
      out(plan, flags.human, plan.ok
        ? [`${p.abs}`, `格式 v${plan.from} → v${plan.to}（当前支持 v${PROJECT_CURRENT_VERSION}）`,
          ...(plan.applied.length ? plan.applied.map((a) => `  将执行 ${a}`) : ['  无需迁移'])].join('\n')
        : JSON.stringify(plan.error, null, 2))
      return plan.ok ? 0 : 1
    }
    case 'commands': {
      const list = describeCommands({ withParams: !flags.catalog })
      out({ ok: true, commands: list }, flags.human,
        list.map((c) => `  ${c.id.padEnd(26)} ${c.label}${c.destructive ? '  ⚠️破坏性' : ''}`).join('\n'))
      return 0
    }
    case 'exec': {
      // 默认**不落盘**（预演）；--write 才保存。路径与参数都必填。
      const commandId = rest[1]
      if (!file || !commandId) { console.error(`${USAGE}\n\nexec 需要: <工程> <commandId> --args '<json>' [--write]`); return 2 }
      let args = {}
      if (typeof flags.args === 'string') {
        try { args = JSON.parse(flags.args) } catch (e) {
          process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'bad_request', message: `--args 不是合法 JSON: ${e.message}` } }, null, 2)}\n`)
          return 2
        }
      } else if (flags.args !== undefined) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'bad_request', message: '--args 需要一段 JSON 字符串' } }, null, 2)}\n`)
        return 2
      }
      // 走 ProjectStore：带写锁 + 恢复日志 + 环形备份（与 UI/MCP 同一套崩溃恢复语义）
      const opened = ProjectStore.open(file)
      if (!opened.ok) { process.stdout.write(`${JSON.stringify(opened, null, 2)}\n`); return 2 }
      const store = opened.store
      const s = store.session
      const before = s.summary()
      const r = store.exec(commandId, args)
      if (!r.ok) {
        store.close()
        out({ ok: false, error: r.error, file: opened.path }, flags.human, JSON.stringify(r.error, null, 2))
        return 1
      }
      let saved = null
      let snapshot = null
      if (flags.write) {
        const w = store.save()
        saved = w.ok ? w.path : null
        snapshot = w.snapshot?.name ?? null
        if (!w.ok) { store.close(); out({ ok: false, error: w.error }, flags.human, JSON.stringify(w.error, null, 2)); return 1 }
      }
      store.close()
      const report = {
        ok: true, file: opened.path, command: commandId, args,
        summary: r.summary, changed: r.changed, created: r.created,
        validation: s.validate().ok ? 'valid' : 'invalid',
        clipsBefore: before.sequences[0]?.clips ?? null,
        clipsAfter: s.summary().sequences[0]?.clips ?? null,
        written: saved, snapshot, dryRun: !flags.write,
      }
      out(report, flags.human, [
        `${opened.path}`,
        `${commandId} → ${r.summary}`,
        `  片段 ${report.clipsBefore} → ${report.clipsAfter}   校验 ${report.validation}`,
        flags.write ? `  已写入 ${saved}` : '  预演（未落盘；加 --write 保存）',
      ].join('\n'))
      return 0
    }
    case 'otio': {
      // OpenTimelineIO 互操作。注意它**不是无损**的（OTIO 轨道是顺序模型），
      // 所以两个方向都返回 lossy 清单：丢了什么必须说出来。
      const sub = rest[0] ?? 'export'
      // otio 的参数布局是 <sub> <file>；file 变量在本命令里被占成子命令名了，所以另取
      const target = rest[1] ?? ''
      const { toOtio, fromOtio } = await import('./interchange/otio.mjs')
      if (sub === 'export') {
        if (!target) { console.error(`${USAGE}\n\notio export 需要: <工程.todo.json> [--out x.otio] [--seq <id>]`); return 2 }
        const p = loadProject(target)
        const { otio, lossy } = toOtio(p.doc, { sequenceId: flags.seq ?? null })
        if (!otio) { out({ ok: false, lossy }, flags.human, lossy.map((l) => `  ${l.code}: ${l.message}`).join('\n')); return 1 }
        const outPath = flags.out ? path.resolve(String(flags.out)) : p.abs.replace(/\.todo\.json$/i, '.otio')
        writeFileSync(outPath, `${JSON.stringify(otio, null, 2)}\n`, 'utf8')
        const report = { ok: true, file: outPath, clips: otio.tracks.children.reduce((n, t) => n + t.children.filter((c) => c.OTIO_SCHEMA === 'Clip.1').length, 0), tracks: otio.tracks.children.length, lossy }
        out(report, flags.human, [
          `${outPath}`,
          `  ${report.tracks} 条轨道 / ${report.clips} 个片段`,
          ...(lossy.length ? ['  有损：', ...lossy.map((l) => `    - ${l.code}: ${l.message}`)] : ['  无损']),
        ].join('\n'))
        return 0
      }
      if (sub === 'import') {
        if (!target) { console.error(`${USAGE}\n\notio import 需要: <x.otio> --out <工程.todo.json>`); return 2 }
        const otio = JSON.parse(readFileSync(path.resolve(target), 'utf8'))
        const { sequence, lossy } = fromOtio(otio, {})
        if (!sequence) { out({ ok: false, lossy }, flags.human, lossy.map((l) => `  ${l.code}: ${l.message}`).join('\n')); return 1 }
        const report = { ok: true, sequenceId: sequence.id, tracks: sequence.tracks.length, clips: sequence.clips.length, lossy }
        out(report, flags.human, [
          `导入：${sequence.tracks.length} 条轨道 / ${sequence.clips.length} 个片段`,
          ...(lossy.length ? ['  有损：', ...lossy.map((l) => `    - ${l.code}: ${l.message}`)] : []),
        ].join('\n'))
        return 0
      }
      console.error(`otio 子命令只能是 export / import`)
      return 2
    }
    case 'snapshots': {
      if (!file) { console.error(USAGE); return 2 }
      const list = listSnapshots(path.resolve(file), { limit: 99 })
      out({ ok: true, file: path.resolve(file), count: list.length, snapshots: list }, flags.human,
        list.length ? list.map((s) => `  ${s.at}  ${(s.bytes / 1024).toFixed(1)}KB  ${s.name}`).join('\n') : '  （没有备份）')
      return 0
    }
    case 'recover': {
      if (!file) { console.error(USAGE); return 2 }
      const opened = ProjectStore.open(file)
      if (!opened.ok) { process.stdout.write(`${JSON.stringify(opened, null, 2)}\n`); return 2 }
      const plan = opened.store.recoveryPlan()
      const snaps = opened.store.snapshots()
      opened.store.close()
      const report = { ok: plan.ok, file: opened.path, ...plan, snapshots: snaps.length }
      out(report, flags.human, [
        `${opened.path}`,
        `  崩溃残留: ${plan.crashed ? '是' : '否'}   可重放编辑: ${plan.entries ?? 0}`,
        `  ${plan.note}`,
        ...(plan.replayed?.length ? [`  将重放: ${plan.replayed.join(' → ')}`] : []),
        ...(plan.reason ? [`  停在: 第 ${plan.stoppedAt + 1} 条 — ${plan.reason}`] : []),
        `  可用备份: ${snaps.length} 份`,
      ].join('\n'))
      return plan.ok ? 0 : 1
    }
    case 'frame': {
      // 渲一帧需要 Electron：转交给 scripts/render-frame.mjs（子进程），把它的 JSON 原样透出。
      if (!file) { console.error(`${USAGE}\n\nframe 需要: <工程> --at <秒> [--out x.png] [--edge 960]`); return 2 }
      const { spawnSync } = await import('node:child_process')
      const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // server/ 的上一层 = 仓库根
      const sub = [path.join(repoRoot, 'scripts', 'render-frame.mjs'), path.resolve(file), '--at', String(flags.at ?? 0)]
      if (flags.out) sub.push('--out', String(flags.out))
      if (flags.edge) sub.push('--edge', String(flags.edge))
      const r = spawnSync(process.execPath, sub, { cwd: repoRoot, encoding: 'utf8' })
      process.stdout.write(r.stdout || r.stderr || '')
      return r.status ?? 1
    }
    case 'app': {
      // 直接驱动**运行中**的应用（走命令桥 + CDP）。与 exec 的区别：exec 改磁盘文件，app 改内存里的活文档。
      const { spawnSync } = await import('node:child_process')
      const repoRoot2 = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
      // rest 的语义：parseArgs 收到的是 argv.slice(1)（命令名已被剥掉），
      // 所以 rest[0] 才是动作、rest[1] 才是命令 id。写成 rest[1]/rest[2] 会静默退化成 inspect。
      const action = rest[0] ?? 'inspect'
      const sub = [path.join(repoRoot2, 'scripts', 'app-command.mjs'), action]
      if (rest[1]) sub.push(rest[1])
      if (flags.args) sub.push('--args', String(flags.args))
      if (flags.port) sub.push('--port', String(flags.port))
      const r = spawnSync(process.execPath, sub, { cwd: repoRoot2, encoding: 'utf8' })
      process.stdout.write(r.stdout || r.stderr || '')
      return r.status ?? 1
    }
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.mjs')
      await runMcpServer()
      return 0
    }
    default:
      console.error(USAGE)
      return 2
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 统一错误契约：机器可读
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: e.code ?? 'internal', message: String(e.message ?? e), retryable: false } }, null, 2)}\n`)
    process.exit(2)
  })
