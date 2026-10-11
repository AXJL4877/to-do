/**
 * 工程存储测试（node:test）：写锁 / 环形备份 / 恢复日志 / 崩溃恢复。
 *
 * 这些用例把「备份靠人记着」变成「机制保证」：
 *   - 两个进程不能同时写同一个工程（第二个拿到 conflict，而不是静默覆盖）
 *   - 崩溃残留的锁能被接管（否则崩一次就再也打不开）
 *   - 崩溃丢失的编辑能靠**重放命令**找回，且每步用文档哈希校验
 *   - 环形备份只保留最近 N 份
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  DEFAULT_SNAPSHOT_LIMIT, ProjectStore, acquireLock, docHash, listSnapshots, readJournal, releaseLock, replayJournal, writeProjectWithSnapshots,
} from './projectStore.mjs'
import { validateProject } from '../spec/projectSpec.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const fixture = path.join(here, '..', 'spec', '__fixtures__', 'minimal.todo.json')
const tmpProject = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'todo-store-'))
  const file = path.join(dir, 'proj.todo.json')
  writeFileSync(file, readFileSync(fixture))
  return file
}
let n = 0
const ids = () => { n += 1; return `sid_${n}` }

test('docHash：稳定且对内容敏感', () => {
  const a = { x: 1, y: [1, 2] }
  assert.equal(docHash(a), docHash({ x: 1, y: [1, 2] }))
  assert.notEqual(docHash(a), docHash({ x: 1, y: [1, 3] }))
})

test('写锁：同一文件第二次获取 → conflict，并报出持有者 pid', async () => {
  const file = tmpProject()
  // 必须用**活着的** pid：死 pid 会被正确判为陈旧锁而接管，那样测不到冲突路径
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  try {
    const first = acquireLock(file, { pid: child.pid })
    assert.equal(first.ok, true)
    const second = acquireLock(file, { pid: process.pid })
    assert.equal(second.ok, false, '活着的持有者必须挡住第二次获取')
    assert.equal(second.error.code, 'conflict')
    assert.match(second.error.message, new RegExp(String(child.pid)))
    assert.ok(second.error.hint, '要告诉人怎么处理')
  } finally {
    child.kill()
    releaseLock(file)
  }
})

test('写锁：持有者已死 → 接管（陈旧锁不能把人挡在门外）', () => {
  const file = tmpProject()
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: new Date().toISOString() }))
  const r = acquireLock(file, { pid: process.pid })
  assert.equal(r.ok, true)
  assert.equal(r.tookOver, true)
  releaseLock(file)
})

test('写锁：进程自己重复获取视为可重入（pid 相同）', () => {
  const file = tmpProject()
  assert.equal(acquireLock(file, { pid: 777 }).ok, true)
  assert.equal(acquireLock(file, { pid: 777 }).ok, true, '同一 pid 不应自锁')
  releaseLock(file)
})

test('ProjectStore.open：读入 + 报告锁与日志状态', () => {
  const file = tmpProject()
  const r = ProjectStore.open(file)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.from, 2)
  assert.equal(r.lock.locked, true)
  assert.equal(r.journal.crashed, false)
  assert.equal(r.store.session.summary().sequences[0].clips, 4)
  r.store.close()
})

test('ProjectStore.open：另一个进程持锁时拒绝打开', async () => {
  const file = tmpProject()
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  try {
    assert.equal(acquireLock(file, { pid: child.pid }).ok, true)
    const r = ProjectStore.open(file)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'conflict')
  } finally {
    child.kill()
    releaseLock(file)
  }
})

test('exec 追加恢复日志；save 清空日志并留环形备份', () => {
  const file = tmpProject()
  const o = ProjectStore.open(file, { newId: ids })
  const s = o.store
  s.exec('marker.add', { t: 1, label: 'a' })
  s.exec('marker.add', { t: 2, label: 'b' })
  assert.equal(readJournal(file).entries.length, 2, '未保存的编辑必须留在日志里')
  const w = s.save()
  assert.equal(w.ok, true, JSON.stringify(w.error))
  assert.equal(readJournal(file).entries.length, 0, '保存后日志清空')
  assert.ok(w.snapshot?.name, '要留一份环形备份')
  assert.ok(listSnapshots(file).some((x) => x.name === w.snapshot.name))
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.sequences[0].markers.filter((m) => m.label === 'a' || m.label === 'b').length, 2)
  const hist = readdirSync(path.join(path.dirname(file), '.history'))
  assert.equal(hist.length, 1)
  s.close()
})

test('环形备份：只保留最近 N 份', () => {
  const file = tmpProject()
  const o = ProjectStore.open(file, { newId: ids(), snapshotLimit: 3 })
  const s = o.store
  for (let i = 0; i < 5; i += 1) {
    s.exec('marker.add', { t: i + 1, label: `m${i}` })
    // 时间戳精度到秒，手工错开文件名避免同名覆盖
    const w = s.save()
    assert.equal(w.ok, true)
  }
  const snaps = listSnapshots(file, { limit: 99 })
  assert.ok(snaps.length <= 3, `环形上限 3，实际 ${snaps.length}`)
  s.close()
})

test('崩溃恢复：靠重放命令找回未保存的编辑（并用哈希逐步校验）', () => {
  const file = tmpProject()
  const first = ProjectStore.open(file, { newId: ids })
  first.store.close({ save: true })

  // 模拟一次崩溃：执行了 3 条命令但没走 save 就"断电"
  const crashed = ProjectStore.open(file, { newId: () => 'recovered_1' })
  crashed.store.exec('timeline.add_clip', { trackId: 'tr_v1', mediaId: 'm_v1', start: 30, duration: 2 })
  crashed.store.exec('marker.add', { t: 31, label: '崩溃前' })
  crashed.store.exec('timeline.trim_clip', { clipId: 'cl_v1', edge: 'out', deltaSeconds: 1 })
  const expected = crashed.store.session.summary()
  // 不 save、不释放锁 —— 相当于进程被杀
  const journalLines = readJournal(file).entries.length
  assert.equal(journalLines, 3)

  // 重新打开（陈旧锁会被接管）
  const reopened = ProjectStore.open(file, { newId: () => 'recovered_1' })
  assert.equal(reopened.ok, true, JSON.stringify(reopened.error))
  assert.equal(reopened.journal.crashed, true)
  const plan = reopened.store.recoveryPlan()
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.entries, 3)
  assert.deepEqual(plan.replayed, ['timeline.add_clip', 'marker.add', 'timeline.trim_clip'])
  assert.equal(plan.recoveredValid, true, '恢复出来的文档必须合规')
  const applied = reopened.store.applyRecovery()
  assert.equal(applied.ok, true, JSON.stringify(applied.error))
  assert.equal(applied.applied, 3)
  assert.deepEqual(reopened.store.session.summary(), expected, '恢复后应与崩溃前的状态一致')
  reopened.store.close()
})

test('崩溃恢复：日志与文档对不上时，如实停下并说明停在哪一步', () => {
  const file = tmpProject()
  const o = ProjectStore.open(file, { newId: ids })
  o.store.exec('marker.add', { t: 1, label: 'x' })
  o.store.close()
  // 手工把日志第一条的 hashBefore 改坏 → 模拟日志与文档不匹配
  const jp = `${file}.journal.jsonl`
  const lines = readFileSync(jp, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  lines[0].hashBefore = 'deadbeef'
  writeFileSync(jp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  const reopened = ProjectStore.open(file, { newId: ids })
  const plan = reopened.store.recoveryPlan()
  assert.equal(plan.ok, false)
  assert.equal(plan.stoppedAt, 0)
  assert.match(plan.reason, /不符/)
  assert.equal(plan.note.includes('无法确定'), true, '要如实说明而不是假装成功')
  const applied = reopened.store.applyRecovery()
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'conflict')
  reopened.store.close()
})

test('replayJournal：命令重放失败时给出是哪一条', () => {
  const doc = JSON.parse(readFileSync(fixture, 'utf8'))
  const r = replayJournal(doc, [{ id: 'timeline.split_clip', args: { clipId: 'cl_v1', at: 999 }, hashBefore: docHash(doc) }], { newId: ids })
  assert.equal(r.ok, false)
  assert.equal(r.stoppedAt, 0)
  assert.match(r.reason, /重放失败/)
})

test('close({save:true})：脏才写盘，然后释放锁', () => {
  const file = tmpProject()
  const o = ProjectStore.open(file, { newId: ids })
  o.store.exec('marker.add', { t: 9, label: 'close-save' })
  const c = o.store.close({ save: true })
  assert.equal(c.ok, true)
  assert.ok(c.saved?.path, '脏了就应该写盘')
  assert.equal(existsSync(`${file}.lock`), false, '关掉就要放锁')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(onDisk.sequences[0].markers.some((m) => m.label === 'close-save'))
})

test('默认环形上限是 20（filmcraft 同值）', () => {
  assert.equal(DEFAULT_SNAPSHOT_LIMIT, 20)
})

test('保存后的工程仍然通过规范校验', () => {
  const file = tmpProject()
  const o = ProjectStore.open(file, { newId: ids })
  o.store.exec('timeline.add_clip', { trackId: 'tr_a1', mediaId: 'm_a1', start: 12, duration: 3 })
  o.store.save()
  o.store.close()
  const report = validateProject(JSON.parse(readFileSync(file, 'utf8')))
  assert.equal(report.ok, true, JSON.stringify(report.errors))
})

test('writeProjectWithSnapshots（主进程用的 JSON→JSON 写入）：原子写 + .bak + 环形备份 + 清日志', () => {
  const file = tmpProject()
  // 先制造一条未清空的恢复日志，验证写入会清掉它
  writeFileSync(`${file}.journal.jsonl`, `${JSON.stringify({ seq: 1, id: 'marker.add', args: {} })}\n`)
  const doc = JSON.parse(readFileSync(fixture, 'utf8'))
  doc.sequences[0].markers = [{ id: 'mk_w', t: 2, label: 'writer', color: '#ffcc00' }]
  const r = writeProjectWithSnapshots(file, doc, { snapshotLimit: 4 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.ok(r.snapshot?.name, '要留环形备份')
  assert.equal(existsSync(`${file}.bak`), true)
  assert.equal(existsSync(`${file}.journal.jsonl`), false, '保存后恢复日志必须清空')
  assert.equal(existsSync(`${file}.tmp`), false, '临时文件不能留下')
  const back = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(back.sequences[0].markers[0].label, 'writer')
  assert.equal(validateProject(back).ok, true)
})

test('writeProjectWithSnapshots：不可写路径 → permission 而非抛异常', () => {
  const r = writeProjectWithSnapshots('Z:\\绝对不存在的盘\\x.todo.json', { version: 2 })
  assert.equal(r.ok, false)
  assert.ok(['permission', 'internal'].includes(r.error.code), r.error.code)
  assert.ok(r.error.hint, '要给人话提示')
})