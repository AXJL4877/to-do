/**
 * todo-ctl.mjs — 让外部 agent 完全接管 TO DO 的「控制实例」
 *
 * 为什么需要它：AI agent 常常运行在只能写工作区的沙箱里，而应用的用户数据默认在
 * AppData（区外）。此时：
 *   · Electron 拉起的 aiServer 写 AppData → EPERM
 *   · Python（包内管线）写 AppData     → PermissionError [WinError 5]
 * 两者都不是应用缺陷，是沙箱边界。本脚本把数据目录搬到工作区内，从而：
 *   1) 用 TODO_DATA_DIR 指向工作区，起一个**只属于 agent**的 aiServer（固定端口）
 *   2) 驱动它跑真实生成、读产物、校验
 *   3) 默认完全离线可用；不动用户的 AppData
 *
 * 用法：
 *   node scripts/todo-ctl.mjs setup                 # 建控制数据目录（幂等）
 *   node scripts/todo-ctl.mjs start [--port 7411]   # 起控制服务（后台）
 *   node scripts/todo-ctl.mjs stop                  # 停
 *   node scripts/todo-ctl.mjs status                # 探活 + 列出成片
 *   node scripts/todo-ctl.mjs list                  # 列出成片与任务
 *   node scripts/todo-ctl.mjs run <productionId> [--force]   # 跑生成并轮询到结束
 *   node scripts/todo-ctl.mjs new --script-file <txt> [--params-json <json>]  # 新建成片
 *   node scripts/todo-ctl.mjs verify <productionId>  # 校验产物（层/音效/BGM/URL）
 */
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_DATA = path.join(process.env.APPDATA || '', 'todo-editor', 'data')
const CTL = path.join(ROOT, '.data-ctl')
const CTL_DATA = path.join(CTL, 'data')
const PID_FILE = path.join(CTL, 'server.pid')
const LOG_FILE = path.join(CTL, 'server.log')
const DEFAULT_PORT = 7411

/** 这些目录是可再生的重物，搬过来只是浪费时间和磁盘 */
const SKIP_DIRS = new Set(['__pycache__', '.git', 'node_modules', 'wipe_cache', '_asset_stage', 'logs'])
const SKIP_EXT = new Set(['.npz', '.pyc'])

const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? true) : dflt
}
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)

function log(...a) { console.log(...a) }

function port() { return Number(flag('port', DEFAULT_PORT)) }

async function api(pathname, init) {
  const url = `http://127.0.0.1:${port()}${pathname}`
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!res.ok || (json && json.ok === false)) {
    throw new Error(`${init?.method || 'GET'} ${pathname} → ${res.status} ${json ? JSON.stringify(json.error) : text.slice(0, 300)}`)
  }
  return json ?? text
}

function copyFiltered(src, dest) {
  let copied = 0, skipped = 0, busy = 0
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, name.name)
      const d = path.join(to, name.name)
      if (name.isDirectory()) {
        if (SKIP_DIRS.has(name.name)) { skipped++; continue }
        walk(s, d)
      } else if (name.isFile()) {
        if (SKIP_EXT.has(path.extname(name.name).toLowerCase())) { skipped++; continue }
        // 已存在就跳过：setup 是幂等的，重复 start 不该重写（Windows 上覆盖被占用的文件
        // 会抛 EBUSY，且报错文案是误导性的 "The operation completed successfully"）
        if (existsSync(d)) { skipped++; continue }
        try {
          cpSync(s, d, { errorOnExist: false })
          copied++
        } catch (e) {
          // 复制素材只是"省一次付费生成"，个别文件被占用不该让整个 setup 失败
          busy++
          if (busy <= 3) log(`  ! 跳过占用文件 ${name.name}（${e.code || e.message}）`)
        }
      }
    }
  }
  walk(src, dest)
  return { copied, skipped, busy }
}

function setup() {
  mkdirSync(CTL_DATA, { recursive: true })
  for (const d of ['skills', 'styles', 'anims', 'productions', 'ai-generated']) {
    mkdirSync(path.join(CTL_DATA, d), { recursive: true })
  }

  // 1) AI 密钥：能抄就抄，让真实生成可用（只在工作区内，不碰 AppData）
  const cfgSrc = path.join(APP_DATA, 'ai-config.json')
  const cfgDst = path.join(CTL_DATA, 'ai-config.json')
  if (existsSync(cfgSrc) && !existsSync(cfgDst)) {
    cpSync(cfgSrc, cfgDst)
    log('✓ 复制 ai-config.json（真实生成可用）')
  } else if (existsSync(cfgDst)) {
    log('· ai-config.json 已存在')
  } else {
    log('! 没有 ai-config.json：只能离线跑，真实生成会失败')
  }

  // 2) 技能包：跳过可再生缓存
  const skSrc = path.join(APP_DATA, 'skills')
  if (existsSync(skSrc)) {
    for (const name of readdirSync(skSrc, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dst = path.join(CTL_DATA, 'skills', name.name)
      const r = copyFiltered(path.join(skSrc, name.name), dst)
      log(`✓ 技能包 ${name.name}：${r.copied} 文件（跳过 ${r.skipped} 个缓存项）`)
    }
  } else {
    log('! AppData 没有 skills/')
  }

  // 3) 成片文档（可选）：复制以便复用已冻结的分镜/参数
  const pdSrc = path.join(APP_DATA, 'productions')
  if (existsSync(pdSrc)) {
    let n = 0
    for (const f of readdirSync(pdSrc)) {
      if (!f.endsWith('.json')) continue
      const dst = path.join(CTL_DATA, 'productions', f)
      if (!existsSync(dst)) { cpSync(path.join(pdSrc, f), dst); n++ }
    }
    if (n) log(`✓ 成片文档 ${n} 份`)
  }

  // 4) 已生成素材：设计里的 cut 图按文件名引用，缺了会触发重新生图（要花钱）
  const aoSrc = path.join(APP_DATA, 'ai-generated')
  if (existsSync(aoSrc)) {
    let n = 0, busy = 0
    for (const f of readdirSync(aoSrc)) {
      const s = path.join(aoSrc, f)
      try {
        if (!statSync(s).isFile()) continue
        const dst = path.join(CTL_DATA, 'ai-generated', f)
        if (existsSync(dst)) continue
        cpSync(s, dst)
        n++
      } catch (e) {
        // 应用正在用某个素材时会被占用；少复制一个不该让 setup 失败
        if (++busy <= 3) log(`  ! 跳过占用素材 ${f}（${e.code || e.message}）`)
      }
    }
    log(`✓ 已生成素材 ${n} 个（避免重复付费生图${busy ? `，${busy} 个被占用已跳过` : ''}）`)
  }

  log(`\n控制数据目录：${CTL_DATA}`)
  log('下一步：node scripts/todo-ctl.mjs start')
}

async function start() {
  if (existsSync(PID_FILE)) {
    const old = Number(readFileSync(PID_FILE, 'utf8'))
    try { process.kill(old, 0); log(`· 已在运行 pid=${old} port=${port()}`); return } catch { /* 已死 */ }
  }
  setup()
  mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  // ⚠️ env 里给键赋 undefined ≠ 删除：Node 会当作"未设置"从而**继承父进程**的值。
  // 某些 agent 会话会注入 ELECTRON_RUN_AS_NODE=1，必须显式 delete 才不会污染子进程。
  const env = { ...process.env, TODO_DATA_DIR: CTL_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = openSync(LOG_FILE, 'a')
  const out = spawn(process.execPath, [path.join(ROOT, 'server', 'aiServer.mjs'), '--port', String(port())], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  out.unref()
  closeSync(logFd)
  writeFileSync(PID_FILE, String(out.pid))
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try { await api('/api/ai-productions'); log(`✓ 控制服务已就绪 pid=${out.pid} http://127.0.0.1:${port()}`); return } catch { /* 等 */ }
  }
  let tail = ''
  try { tail = readFileSync(LOG_FILE, 'utf8').slice(-500) } catch { /* 无日志 */ }
  rmSync(PID_FILE, { force: true })
  throw new Error(`服务 15s 内未就绪。${tail ? `日志尾部：\n${tail}` : '看 .data-ctl/server.log'}`)
}

function stop() {
  if (!existsSync(PID_FILE)) { log('· 没有记录在跑的实例'); return }
  const pid = Number(readFileSync(PID_FILE, 'utf8'))
  try { process.kill(pid); log(`✓ 已停止 pid=${pid}`) } catch { log(`· pid=${pid} 已不在`) }
  rmSync(PID_FILE, { force: true })
}

async function status() {
  try {
    const r = await api('/api/ai-productions')
    log(`✓ 控制服务在线 http://127.0.0.1:${port()}  成片 ${r.items.length} 份`)
    for (const it of r.items.slice(0, 10)) {
      log(`  ${it.id}  ${it.status?.phase ?? '-'}  running=${it.status?.running ?? false}  ${String(it.title || '').slice(0, 20)}`)
    }
  } catch (e) {
    log(`× 服务不可达：${String(e.message).slice(0, 160)}`)
    log('  先跑：node scripts/todo-ctl.mjs start')
  }
}

async function list() {
  const r = await api('/api/ai-productions')
  for (const it of r.items) log(`${it.id}\t${it.status?.phase ?? '-'}\t${it.title ?? ''}`)
  const jobs = await api('/api/ai-jobs?limit=15').catch(() => null)
  if (jobs?.items?.length) {
    log('\n最近任务：')
    for (const j of jobs.items) log(`  ${j.id}\t${j.status}\t${j.phase ?? ''}\t${String(j.error ?? '').slice(0, 80)}`)
  }
}

async function newProduction() {
  const sf = flag('script-file')
  if (!sf) throw new Error('需要 --script-file <txt>')
  const script = readFileSync(path.resolve(String(sf)), 'utf8')
  const skillId = String(flag('skill', 'studio.spongebob-koubo'))
  const params = flag('params-json') ? JSON.parse(readFileSync(path.resolve(String(flag('params-json'))), 'utf8')) : undefined
  const r = await api('/api/ai-productions', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ skillId, script, params, run: false }),
  })
  log(`✓ 已新建：${r.production.id}`)
  log(r.production.id)
}

async function runProduction() {
  const id = positional[0]
  if (!id) throw new Error('需要 <productionId>')
  const force = argv.includes('--force')
  const body = force ? { force: true } : {}
  const r = await api(`/api/ai-productions/${id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })
  log(`✓ 已排队 job=${r.job.id}${force ? '（force 真跑）' : ''}`)
  let last = ''
  for (let i = 0; i < 400; i++) {
    await new Promise((res) => setTimeout(res, 3000))
    let p
    try { p = await api(`/api/ai-productions/${id}`) } catch (e) { log(`  轮询失败：${e.message}`); continue }
    const s = p.production.status || {}
    const line = `[${(i + 1) * 3}s] running=${s.running} phase=${s.phase} pct=${s.pct}`
    if (line !== last) { log(line); last = line }
    if (!s.running && (s.phase === '完成' || s.error || (s.failed || []).length)) {
      log(`\n结束：phase=${s.phase} error=${s.error || '-'} failed=${(s.failed || []).length}`)
      for (const f of (s.failed || []).slice(0, 5)) log(`  × ${f.layer} ${f.label}：${String(f.error).slice(0, 160)}`)
      process.exitCode = s.phase === '完成' ? 0 : 1
      return
    }
  }
  log('× 轮询超时')
  process.exitCode = 1
}

async function verify() {
  const id = positional[0]
  if (!id) throw new Error('需要 <productionId>')
  const view = await api(`/api/ai-productions/${id}`)
  const doc = view.production
  const els = doc.segments.flatMap((s) => s.boards.flatMap((b) => b.render?.result?.elements || []))
  const sfx = els.filter((e) => e.sfx)
  const problems = []
  log(`成片 ${doc.id}  段=${doc.segments.length}  元素=${els.length}`)
  log(`状态：${doc.status?.phase}  running=${doc.status?.running}  failed=${(doc.status?.failed || []).length}`)
  if (doc.status?.error) problems.push(`status.error=${doc.status.error}`)
  // 1) 每个元素的 video/hold/sfx 都必须是宿主 URL
  for (const e of els) {
    for (const k of ['video', 'hold', 'sfx']) {
      const v = e[k]
      if (v == null) continue
      if (!String(v).startsWith('/ai-generated/')) problems.push(`${e.id}.${k} 不是宿主 URL：${v}`)
    }
  }
  log(`音效元素：${sfx.length}`)
  for (const e of sfx) log(`  ${e.id} ${e.label} → ${e.sfx}`)
  // 2) 产物文件真实存在 + 音效是真音频
  const outDir = path.join(CTL_DATA, 'ai-generated')
  const { execFileSync } = await import('node:child_process')
  for (const e of sfx) {
    const f = path.join(outDir, path.basename(e.sfx))
    if (!existsSync(f)) { problems.push(`音效文件缺失：${f}`); continue }
    try {
      const probe = execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,duration', '-of', 'default=nw=1', f], { encoding: 'utf8' })
      log(`  探测 ${path.basename(f)}：${probe.trim().replace(/\n/g, ' ')}`)
      if (/\.mp4$/i.test(e.sfx)) problems.push(`音效指向视频：${e.sfx}`)
    } catch (err) { problems.push(`ffprobe 失败：${String(err.message).slice(0, 120)}`) }
  }
  for (const e of els) {
    if (!existsSync(path.join(outDir, path.basename(String(e.video))))) problems.push(`层视频缺失：${e.video}`)
    if (!existsSync(path.join(outDir, path.basename(String(e.hold))))) problems.push(`hold 缺失：${e.hold}`)
  }
  log(`\n${problems.length ? '× 发现 ' + problems.length + ' 个问题' : '✓ 产物校验通过'}`)
  for (const p of problems.slice(0, 20)) log(`  - ${p}`)
  process.exitCode = problems.length ? 1 : 0
}

const table = { setup, start, stop, status, list, run: runProduction, new: newProduction, verify }
const fn = table[cmd]
if (!fn) {
  console.error(`未知命令 ${cmd}\n可用：${Object.keys(table).join(' / ')}`)
  process.exit(2)
}
await fn()
