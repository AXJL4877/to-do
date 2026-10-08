import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ stdin: { contents: `export * from './src/lib/scriptMemoDocument'; export * from './src/lib/scriptWorkspace'`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' })
const m = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const old = '# 项目\n【素材】\n材料\n--- 口播正文 ---\n\n只朗读这段。\n\n--- 发布 ---\n标题：不要朗读'
assert.equal(m.extractMemoBody(old), '只朗读这段。', 'publication metadata leaked into body')
assert.equal(m.spokenScript('普通的口播稿。'), '普通的口播稿。')
assert.equal(m.spokenScript(old), '只朗读这段。')
let ws = m.startWorkspace('polish_only', '', '第一段。\n\n第二行。')
ws = { ...ws, outline: [{ id: 'p1', role: '开头', key_point: '', target_chars: 20, material_ids: [], locked: false }, { id: 'p2', role: '结尾', key_point: '', target_chars: 20, material_ids: [], locked: false }], draft: [...ws.draft, { id: 'p2', current: 1, versions: [{ v: 1, stage: 'filled', text: '结尾。' }] }] }
const changed = m.syncDraftBody(ws, '第一段。\n\n改过的第二行。\n\n结尾。')
assert.equal(m.draftFullText(changed), '第一段。\n\n改过的第二行。\n\n结尾。')
assert.equal(changed.draft[1], ws.draft[1], 'unaffected segment must retain identity')
assert.equal(changed.draft[0].versions[0].text, '第一段。\n\n第二行。')
const again = m.syncDraftBody(changed, '第一段。\n\n改过的第二行！\n\n结尾。')
assert.equal(again.draft[0].versions.length, changed.draft[0].versions.length, 'typing must not create one version per keystroke')
const before = m.draftFullText(ws)
for (let start = 0; start <= before.length; start++) {
  for (let end = start; end <= before.length; end++) {
    const text = before.slice(0, start) + '新增\n文字' + before.slice(end)
    assert.equal(m.draftFullText(m.syncDraftBody(ws, text)), text, `lost edit ${start}:${end}`)
  }
}
assert.equal(m.draftFullText(m.syncDraftBody(ws, '')), '', 'explicit deletion must not restore the old draft')
console.log('script body: migration, edits, version coalescing and all edit ranges passed')
