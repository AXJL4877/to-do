import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ScriptStageAskDock } from '../src/components/ScriptStageAskDock'
import { CreativeProgress } from '../src/components/CreativeProgress'
import { ScriptMemo } from '../src/components/ScriptMemo'
import { useApp } from '../src/store'
import { draftFullText, startWorkspace } from '../src/lib/scriptWorkspace'
import { AiFloatWindow } from '../src/components/AiFloat'
import { applyLogicConfirm, applyPolishConfirm } from '../src/lib/scriptStageApply'
import { setTtsWatchPollMs, stopAllTtsWatches } from '../src/lib/ttsJobWatch'

const results: { name: string; ok: boolean; error?: string }[] = []
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
const base = { stageLabel: '立项', substep: 'A.form' as const, card: null, selectedIds: [], customText: '', onToggle() {}, onCustom() {}, onConfirm() {}, onRegen() {} }
let chain = Promise.resolve()
function test(name: string, run: () => void | Promise<void>) {
  chain = chain.then(async () => {
    try { await run(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: String(e) }) }
  })
}
function check(value: unknown, text: string) { if (!value) throw new Error(text) }
test('initial failure has an enabled retry action', () => {
  flushSync(() => root.render(<ScriptStageAskDock {...base} error="网络中断" />))
  const retry = [...host.querySelectorAll('button')].find(b => /重试/.test(b.textContent || ''))
  check(retry && !retry.disabled, 'missing enabled retry')
})
test('form fields are editable instead of selectable recommendations', () => {
  flushSync(() => root.render(<ScriptStageAskDock {...base} card={{ stage: 'A', card_type: 'form', question_for_user: '确认设置', options: [{ id: 'duration_sec', key: 'duration_sec', title: '时长', suggested: 90 }] }} />))
  check(host.querySelector('input[type="number"]'), 'duration input missing')
})
test('long candidates retain their complete text', () => {
  const content = '这是候选正文。'.repeat(40) + '最后一句也需要阅读'
  flushSync(() => root.render(<ScriptStageAskDock {...base} card={{ stage: 'B', card_type: 'single_select', question_for_user: '选题', options: [{ id: 'one', title: '方向', content }] }} />))
  check(host.textContent?.includes('最后一句也需要阅读'), 'candidate text was discarded')
})
test('decision pane exposes an accessible resize handle', () => {
  check(host.querySelector('[role="separator"]'), 'resize handle missing')
})
test('polish review shows both versions and allows rejecting every suggestion', () => {
  flushSync(() => root.render(<ScriptStageAskDock {...base} substep="E.polish" card={{ stage: 'E', card_type: 'diff_review', question_for_user: '确认修改', options: [{ id: 'edit1', title: '更口语', before: '原来的句子', after: '建议的新句子' }] }} />))
  check(host.textContent?.includes('原来的句子') && host.textContent?.includes('建议的新句子'), 'review hides the actual changes')
  check(!(host.querySelector('[data-testid="script-card-confirm"]') as HTMLButtonElement).disabled, 'cannot reject all suggestions')
})
for (const theme of ['type', 'orbit', 'brush', 'wave', 'film', 'chalk'] as const) {
  test(`${theme} progress keeps label and percentage inside container`, () => {
    flushSync(() => root.render(<div style={{ width: 180 }}><CreativeProgress theme={theme} compact percent={47} label="正在生成封面，请等待完整的生成结果" /></div>))
    const box = host.querySelector('.cp')!.getBoundingClientRect()
    const label = host.querySelector('.cp-meta')!.getBoundingClientRect()
    check(label.bottom <= box.bottom + 1 && label.top >= box.top, 'progress label clipped by fixed-height theme container')
  })
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
test('polishing preserves multi-paragraph segments and previous versions', () => {
  const ws = startWorkspace('polish_only', '', '第一句。\n\n第二句。\n\n第三句。')
  ws.outline = [{ id: 'p1', role: '正文', key_point: '', target_chars: 100, material_ids: [], locked: false }]
  const card = { stage: 'E', card_type: 'diff_review' as const, question_for_user: '', options: [{ id: 'edit', before: '第一句。', after: '新的第一句。' }] }
  const next = applyPolishConfirm(ws, card, ['edit']).ws
  check(draftFullText(next) === '新的第一句。\n\n第二句。\n\n第三句。', 'polishing dropped paragraphs')
  check(next.draft[0].versions.length === 2, 'previous version discarded')
  const rejected = applyPolishConfirm(ws, card, []).ws
  check(draftFullText(rejected) === draftFullText(ws), 'rejecting all edits changed original text')
})
test('logic fields override AI suggestions while retaining material references', () => {
  const ws = startWorkspace('standard', '测试')
  ws.stage = 'D'; ws.substep = 'D.logic'
  const logic = { claim: '旧主张', next_questions: [{ id: 'q1', text: '旧问题' }], nails: [{ question_id: 'q1', material_ids: ['m1'], note: '旧说明' }] }
  const next = applyLogicConfirm(ws, { stage: 'D', card_type: 'form', question_for_user: '', options: [], fields: [
    { id: 'claim', suggested: '新主张' }, { id: 'q1', suggested: '新问题' }, { id: 'nail1', suggested: '新说明' },
  ] }, logic)
  check(next.logic_line?.claim === '新主张' && next.logic_line.next_questions[0].text === '新问题', 'edited logic fields ignored')
  check(next.logic_line?.nails[0].note === '新说明' && next.logic_line.nails[0].material_ids[0] === 'm1', 'material reference lost')
})
test('AI floating panel supports keyboard resizing within viewport', () => {
  const savedFetch = window.fetch
  window.fetch = () => new Promise(() => {})
  try {
    flushSync(() => root.render(<AiFloatWindow />))
    const panel = host.querySelector('[data-testid="ai-float"]')!
    const handle = host.querySelector('[aria-label="调整 AI 窗口大小"]')!
    check(handle, 'floating panel has no resize control')
    const before = panel.getBoundingClientRect()
    flushSync(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    const after = panel.getBoundingClientRect()
    check(after.width < before.width, 'keyboard resize did not change width')
    check(after.right <= innerWidth && after.bottom <= innerHeight, 'floating panel overflowed viewport')
  } finally { flushSync(() => root.render(null)); window.fetch = savedFetch }
})
test('editing duration changes the confirmed project settings', async () => {
  const savedFetch = window.fetch
  window.fetch = () => new Promise(() => {})
  const ws = startWorkspace('standard', '每天的口播')
  ws.current_card = { stage: 'A', card_type: 'form', question_for_user: '确认设置', options: [{ id: 'duration_sec', key: 'duration_sec', title: '时长', suggested: 90 }] }
  useApp.setState({ scriptWorkspace: ws, script: '正文', scriptOpen: true })
  try {
    flushSync(() => root.render(<ScriptMemo />))
    const input = host.querySelector('input[type="number"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '120')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (host.querySelector('[data-testid="script-card-confirm"]') as HTMLButtonElement).click())
    check(useApp.getState().scriptWorkspace?.project_card?.duration_sec === 120, 'edited duration was lost')
    check(useApp.getState().scriptWorkspace?.project_card?.target_chars === 540, 'target length was not updated')
  } finally { flushSync(() => root.render(null)); window.fetch = savedFetch }
})
test('exiting the wizard aborts its request and ignores late responses', async () => {
  const savedFetch = window.fetch
  let resolveRequest!: (value: Response) => void
  let signal: AbortSignal | undefined
  window.fetch = (_input, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { resolveRequest = resolve }) }
  useApp.setState({ scriptWorkspace: startWorkspace('standard', '测试'), script: '现有正文', scriptOpen: true })
  try {
    flushSync(() => root.render(<ScriptMemo />))
    await frame()
    check(signal, 'generation did not start')
    const exit = [...host.querySelectorAll('button')].find(b => b.textContent === '退出向导')!
    flushSync(() => exit.click())
    check(signal?.aborted, 'request not aborted')
    resolveRequest(new Response(JSON.stringify({ ok: true, card: { stage: 'A', card_type: 'form', options: [], question_for_user: '旧响应' } }), { status: 200 }))
    await frame()
    check(!useApp.getState().scriptWorkspace?.active && !useApp.getState().scriptWorkspace?.current_card, 'late response restored exited wizard')
  } finally { flushSync(() => root.render(null)); window.fetch = savedFetch }
})
test('spoken body is sent to the selected voice and placed on the timeline', async () => {
  const savedFetch = window.fetch
  let posted: { skillId?: string; prompt?: string; autoTimeline?: boolean; placement?: string; placeAt?: number; params?: { voice?: string; cloneId?: string } } | null = null
  window.fetch = (input, init) => {
    if (init?.body) posted = JSON.parse(String(init.body))
    return Promise.resolve(new Response(JSON.stringify({ ok: true, job: { id: 'job_tts_1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  localStorage.setItem('todo.tts.voice', JSON.stringify({ voice: 'mizai', cloneId: '' }))
  useApp.setState({
    scriptWorkspace: null,
    scriptMemo: null,
    script: '项目说明不要读\n--- 口播正文 ---\n复利靠的是时间。\n--- 发布 ---\n标题：不要朗读标题',
    scriptOpen: true,
    playhead: 3.5,
  })
  try {
    flushSync(() => root.render(<ScriptMemo />))
    const button = host.querySelector('[data-testid="script-tts-burn"]') as HTMLButtonElement
    check(button && !button.disabled, 'tts button missing or disabled')
    flushSync(() => button.click())
    await frame()
    check(posted?.skillId === 'builtin.tts-voice', 'did not call the tts skill')
    check(posted?.autoTimeline === true && posted?.placement === 'playhead' && posted?.placeAt === 3.5, 'voice was not aimed at the playhead')
    check(posted?.params?.voice === 'mizai', 'selected voice was not sent')
    check(posted?.prompt === '复利靠的是时间。', `non-spoken text leaked into tts: ${posted?.prompt}`)
    check(useApp.getState().voiceSeed?.text === '复利靠的是时间。', 'voice seed kept the publish block')
    const select = host.querySelector('[data-testid="script-tts-voice"]') as HTMLSelectElement
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'clone')
    flushSync(() => select.dispatchEvent(new Event('change', { bubbles: true })))
    check((host.querySelector('[data-testid="script-tts-burn"]') as HTMLButtonElement).disabled, 'clone voice without an id can still submit')
    const clone = host.querySelector('[data-testid="script-tts-clone"]') as HTMLInputElement
    check(clone, 'clone id field missing')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(clone, 'S_demo1')
    flushSync(() => clone.dispatchEvent(new Event('input', { bubbles: true })))
    check(!(host.querySelector('[data-testid="script-tts-burn"]') as HTMLButtonElement).disabled, 'valid clone id still blocked')
  } finally { stopAllTtsWatches(); flushSync(() => root.render(null)); window.fetch = savedFetch }
})
test('finished tts audio lands on the audio track at the playhead', async () => {
  const savedFetch = window.fetch
  setTtsWatchPollMs(15)
  const job = {
    id: 'job_tts_place',
    kind: 'skill',
    status: 'done',
    prompt: '复利靠的是时间。',
    resultUrl: '/ai-generated/job_tts_place_voice.wav',
    resultKind: 'audio',
    duration: 2.4,
    params: {
      autoTimeline: true,
      placement: 'playhead',
      placeAt: 1.25,
      skill: { name: '配音', pipeline: 'tts' },
      output: {
        spec: 'todo-skill-output/1',
        jobId: 'job_tts_place',
        prompt: '复利靠的是时间。',
        duration: 2.4,
        audio: '/ai-generated/job_tts_place_voice.wav',
        narration: {
          text: '复利靠的是时间。',
          duration: 2.4,
          speaker: 'zh_female_mizai_uranus_bigtts',
          audio: '/ai-generated/job_tts_place_voice.wav',
          timing: '/ai-generated/job_tts_place_timing.json',
        },
      },
    },
  }
  window.fetch = (input, init) => {
    const url = String(input)
    if (url.includes('/ack')) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    if (init?.body) return Promise.resolve(new Response(JSON.stringify({ ok: true, job: { id: job.id } }), { status: 200 }))
    return Promise.resolve(new Response(JSON.stringify({ ok: true, items: [job] }), { status: 200 }))
  }
  localStorage.setItem('todo.tts.voice', JSON.stringify({ voice: 'mizai', cloneId: '' }))
  useApp.setState({
    scriptWorkspace: null,
    scriptMemo: null,
    script: '复利靠的是时间。',
    scriptOpen: true,
    playhead: 1.25,
  })
  try {
    flushSync(() => root.render(<ScriptMemo />))
    flushSync(() => (host.querySelector('[data-testid="script-tts-burn"]') as HTMLButtonElement).click())
    let placed = false
    for (let i = 0; i < 40 && !placed; i++) {
      await frame()
      const seq = useApp.getState().seq()
      placed = seq.clips.some((clip) => {
        const track = seq.tracks.find((t) => t.id === clip.trackId)
        return track?.kind === 'audio' && Math.abs(clip.start - 1.25) < 0.01 && Math.abs(clip.duration - 2.4) < 0.01
      })
    }
    check(placed, 'tts audio was not placed on the audio track at the playhead')
    check(host.querySelector('[data-testid="script-tts-note"]')?.textContent === '配音已放到时间轴', 'memo did not report the timeline placement')
  } finally {
    stopAllTtsWatches()
    setTtsWatchPollMs(2000)
    flushSync(() => root.render(null))
    window.fetch = savedFetch
  }
})
test('chain writing follows theme, outline, then woven examples', () => {
  const savedFetch = window.fetch
  let called = false
  window.fetch = () => { called = true; return new Promise(() => {}) }
  useApp.setState({ scriptWorkspace: null, script: '', scriptMemo: null, scriptOpen: true })
  try {
    flushSync(() => root.render(<ScriptMemo />))
    const brief = host.querySelector('[data-testid="script-stage-start"] input') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(brief, '年轻人第一份工资怎么存')
    flushSync(() => brief.dispatchEvent(new Event('input', { bubbles: true })))
    const start = [...host.querySelectorAll('button')].find((button) => /按主题写/.test(button.textContent || ''))!
    flushSync(() => start.click())
    check(useApp.getState().scriptWorkspace?.mode === 'chain', 'theme writing did not start')
    check(!called, 'theme writing opened the old project-card request')
    check(!host.querySelector('[data-testid="script-card-confirm"]'), 'old confirm card appeared before the outline')
    const track = [...host.querySelectorAll('button')].find((button) => button.textContent === '财经赛道')!
    flushSync(() => track.click())
    flushSync(() => (host.querySelector('[data-testid="chain-next"]') as HTMLButtonElement).click())
    const point = host.querySelector('[data-testid="chain-point"]') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(point, '先讲工资到账后最容易犯的错。')
    flushSync(() => point.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (host.querySelector('[data-testid="chain-next"]') as HTMLButtonElement).click())
    const data = host.querySelector('[data-testid="chain-data"]') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(data, '一万元放余额宝，一年利息大约两百块。')
    flushSync(() => data.dispatchEvent(new Event('input', { bubbles: true })))
    const story = host.querySelector('[data-testid="chain-story"]') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(story, '我同事发了工资，当天就全买了基金。')
    flushSync(() => story.dispatchEvent(new Event('input', { bubbles: true })))
    check(host.textContent?.includes('互动'), 'interaction slot missing from the weave step')
    flushSync(() => (host.querySelector('[data-testid="chain-write"]') as HTMLButtonElement).click())
    const script = useApp.getState().script
    check(script.includes('先讲工资到账后最容易犯的错。'), 'outline sentence missing from spoken body')
    check(script.includes('一万元放余额宝，一年利息大约两百块。'), 'data example missing from spoken body')
    check(script.includes('我同事发了工资，当天就全买了基金。'), 'story missing from spoken body')
    check(!script.includes('数据例子') && !script.includes('【'), 'weave labels were copied into the spoken body')
    check(useApp.getState().scriptWorkspace?.chain_step === 'draft', 'writing the body did not move to the draft step')
    const back = [...host.querySelectorAll('button')].find((button) => button.textContent === '返回穿插')!
    flushSync(() => back.click())
    check((host.querySelector('[data-testid="chain-data"]') as HTMLTextAreaElement).value.includes('大约两百块'), 'going back dropped the woven example')
    const theme = [...host.querySelectorAll('.script-stage-pill')].find((button) => button.textContent === '大主题')!
    flushSync(() => theme.click())
    check(host.textContent?.includes('财经赛道'), 'theme was cleared')
    const weave = [...host.querySelectorAll('.script-stage-pill')].find((button) => button.textContent === '穿插')!
    flushSync(() => weave.click())
    check((host.querySelector('[data-testid="chain-story"]') as HTMLTextAreaElement).value.includes('全买了基金'), 'story was cleared after leaving the theme')
  } finally { flushSync(() => root.render(null)); window.fetch = savedFetch }
})
;(window as any).scriptTests = chain.then(() => {
  // Keep a representative workbench visible for screenshot inspection.
  const ws = startWorkspace('standard', '给职场新人讲清楚第一份工资怎么存')
  ws.current_card = { stage: 'A', card_type: 'form', question_for_user: '先确认这次口播的创作目标', notes: '这些设置会影响选题、口吻和最终文稿长度，你可以直接修改。', options: [
    { id: 'platform', title: '发布平台', suggested: '抖音', choices: ['抖音', '视频号', '小红书'] },
    { id: 'duration_sec', title: '目标时长（秒）', suggested: 90 },
    { id: 'audience', title: '目标观众', suggested: '刚开始工作的年轻人' },
  ] }
  useApp.setState({ scriptWorkspace: ws, script: '第一份工资，该怎么安排？\n\n先留出生活费，再为自己建立一个小小的应急储备。\n不必一次做到完美，从这个月开始就好。', projectName: '每日口播 · 第一期' })
  flushSync(() => root.render(<ScriptMemo />))
  return { results, failed: results.filter(r => !r.ok).length }
})
