/**
 * CJS↔ESM 桥的冒烟测试（node:test 跑不了 CJS 里的动态 import 场景，这里用真进程验证）。
 * 用法: node electron/projectCore.smoke.cjs
 *
 * 验的是「主进程接上核心层」这件事本身：
 *   保存 → 有 .bak、有环形备份、恢复日志被清空
 *   打开 → 取到锁，且磁盘上真的存在 .lock
 *   冲突 → 别的进程持锁时，保存应报 conflict 而不是覆盖
 *   退出 → 释放锁
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const core = require('./projectCore.cjs')

const FIXTURE = path.join(__dirname, '..', 'server', 'spec', '__fixtures__', 'minimal.todo.json')

async function main() {
  const out = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-bridge-'))
  const file = path.join(dir, 'bridge.todo.json')
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  fs.writeFileSync(file, JSON.stringify(doc))

  const st0 = await core.status()
  assert.equal(st0.coreAvailable, true, `核心层必须可用：${st0.degraded}`)
  out.push(`status → coreAvailable=${st0.coreAvailable} lockedFile=${st0.lockedFile}`)

  // 1) 打开：取锁 + 报告崩溃残留
  const opened = await core.inspectOpen(file)
  assert.equal(opened.ok, true, JSON.stringify(opened.error))
  assert.equal(fs.existsSync(`${file}.lock`), true, '打开后磁盘上应有 .lock')
  assert.equal(opened.journal.crashed, false, '干净打开不应报崩溃残留')
  out.push(`inspectOpen → 锁已取（tookOver=${opened.lock.tookOver}）日志 entries=${opened.journal.entries} 备份 ${opened.snapshots} 份`)

  // 2) 保存：环形备份 + .bak + 清日志
  doc.sequences[0].markers = [...(doc.sequences[0].markers ?? []), { id: 'mk_bridge', t: 7, label: '桥测试', color: '#ffcc00' }]
  const saved = await core.saveProject(file, doc, { snapshotLimit: 5 })
  assert.equal(saved.ok, true, JSON.stringify(saved.error))
  assert.ok(saved.snapshot?.name, '应留下环形备份')
  assert.equal(fs.existsSync(`${file}.bak`), true, '应留 .bak')
  assert.equal(fs.existsSync(`${file}.journal.jsonl`), false, '保存后恢复日志应被清空')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(onDisk.sequences[0].markers.some((m) => m.label === '桥测试'), '内容应落盘')
  assert.equal(fs.existsSync(path.join(dir, '.history', saved.snapshot.name)), true, '备份应在 .history 下')
  out.push(`saveProject → ${(saved.bytes / 1024).toFixed(1)}KB 备份 ${saved.snapshot.name} .bak=true journalCleared=true`)

  // 3) 崩溃残留：直接写一条日志（模拟上次没保存成功）
  fs.writeFileSync(`${file}.journal.jsonl`, `${JSON.stringify({ seq: 1, at: new Date().toISOString(), id: 'marker.add', args: { t: 9, label: 'crash' }, hashBefore: null })}\n`)
  const plan = await core.recoveryPlan(file)
  assert.equal(plan.ok, true, JSON.stringify(plan.error))
  assert.equal(plan.plan.crashed, true)
  assert.deepEqual(plan.plan.replayed, ['marker.add'])
  out.push(`recoveryPlan → crashed=${plan.plan.crashed} 可重放=${JSON.stringify(plan.plan.replayed)} 备份 ${plan.snapshots.length} 份`)

  // 4) 冲突：另一个"进程"持锁（伪造一个活 pid：拿自己当占用者再换个文件路径验证）
  const other = path.join(dir, 'other.todo.json')
  fs.writeFileSync(other, JSON.stringify(doc))
  const proc = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  fs.writeFileSync(`${other}.lock`, JSON.stringify({ pid: proc.pid, at: new Date().toISOString() }))
  const conflict = await core.saveProject(other, doc)
  proc.kill()
  assert.equal(conflict.ok, false, '别的进程持锁时必须拒绝')
  assert.equal(conflict.error.code, 'conflict')
  out.push(`saveProject（被他人占用）→ ${conflict.error.code}：${conflict.error.message}`)

  // 5) 释放锁
  const rel = await core.releaseCurrentLock()
  assert.equal(fs.existsSync(`${file}.lock`), false, '退出后锁应释放')
  out.push(`releaseCurrentLock → released=${path.basename(rel.released ?? '')} .lock 已删除`)

  console.log('主进程 ↔ 核心层 桥冒烟通过：')
  for (const r of out) console.log('  ✔ ' + r)
}

main().catch((e) => {
  console.error('桥冒烟失败:', e.message)
  process.exit(1)
})
