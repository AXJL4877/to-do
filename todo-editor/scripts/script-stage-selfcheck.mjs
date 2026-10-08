/**
 * 口播阶段状态机自检（不调 LLM）
 */
import assert from 'node:assert/strict'
import {
  draftFullText,
  emptyWorkspace,
  nextSubstepAfterConfirm,
  startWorkspace,
  targetChars,
} from '../src/lib/scriptWorkspace.ts'
import {
  applyExpandConfirm,
  applyFormConfirm,
  applyHookConfirm,
  applyOutlineConfirm,
  applyTopicConfirm,
} from '../src/lib/scriptStageApply.ts'

assert.equal(targetChars(90), 405)

const a = startWorkspace('standard', '讲工资怎么存')
assert.equal(a.active, true)
assert.equal(a.substep, 'A.form')

const formCard = {
  stage: 'A',
  question_for_user: '确认项目卡',
  card_type: 'form',
  options: [
    { id: 'platform', key: 'platform', suggested: '抖音', title: '平台' },
    { id: 'duration_sec', key: 'duration_sec', suggested: 90, title: '时长' },
    { id: 'audience', key: 'audience', suggested: '职场新人', title: '受众' },
    { id: 'persona', key: 'persona', suggested: '朋友型', title: '人设' },
    { id: 'goal', key: 'goal', suggested: '涨粉', title: '目标' },
    { id: 'taboo', key: 'taboo', suggested: ['不荐股'], title: '禁区' },
  ],
  target_chars: 405,
  allow_custom: true,
}
const afterA = applyFormConfirm(a, formCard, formCard.options.map((o) => o.id))
assert.equal(afterA.stage, 'B')
assert.equal(afterA.project_card?.platform, '抖音')
assert.equal(afterA.project_card?.target_chars, 405)

const afterB = applyTopicConfirm(afterA, {
  id: 'A',
  title: '第一份工资别乱花',
  content: '先建应急金再谈投资',
  tags: ['痛点'],
})
assert.equal(afterB.stage, 'C')
assert.equal(afterB.topic?.title, '第一份工资别乱花')

let ws = {
  ...afterB,
  material_bank: [{ id: 'm1', type: 'data', content: '应急金建议3-6个月', source: '用户', credibility: 'mid', verified: true }],
  hook: null,
  logic_line: null,
  outline: [],
  draft: [],
  substep: 'D.hook',
  stage: 'D',
}
ws = applyHookConfirm(ws, { id: 'A', title: '痛点直击', content: '发了工资三天就花光？' })
assert.equal(ws.substep, 'D.logic')

ws = {
  ...ws,
  logic_line: { claim: '先存再花', next_questions: [{ id: 'q1', text: '存多少' }], nails: [] },
  substep: 'D.outline',
}
ws = applyOutlineConfirm(ws, {
  id: 'A',
  title: '方案1',
  content: [
    { id: 'p1', role: '钩子', key_point: '痛点', target_chars: 60, material_ids: [] },
    { id: 'p2', role: '主张', key_point: '先存', target_chars: 100, material_ids: ['m1'] },
  ],
})
assert.equal(ws.substep, 'E.expand')
assert.equal(ws.outline.length, 2)

ws = applyExpandConfirm(ws, { id: 'A', title: '先结论', content: '发工资别先剁手。[m1]' })
assert.equal(ws.expand_index, 1)
assert.match(draftFullText(ws), /发工资别先剁手/)
assert.doesNotMatch(draftFullText(ws), /\[m1\]/)

const fast = startWorkspace('fast', 'x')
assert.deepEqual(nextSubstepAfterConfirm({ ...fast, substep: 'B.topics', stage: 'B' }), {
  stage: 'C',
  substep: 'C.materials',
})

const polish = startWorkspace('polish_only', '', '已有一段口播正文在这里。')
assert.equal(polish.stage, 'E')
assert.equal(polish.substep, 'E.polish')
assert.ok(polish.draft.length)

console.log('script-stage-selfcheck: ok')
