import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  stdin: {
    contents: `export * from './src/lib/scriptMemoDocument'; export * from './src/lib/scriptWorkspace'; export * from './src/lib/scriptStageApply'`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

assert.equal(m.initialMemo('工资怎么存', '测试工程'), '')
let ws = m.startWorkspace('standard', '工资怎么存')
ws = m.applyFormConfirm(ws, {
  stage: 'A',
  question_for_user: 'q',
  card_type: 'form',
  options: [
    { id: 'platform', key: 'platform', suggested: '抖音' },
    { id: 'duration_sec', key: 'duration_sec', suggested: 90 },
    { id: 'audience', key: 'audience', suggested: '职场新人' },
    { id: 'persona', key: 'persona', suggested: '朋友' },
    { id: 'goal', key: 'goal', suggested: '涨粉' },
    { id: 'taboo', key: 'taboo', suggested: [] },
  ],
  allow_custom: true,
}, ['platform', 'duration_sec', 'audience', 'persona', 'goal', 'taboo'])
const body = m.buildMemoFromWorkspace(ws, '已经写好的正文。')
assert.equal(body, '已经写好的正文。')
assert.doesNotMatch(body, /【项目】/)
const brief = m.buildCreativeBrief(ws, body)
assert.match(brief, /抖音/)
assert.match(brief, /已经写好的正文/)

const plain = '普通稿\n---\n不要把这条横线当成正文结尾。'
const migrated = m.migrateScriptDocument(plain, null, null)
assert.equal(migrated.script, plain)
assert.equal(migrated.memo.schema, 2)
const again = m.migrateScriptDocument(migrated.script, migrated.memo, migrated.workspace)
assert.equal(again.script, plain)

const legacy = '# 项目\n--- 口播正文 ---\n\n只朗读这段。\n\n--- 发布 ---\n标题：不要朗读'
const moved = m.migrateScriptDocument(legacy, null, null)
assert.equal(moved.script, '只朗读这段。')
assert.equal(moved.memo.legacy_raw, legacy)
assert.equal(moved.memo.publish.titles[0], '不要朗读')
const reopened = m.migrateScriptDocument('只朗读这段。\n--- 口播正文 ---\n被误截断', moved.memo, moved.workspace)
assert.match(reopened.script, /被误截断/)

const cleared = m.buildMemoFromWorkspace({ ...ws, draft: [{ id: 'p1', versions: [{ v: 1, stage: 'manual', text: '' }], current: 1 }] }, '旧正文')
assert.equal(cleared, '')

const nodes = []
for (let i = 0; i < 55; i++) nodes.push({ id: `a${i}`, parent_id: null, stage: 'A', substep: 'A.form', action: 'auto', ts: i + 1, named: false, snapshot: { script: `v${i}` } })
nodes.push({ id: 'named', parent_id: null, stage: 'F', substep: 'F.package', action: '命名版本', ts: 1000, named: true, snapshot: { script: '保留' } })
const kept = m.retainHistory(nodes)
assert.equal(kept.filter((n) => n.named).length, 1)
assert.ok(kept.filter((n) => !n.named).length <= 50)
assert.ok(kept.some((n) => n.id === 'named'))
const parsed = m.parseWorkspace({ ...m.emptyWorkspace(), history: kept })
assert.ok(parsed.history.some((n) => n.named && n.snapshot.script === '保留'))

const chainWs = m.startWorkspace('chain', '工资怎么存')
assert.equal(chainWs.mode, 'chain')
assert.equal(chainWs.chain_step, 'theme')
assert.equal(chainWs.current_card, null)
const chainSpoken = m.composeChainBody([{
  id: 'c1', role: '开场', key_point: '先讲误区。', target_chars: 40, material_ids: [],
  inserts: [
    { id: 'a', kind: 'data', text: '余额宝一年大约两百块。' },
    { id: 'b', kind: 'story', text: '同事发了工资就全买了基金。' },
    { id: 'c', kind: 'interaction', text: '你的第一份工资花哪了？' },
  ],
}])
assert.equal(chainSpoken, '先讲误区。\n\n余额宝一年大约两百块。\n\n同事发了工资就全买了基金。\n\n你的第一份工资花哪了？')
assert.doesNotMatch(chainSpoken, /数据例子|【/)
const chainParsed = m.parseWorkspace({ ...chainWs, track: '财经赛道', chain_step: 'weave' })
assert.equal(chainParsed.mode, 'chain')
assert.equal(chainParsed.track, '财经赛道')
assert.equal(chainParsed.chain_step, 'weave')

console.log('script-memo-doc-selfcheck: ok')
