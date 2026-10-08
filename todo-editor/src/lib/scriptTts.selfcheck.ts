import assert from 'node:assert/strict'
import { emptyScriptMemo } from './scriptMemoDocument'
import { prepareSpokenTts } from './scriptTts'

const mizai = { voice: 'mizai' as const, cloneId: '' }

const plain = prepareSpokenTts('复利靠的是时间。\n越早开始，越轻松。', emptyScriptMemo(), mizai)
assert.equal(plain.ok, true)
if (plain.ok) {
  assert.equal(plain.prompt, '复利靠的是时间。\n越早开始，越轻松。')
  assert.deepEqual(plain.params, { voice: 'mizai', cloneId: '' })
}

const marked = prepareSpokenTts('这一句要读 [m12]。', emptyScriptMemo(), mizai)
assert.equal(marked.ok && marked.prompt, '这一句要读。')

const legacy = prepareSpokenTts(
  '项目说明不要读\n--- 口播正文 ---\n真正要读的话。\n--- 发布 ---\n标题：不要读这个标题',
  null,
  mizai,
)
assert.equal(legacy.ok && legacy.prompt, '真正要读的话。')

const publishKeptOut = prepareSpokenTts('只读正文。', emptyScriptMemo({
  publish: { titles: ['不要读标题'], cover_texts: ['封面字'], description: '简介', hashtags: ['#标签'] },
}), mizai)
assert.equal(publishKeptOut.ok && publishKeptOut.prompt, '只读正文。')

assert.equal(prepareSpokenTts('   \n  ', emptyScriptMemo(), mizai).ok, false)
assert.equal(prepareSpokenTts('……！！', emptyScriptMemo(), mizai).ok, false)
assert.equal(prepareSpokenTts('甲'.repeat(5001), emptyScriptMemo(), mizai).ok, false)
assert.equal(prepareSpokenTts('甲'.repeat(5000), emptyScriptMemo(), mizai).ok, true)

const badClone = prepareSpokenTts('要读。', emptyScriptMemo(), { voice: 'clone', cloneId: 'not-a-voice' })
assert.equal(badClone.ok, false)
const clone = prepareSpokenTts('要读。', emptyScriptMemo(), { voice: 'clone', cloneId: '  S_abc  ' })
assert.equal(clone.ok, true)
if (clone.ok) assert.deepEqual(clone.params, { voice: 'clone', cloneId: 'S_abc' })

const ignoresClone = prepareSpokenTts('要读。', emptyScriptMemo(), { voice: 'mizai', cloneId: 'bad' })
assert.equal(ignoresClone.ok, true)
if (ignoresClone.ok) assert.equal(ignoresClone.params.voice, 'mizai')

console.log('scriptTts.selfcheck ok')
