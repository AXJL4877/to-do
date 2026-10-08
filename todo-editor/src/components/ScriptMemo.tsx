import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BookOpen, Loader2, Mic, NotebookPen, PencilLine, Plus, Sparkles, X, Wand2, FastForward, Eraser,
} from 'lucide-react'
import { useApp } from '../store'
import { requestScriptAi, type ScriptAiMode } from '../lib/scriptAi'
import { requestScriptStage } from '../lib/scriptStageAi'
import { buildCreativeBrief, classifyRewrite, estimateSpeech, readSpokenBody, rewriteFailureKind, rewriteFailureText, type RewriteHold } from '../lib/scriptMemoDocument'
import {
  CHARS_PER_SEC,
  CHAIN_STEPS,
  STAGE_LABELS,
  STAGE_ORDER,
  SUBSTEP_LABELS,
  canEnterChainStep,
  ensureChainOutline,
  stageVisual,
  stageVisualLabel,
  startWorkspace,
  draftFullText,
  stripMaterialMarks,
  restoreSnapshot,
  materialGateOk,
  type ScriptMode,
  type ScriptWorkspace,
} from '../lib/scriptWorkspace'
import {
  applyExpandConfirm,
  applyFactConfirm,
  applyFormConfirm,
  applyHookConfirm,
  applyLogicConfirm,
  applyMaterialsConfirm,
  applyOutlineConfirm,
  applyPackageConfirm,
  applyPastedMaterials,
  applyPolishConfirm,
  applyQuestionsConfirm,
  applyTopicConfirm,
  applyFactAction,
} from '../lib/scriptStageApply'
import { CreativeProgress } from './CreativeProgress'
import { ScriptChain } from './ScriptChain'
import { ScriptStageAskDock } from './ScriptStageAskDock'
import { prepareSpokenTts } from '../lib/scriptTts'
import { watchTtsJob } from '../lib/ttsJobWatch'
import { loadVoiceChoice, saveVoiceChoice, type VoiceChoice } from '../lib/ttsVoicePrefs'
import { TTS_SKILL_ID, enqueueSkill, phaseText } from '../lib/aiSkills'

type ViewState = { start: number; end: number; scrollTop: number }

function viewKey(projectId: string) {
  return `todo-script-view:${projectId}`
}

function loadView(projectId: string): ViewState | null {
  try {
    const raw = sessionStorage.getItem(viewKey(projectId))
    if (!raw) return null
    const j = JSON.parse(raw) as ViewState
    if (typeof j.start !== 'number' || typeof j.end !== 'number') return null
    return {
      start: Math.max(0, j.start),
      end: Math.max(0, j.end),
      scrollTop: Math.max(0, Number(j.scrollTop) || 0),
    }
  } catch {
    return null
  }
}

function saveView(projectId: string, v: ViewState) {
  try {
    sessionStorage.setItem(viewKey(projectId), JSON.stringify(v))
  } catch { /* */ }
}

function fmtDuration(sec: number) {
  const s = Math.round(sec)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

type Sel = { start: number; end: number; text: string }

function readSel(el: HTMLTextAreaElement | null): Sel {
  if (!el) return { start: 0, end: 0, text: '' }
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? start
  return { start, end, text: el.value.slice(start, end) }
}

function caretPagePos(el: HTMLTextAreaElement, index: number): { x: number; y: number } {
  const style = window.getComputedStyle(el)
  const mirror = document.createElement('div')
  const props = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize', 'MozTabSize', 'whiteSpace',
    'wordWrap', 'wordBreak',
  ] as const
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  for (const p of props) {
    // @ts-expect-error CSSStyleDeclaration index
    mirror.style[p] = style[p]
  }
  mirror.style.width = `${el.clientWidth}px`
  mirror.style.height = 'auto'
  const before = el.value.slice(0, index)
  mirror.textContent = before
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(index, index + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const rect = el.getBoundingClientRect()
  const mRect = marker.getBoundingClientRect()
  const mBox = mirror.getBoundingClientRect()
  document.body.removeChild(mirror)
  return {
    x: rect.left + (mRect.left - mBox.left) - el.scrollLeft,
    y: rect.top + (mRect.top - mBox.top) - el.scrollTop + mRect.height,
  }
}

type PanelMode = ScriptAiMode | null

/** 口播备忘录：正文随流程更新 + 底部问答 */
export function ScriptMemo() {
  const script = useApp((s) => s.script)
  const projectId = useApp((s) => s.projectId)
  const projectName = useApp((s) => s.projectName)
  const setScript = useApp((s) => s.setScript)
  const sealScriptEdit = useApp((s) => s.sealScriptEdit)
  const commitScriptState = useApp((s) => s.commitScriptState)
  const toggleScript = useApp((s) => s.toggleScript)
  const ws = useApp((s) => s.scriptWorkspace)
  const scriptMemo = useApp((s) => s.scriptMemo)
  const setScriptWorkspace = useApp((s) => s.setScriptWorkspace)
  const patchScriptWorkspace = useApp((s) => s.patchScriptWorkspace)

  const ref = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<Sel>({ start: 0, end: 0, text: '' })
  const [bar, setBar] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
  const [panel, setPanel] = useState<PanelMode>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [stageBusy, setStageBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)
  const [brief, setBrief] = useState('')
  const [pasteMat, setPasteMat] = useState('')
  const [startChoice, setStartChoice] = useState<ScriptMode | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [pendingRewrite, setPendingRewrite] = useState<{ text: string; reply: string; note: string; start: number; end: number; canApply: boolean } | null>(null)
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>(loadVoiceChoice)
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsError, setTtsError] = useState<string | null>(null)
  const [ttsNote, setTtsNote] = useState<string | null>(null)
  const ttsAlive = useRef(true)
  const restored = useRef(false)
  const pendingApply = useRef<{ from: number; to: number; scrollTop: number } | null>(null)
  const lockView = useRef(false)
  const autoGenKey = useRef('')
  const stageRequest = useRef<AbortController | null>(null)
  const aiRequest = useRef<AbortController | null>(null)
  const aiHold = useRef<RewriteHold | null>(null)
  const cancelStage = useCallback(() => {
    stageRequest.current?.abort()
    stageRequest.current = null
    setStageBusy(false)
  }, [])
  useEffect(() => {
    autoGenKey.current = ''
    restored.current = false
    setStageBusy(false)
    return () => { stageRequest.current?.abort(); stageRequest.current = null; aiRequest.current?.abort(); aiRequest.current = null }
  }, [projectId])
  useEffect(() => {
    ttsAlive.current = true
    return () => { ttsAlive.current = false }
  }, [])

  const wizard = !!ws?.active
  const card = ws?.current_card ?? null
  const spoken = readSpokenBody(script, scriptMemo)
  const rate = scriptMemo?.chars_per_sec || ws?.chars_per_sec || CHARS_PER_SEC
  const stats = estimateSpeech(spoken, rate)
  const selStats = estimateSpeech(sel.text, rate)

  const commitBoth = useCallback((next: ScriptWorkspace, body?: string) => {
    const live = useApp.getState()
    const text = body !== undefined ? body : live.script
    const memo = live.scriptMemo
      ? { ...live.scriptMemo, stale_settings: next.stale_settings, revision: next.revision || live.scriptMemo.revision, chars_per_sec: next.chars_per_sec || live.scriptMemo.chars_per_sec }
      : live.scriptMemo
    live.commitScriptState({ script: text, scriptWorkspace: { ...next, body: text }, scriptMemo: memo })
  }, [])

  const persistView = useCallback(() => {
    const el = ref.current
    if (!el || lockView.current) return
    saveView(projectId, {
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
      scrollTop: el.scrollTop,
    })
  }, [projectId])

  const closeMemo = useCallback(() => {
    cancelStage()
    persistView()
    toggleScript(false)
  }, [persistView, toggleScript, cancelStage])

  function placeBar(el: HTMLTextAreaElement, atIndex?: number) {
    const cur = readSel(el)
    const idx = atIndex ?? (cur.end > cur.start ? cur.end : cur.start)
    const pos = caretPagePos(el, idx)
    const pad = 8
    const x = Math.min(window.innerWidth - 220, Math.max(12, pos.x))
    const y = Math.min(window.innerHeight - 48, Math.max(56, pos.y + pad))
    setBar({ x, y, visible: true })
    setSel(cur)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || restored.current) return
    restored.current = true
    const saved = loadView(projectId)
    el.focus()
    if (saved) {
      const max = el.value.length
      const a = Math.min(saved.start, max)
      const b = Math.min(saved.end, max)
      el.scrollTop = saved.scrollTop
      el.setSelectionRange(a, b)
      el.scrollTop = saved.scrollTop
      setSel(readSel(el))
      requestAnimationFrame(() => placeBar(el))
    } else {
      const end = el.value.length
      el.setSelectionRange(end, end)
      setSel({ start: end, end, text: '' })
    }
  }, [projectId])

  useLayoutEffect(() => {
    const p = pendingApply.current
    if (!p) return
    pendingApply.current = null
    const el = ref.current
    if (!el) return
    lockView.current = true
    const max = el.value.length
    const to = Math.min(p.to, max)
    el.focus()
    el.scrollTop = p.scrollTop
    el.setSelectionRange(to, to)
    el.scrollTop = p.scrollTop
    setSel(readSel(el))
    saveView(projectId, { start: to, end: to, scrollTop: p.scrollTop })
    placeBar(el, p.from)
    lockView.current = false
  }, [script, projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panel) {
          e.preventDefault()
          setPanel(null)
          setReply(null)
          setError(null)
          return
        }
        if (bar.visible) {
          e.preventDefault()
          setBar((b) => ({ ...b, visible: false }))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, bar.visible])

  const syncSel = useCallback(() => {
    if (lockView.current) return
    const el = ref.current
    if (!el) return
    persistView()
    placeBar(el)
    if (!panel) {
      setReply(null)
      setError(null)
    }
  }, [panel, persistView])

  const applyText = (next: string, selectFrom: number, selectTo: number) => {
    const el = ref.current
    pendingApply.current = {
      from: selectFrom,
      to: selectTo,
      scrollTop: el?.scrollTop ?? 0,
    }
    setScript(next)
  }

  const openPanel = (m: ScriptAiMode) => {
    setPanel(m)
    setReply(null)
    setError(null)
    setInstruction('')
    if (m === 'explain') {
      const el = ref.current
      const cur = readSel(el)
      if (cur.text.trim()) void runAi('explain', '')
    }
  }

  const closeAiPanel = () => {
    aiRequest.current?.abort()
    aiRequest.current = null
    aiHold.current = null
    setPanel(null)
    setReply(null)
    setError(null)
    setPendingRewrite(null)
  }

  const runAi = async (forced?: ScriptAiMode, instrOverride?: string) => {
    const el = ref.current
    if (!el || busy) return
    const cur = readSel(el)
    const m = forced || panel || 'rewrite'
    if ((m === 'explain' || m === 'ask') && !cur.text.trim()) {
      setError('请先选中要解释的词或段落')
      return
    }
    const live = useApp.getState()
    const hold: RewriteHold = {
      projectId: live.projectId,
      revision: live.scriptMemo?.revision ?? live.scriptWorkspace?.revision ?? 0,
      start: cur.start,
      end: cur.end,
      selected: cur.text,
      fullText: el.value,
    }
    aiHold.current = hold
    aiRequest.current?.abort()
    const request = new AbortController()
    aiRequest.current = request
    setBusy(true)
    setError(null)
    setReply(null)
    setPendingRewrite(null)
    try {
      const instr = (instrOverride ?? instruction).trim() || undefined
      const scope = cur.text.trim() ? '选中文字' : '全文'
      const result = await requestScriptAi({
        mode: m,
        fullText: el.value,
        selection: cur.text || undefined,
        instruction: instr || (m === 'rewrite' ? undefined : undefined),
        cursorBefore: el.value.slice(0, cur.start),
        cursorAfter: el.value.slice(cur.end),
      }, request.signal)
      if (aiRequest.current !== request) return
      if (m === 'ask' || m === 'explain') {
        setReply(`${scope}：${result.reply}`)
        return
      }
      const now = useApp.getState()
      const plan = classifyRewrite(hold, {
        projectId: now.projectId,
        revision: now.scriptMemo?.revision ?? now.scriptWorkspace?.revision ?? 0,
        fullText: now.script,
      })
      if (plan.action === 'stale') {
        setPendingRewrite({ text: result.text, reply: result.reply || '建议基于旧版本', note: plan.reason, start: hold.start, end: hold.end, canApply: false })
        setReply(plan.reason)
        return
      }
      const note = plan.action === 'shifted' ? `将应用到当前位置 ${plan.start}–${plan.end}` : `作用于${scope}`
      setPendingRewrite({ text: result.text, reply: result.reply || '可以应用这次修改', note, start: plan.start, end: plan.end, canApply: true })
      setReply(note)
    } catch (e) {
      if (aiRequest.current !== request) return
      setError(rewriteFailureText(rewriteFailureKind(e)))
    } finally {
      if (aiRequest.current === request) setBusy(false)
    }
  }

  const applyPendingRewrite = () => {
    const pending = pendingRewrite
    const el = ref.current
    if (!pending?.canApply || !el) return
    sealScriptEdit()
    const next = el.value.slice(0, pending.start) + pending.text + el.value.slice(pending.end)
    applyText(next, pending.start, pending.start + pending.text.length)
    sealScriptEdit()
    setPendingRewrite(null)
    setPanel(null)
    setReply('已应用，可整体撤销')
  }

  const loadDefaults = () => {
    try { return JSON.parse(localStorage.getItem('todo-script-defaults') || '{}') as { platform?: string; duration_sec?: number; persona?: string } }
    catch { return {} }
  }

  const openWorkspace = (mode: ScriptMode, choice: 'new' | 'continue') => {
    cancelStage()
    const live = useApp.getState()
    live.sealScriptEdit()
    const seed = brief.trim() || projectName
    const body = readSpokenBody(live.script, live.scriptMemo)
    if (choice === 'new') {
      const saved = startWorkspace(mode === 'chain' ? 'chain' : 'standard', seed, '')
      saved.history = [{
        id: `h_new_${Date.now().toString(36)}`,
        parent_id: null,
        stage: 'A',
        substep: 'A.form',
        action: '新建稿件版本',
        ts: Date.now(),
        summary: '保存并离开上一版正文',
        chars: stats.chars,
        named: true,
        snapshot: {
          script: body,
          project_card: live.scriptWorkspace?.project_card ?? null,
          topic: live.scriptWorkspace?.topic ?? null,
          material_bank: live.scriptWorkspace?.material_bank ?? [],
          hook: live.scriptWorkspace?.hook ?? null,
          logic_line: live.scriptWorkspace?.logic_line ?? null,
          outline: live.scriptWorkspace?.outline ?? [],
          draft: live.scriptWorkspace?.draft ?? [],
          fact_check: live.scriptWorkspace?.fact_check ?? [],
          package: live.scriptWorkspace?.package ?? null,
          selected_ids: [],
          stage: live.scriptWorkspace?.stage ?? 'A',
          substep: live.scriptWorkspace?.substep ?? 'A.form',
        },
      }]
      commitBoth({ ...saved, mode, user_brief: seed, body: '' }, '')
    } else if (mode === 'chain' && live.scriptWorkspace?.mode === 'chain') {
      const prev = live.scriptWorkspace
      const briefChanged = !!brief.trim() && brief.trim() !== prev.user_brief
      commitBoth({
        ...prev,
        active: true,
        user_brief: brief.trim() || prev.user_brief,
        chain_step: briefChanged ? 'theme' : prev.chain_step,
      }, body)
    } else {
      const next = startWorkspace(mode === 'polish_only' ? 'polish_only' : mode, seed, body)
      const defaults = loadDefaults()
      if (next.project_card && mode !== 'polish_only') {
        next.project_card = {
          ...next.project_card,
          platform: defaults.platform || next.project_card.platform,
          duration_sec: defaults.duration_sec || next.project_card.duration_sec,
          persona: defaults.persona || next.project_card.persona,
        }
      }
      commitBoth({ ...next, body }, body)
    }
    setStartChoice(null)
    setStageError(null)
    autoGenKey.current = ''
  }

  const beginWizard = (mode: ScriptMode) => {
    const body = readSpokenBody(useApp.getState().script, useApp.getState().scriptMemo)
    if (body.trim() && mode !== 'polish_only') {
      setStartChoice(mode)
      return
    }
    openWorkspace(mode, mode === 'polish_only' ? 'continue' : 'continue')
  }

  const stopWizard = () => {
    cancelStage()
    if (!ws) return
    setScriptWorkspace({ ...ws, active: false, current_card: null })
    setStageError(null)
  }

  const clearWizard = () => {
    cancelStage()
    setScriptWorkspace(null)
    setStageError(null)
    autoGenKey.current = ''
  }

  const generateCard = useCallback(async (state: ScriptWorkspace, instruction?: string) => {
    stageRequest.current?.abort()
    const request = new AbortController()
    stageRequest.current = request
    const current = () => stageRequest.current === request && !request.signal.aborted && useApp.getState().projectId === projectId
    setStageBusy(true)
    setStageError(null)
    try {
      const live = useApp.getState()
      const full = readSpokenBody(live.script, live.scriptMemo)
      const seg = state.outline[state.expand_index]
      const prevParts = state.outline.slice(0, state.expand_index).map((s) => {
        const d = state.draft.find((x) => x.id === s.id)
        const ver = d?.versions.find((v) => v.v === d.current) || d?.versions[d.versions.length - 1]
        return ver?.text || ''
      }).filter(Boolean)

      const result = await requestScriptStage({
        action: 'generate',
        workspace: state,
        substep: state.substep,
        project_name: projectName,
        user_instruction: instruction || state.custom_text || undefined,
        search_results: state.substep === 'C.materials' ? (pasteMat || instruction || undefined) : undefined,
        full_draft: full,
        current_segment: seg,
        segment_index: state.expand_index,
        previous_text: prevParts.join('\n\n'),
        intensity: state.intensity,
      }, request.signal)
      if (!current()) return
      if (!result.card) throw new Error('AI 未返回可用选项，请重试本步')

      if (state.substep === 'A.form' && result.card) {
        let defaults: { platform?: string; duration_sec?: number; persona?: string } = {}
        try { defaults = JSON.parse(localStorage.getItem('todo-script-defaults') || '{}') } catch { /* 没有日常偏好 */ }
        const mapFields = (fields: NonNullable<typeof result.card>['options']) => (fields || []).map((field) => {
          const key = String(field.key || field.id)
          if (key === 'platform' && defaults.platform) return { ...field, suggested: defaults.platform }
          if (key === 'duration_sec' && defaults.duration_sec) return { ...field, suggested: defaults.duration_sec }
          if (key === 'persona' && defaults.persona) return { ...field, suggested: defaults.persona }
          return field
        })
        result.card = {
          ...result.card,
          options: mapFields(result.card.options),
          ...(result.card.fields ? { fields: mapFields(result.card.fields) } : {}),
        }
      }

      let next: ScriptWorkspace = {
        ...state,
        current_card: result.card || null,
        selected_ids: result.card?.recommended_id ? [String(result.card.recommended_id)] : [],
        custom_text: '',
      }
      if (result.logic_line) {
        next = { ...next, logic_line: result.logic_line }
      }
      if (result.card?.card_type === 'diff_review') {
        next.selected_ids = (result.card.options || [])
          .filter((o) => o.accept_default !== false)
          .map((o) => String(o.id))
      }
      if (result.card?.card_type === 'multi_select' && result.card.recommended_id) {
        next.selected_ids = [String(result.card.recommended_id)]
      }
      if (result.card?.card_type === 'form') {
        next.selected_ids = (result.card.options || []).map((o) => String(o.id))
      }
      if (state.substep === 'C.questions') {
        next.selected_ids = (result.card?.options || []).map((o) => String(o.id))
      }
      if (state.substep === 'C.materials') {
        next.selected_ids = []
      }
      if (state.substep === 'E.fact') {
        next.selected_ids = (result.card?.options || [])
          .filter((o) => o.status === 'ok' || o.status === 'limit')
          .map((o) => String(o.id))
      }
      setScriptWorkspace(next)
    } catch (e) {
      if (current()) setStageError(e instanceof Error ? e.message : String(e))
    } finally {
      if (current()) { stageRequest.current = null; setStageBusy(false) }
    }
  }, [pasteMat, projectId, projectName, script, setScriptWorkspace])

  useEffect(() => {
    if (!ws?.active || stageBusy) return
    if (ws.mode === 'chain') return
    if (ws.current_card) return
    if (ws.substep === 'C.materials' && !pasteMat.trim() && !ws.material_bank.length) return
    const key = `${ws.stage}:${ws.substep}:${ws.expand_index}`
    if (autoGenKey.current === key) return
    autoGenKey.current = key
    void generateCard(ws)
  }, [ws, stageBusy, pasteMat, generateCard])

  const toggleSelect = (id: string) => {
    if (!ws?.current_card) return
    const multi = ws.current_card.card_type === 'multi_select'
      || ws.current_card.card_type === 'diff_review'
      || ws.current_card.card_type === 'form'
    if (multi) {
      const set = new Set(ws.selected_ids)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      patchScriptWorkspace({ selected_ids: [...set] })
    } else {
      patchScriptWorkspace({ selected_ids: [id] })
    }
  }

  const finishStep = (next: ScriptWorkspace, body?: string) => {
    autoGenKey.current = ''
    if (next.project_card) {
      try {
        localStorage.setItem('todo-script-defaults', JSON.stringify({
          platform: next.project_card.platform,
          duration_sec: next.project_card.duration_sec,
          persona: next.project_card.persona,
        }))
      } catch { /* 偏好写不进去时不影响确认 */ }
    }
    commitBoth(next, body)
    setStageError(null)
  }

  const confirmCard = async (override?: ScriptWorkspace) => {
    if (stageBusy) return
    let state = override || ws
    if (!state?.current_card) return
    const c = state.current_card
    const custom = state.custom_text.trim()
    if (c.card_type === 'free_input') {
      if (!custom) { setStageError('请先写要采用的内容'); return }
      state = { ...state, selected_ids: ['custom'], current_card: { ...c, options: [{ id: 'custom', title: custom.slice(0, 40), content: custom }] } }
    } else if (custom && !state.selected_ids.length && c.card_type !== 'form') {
      setStageError('这段文字可以选择「直接采用」，或「让 AI 重写」')
      return
    }

    const picked = c.card_type === 'free_input'
      ? (state.current_card?.options ?? [])
      : c.options.filter((o) => state.selected_ids.includes(String(o.id)) || state.selected_ids.includes(String(o.key || '')))
    const first = picked[0]

    try {
      let next = state
      if (state.substep === 'A.form') {
        next = applyFormConfirm(state, c, state.selected_ids)
        finishStep(next)
      } else if (state.substep === 'B.topics') {
        if (!first) throw new Error('请选择一个选题')
        next = applyTopicConfirm(state, first)
        finishStep(next)
      } else if (state.substep === 'C.questions') {
        if (!picked.length) throw new Error('请选择要保留的问题，或点 AI 代决')
        next = applyQuestionsConfirm(state, picked)
        finishStep(next)
      } else if (state.substep === 'C.materials') {
        if (!picked.length) {
          setStageError(materialGateOk({ ...state, material_bank: [], analogy_only: false }).reason || '请选择要保留的材料')
          return
        }
        const r = applyMaterialsConfirm(state, picked)
        if (r.error) { setStageError(r.error); return }
        finishStep(r.ws)
      } else if (state.substep === 'D.hook') {
        if (!first) throw new Error('请选择钩子')
        next = applyHookConfirm(state, first)
        finishStep(next)
      } else if (state.substep === 'D.logic') {
        next = applyLogicConfirm(state, c, state.logic_line || c.logic_line)
        finishStep(next)
      } else if (state.substep === 'D.outline') {
        if (!first) throw new Error('请选择大纲')
        next = applyOutlineConfirm(state, first)
        finishStep(next)
      } else if (state.substep === 'E.expand') {
        if (!first) throw new Error('请选择一个版本')
        next = applyExpandConfirm(state, first)
        finishStep(next, stripMaterialMarks(draftFullText(next)))
      } else if (state.substep === 'E.polish') {
        const r = applyPolishConfirm(state, c, state.selected_ids)
        finishStep(r.ws, r.script)
      } else if (state.substep === 'E.fact') {
        const r = applyFactConfirm(state, c, state.selected_ids)
        if (r.error) { setStageError(r.error); return }
        finishStep(r.ws)
      } else if (state.substep === 'F.package') {
        if (!first && !state.selected_ids[0]) throw new Error('请选择发布标题')
        const r = applyPackageConfirm(state, c, state.selected_ids[0] || String(first?.id || ''))
        finishStep(r.ws, r.script)
      }
    } catch (e) {
      setStageError(e instanceof Error ? e.message : String(e))
    }
  }

  const adoptCustom = () => {
    if (!ws?.current_card) return
    const text = ws.custom_text.trim()
    if (!text) return
    const opt = { id: 'custom', title: text.slice(0, 40), content: text }
    void confirmCard({
      ...ws,
      custom_text: '',
      selected_ids: ['custom'],
      current_card: { ...ws.current_card, options: [...ws.current_card.options, opt] },
    })
  }

  const skipOrAuto = () => {
    if (!ws?.current_card) return
    const c = ws.current_card
    const multi = c.card_type === 'multi_select' || c.card_type === 'diff_review' || c.card_type === 'form'
    const selected_ids = multi
      ? c.options.map((o) => String(o.id))
      : (c.recommended_id ? [String(c.recommended_id)] : c.options.slice(0, 1).map((o) => String(o.id)))
    void confirmCard({ ...ws, selected_ids, custom_text: '' })
  }

  const runMaterialsFromPaste = () => {
    if (!ws) return
    if (!pasteMat.trim()) {
      setStageError('请先粘贴资料')
      return
    }
    const withBank = applyPastedMaterials(ws, pasteMat)
    commitBoth(withBank)
    autoGenKey.current = ''
    void generateCard({ ...withBank, current_card: null }, pasteMat)
  }

  const hasSel = sel.end > sel.start
  const visibleScript = viewingId
    ? (ws?.history.find((node) => node.id === viewingId)?.snapshot?.script ?? script)
    : script
  const spokenReady = prepareSpokenTts(visibleScript, scriptMemo, voiceChoice)

  function chooseVoice(patch: Partial<VoiceChoice>) {
    const next = { ...voiceChoice, ...patch }
    setVoiceChoice(next)
    saveVoiceChoice(patch)
    setTtsError(null)
  }

  async function burnSpoken() {
    if (ttsBusy) return
    const live = useApp.getState()
    live.sealScriptEdit()
    const after = useApp.getState()
    const source = viewingId
      ? (after.scriptWorkspace?.history.find((node) => node.id === viewingId)?.snapshot?.script ?? after.script)
      : after.script
    const ready = prepareSpokenTts(source, after.scriptMemo, voiceChoice)
    if (!ready.ok) {
      setTtsError(ready.error)
      return
    }
    setTtsBusy(true)
    setTtsError(null)
    setTtsNote(null)
    try {
      const job = await enqueueSkill({
        skillId: TTS_SKILL_ID,
        prompt: ready.prompt,
        params: ready.params,
        autoTimeline: true,
        placement: 'playhead',
        placeAt: after.playhead,
      })
      if (!ttsAlive.current) return
      after.setVoiceSeed({
        text: ready.prompt,
        revision: after.scriptMemo?.revision ?? after.scriptWorkspace?.revision ?? 0,
        projectId: after.projectId,
      })
      setTtsNote('配音合成中，完成后放到时间轴播放头')
      useApp.getState().setToast('配音已入队，完成后放到时间轴')
      watchTtsJob(job.id, (update) => {
        if (!ttsAlive.current) return
        if (update.status === 'error') {
          setTtsNote(null)
          setTtsError(update.error || '配音失败')
          return
        }
        if (update.status === 'imported') {
          setTtsError(null)
          setTtsNote('配音已放到时间轴')
          return
        }
        setTtsError(null)
        const phase = phaseText(update.phase)
        setTtsNote(phase ? `${phase}，完成后放到时间轴播放头` : '配音合成中，完成后放到时间轴播放头')
      })
    } catch (e) {
      if (ttsAlive.current) setTtsError(e instanceof Error ? e.message : String(e))
    } finally {
      if (ttsAlive.current) setTtsBusy(false)
    }
  }

  return (
    <div className="script-memo" data-testid="script-memo" ref={wrapRef}>
      <header className="script-memo-head">
        <NotebookPen size={15} style={{ color: 'var(--accent)' }} />
        <span className="font-medium" style={{ fontFamily: 'var(--font-display)' }}>口播稿</span>
        <span className="truncate" style={{ color: 'var(--text-muted)' }}>· {projectName}</span>
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }} title="字数和时长只统计正文。语速是估算，最终配音时长以音频为准。">
          正文 {stats.chars} 字 · 估算 {fmtDuration(stats.seconds)}
          {wizard && ws ? ` · ${ws.mode === 'chain' ? (CHAIN_STEPS.find((item) => item.id === ws.chain_step)?.label || '大主题') : SUBSTEP_LABELS[ws.substep]}` : ''}
          {hasSel ? ` · 选区 ${selStats.chars} 字` : ''}
        </span>
        <span className="script-memo-key">~ 返回剪辑</span>
        <button className="icon-btn" onClick={closeMemo} aria-label="返回剪辑"><X size={14} /></button>
      </header>
      <div className="script-tts-bar" data-testid="script-tts-bar">
        <label className="flex items-center gap-1.5">
          音色
          <select
            className="input"
            data-testid="script-tts-voice"
            value={voiceChoice.voice}
            onChange={(e) => chooseVoice({ voice: e.target.value === 'clone' ? 'clone' : 'mizai' })}
          >
            <option value="mizai">咪仔</option>
            <option value="clone">克隆音</option>
          </select>
        </label>
        {voiceChoice.voice === 'clone' ? (
          <input
            className="input"
            data-testid="script-tts-clone"
            value={voiceChoice.cloneId}
            maxLength={64}
            placeholder="S_xxxxxxxx"
            spellCheck={false}
            onChange={(e) => chooseVoice({ cloneId: e.target.value })}
          />
        ) : null}
        <button
          type="button"
          className="btn btn-primary text-[11px]"
          data-testid="script-tts-burn"
          disabled={!spokenReady.ok || ttsBusy}
          title={spokenReady.ok ? '用当前正文合成，放到时间轴播放头' : spokenReady.error}
          onClick={() => void burnSpoken()}
        >
          {ttsBusy ? <Loader2 size={12} className="animate-spin" /> : <Mic size={12} />}
          配音入轨
        </button>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {viewingId ? '按正在查看的这一版正文' : '用当前正文'}，合成后放到播放头
        </span>
        {ttsNote ? <span className="text-[11px]" data-testid="script-tts-note" style={{ color: 'var(--text-secondary)' }}>{ttsNote}</span> : null}
        {ttsError ? <span className="text-[11px]" data-testid="script-tts-error" style={{ color: 'var(--error)' }}>{ttsError}</span> : null}
      </div>
      {scriptMemo?.stale_settings || ws?.stale_settings ? (
        <p className="script-memo-stale">正文基于旧设定，尚未自动清空。可以继续改，或从受影响的阶段重新生成。</p>
      ) : null}

      {wizard && ws ? (
        <div className="script-stage-rail" data-testid="script-stage-rail">
          {ws.mode === 'chain' ? CHAIN_STEPS.map((step) => {
            const on = step.id === ws.chain_step
            const open = canEnterChainStep(ws, step.id)
            return (
              <button key={step.id} type="button" className={`script-stage-pill${on ? ' on' : ''}`} disabled={!open}
                onClick={() => {
                  if (!open) return
                  patchScriptWorkspace({
                    ...ws,
                    chain_step: step.id,
                    outline: step.id === 'outline' ? ensureChainOutline(ws.outline) : ws.outline,
                  })
                }}>
                {step.label}
              </button>
            )
          }) : STAGE_ORDER.map((st) => {
            const visual = stageVisual(ws)[st]
            const on = st === ws.stage
            return (
              <button key={st} type="button" className={`script-stage-pill${on ? ' on' : ''}${visual === 'confirmed' ? ' done' : ''}${visual === 'stale' ? ' stale' : ''}${visual === 'failed' ? ' failed' : ''}`}
                onClick={() => {
                  const node = [...ws.history].reverse().find((item) => item.stage === st && item.snapshot)
                  setViewingId(node?.id ?? null)
                }}>
                <b>{st}</b> {STAGE_LABELS[st]} · {stageVisualLabel(visual)}
              </button>
            )
          })}
          <span className="script-stage-sub">{ws.mode === 'chain' ? '按主题' : ws.mode === 'fast' ? '快速' : ws.mode === 'polish_only' ? '打磨' : '标准'}</span>
          <button type="button" className="btn text-[11px] ml-auto" onClick={() => setSettingsOpen((v) => !v)}>创作设定</button>
          <button type="button" className="btn text-[11px]" onClick={() => { void navigator.clipboard.writeText(spoken) }}>复制正文</button>
          <button type="button" className="btn text-[11px]" onClick={() => setHistoryOpen((v) => !v)}>历史</button>
          <button type="button" className="btn text-[11px]" onClick={stopWizard}>退出向导</button>
          <button type="button" className="btn text-[11px]" onClick={clearWizard} title="清空阶段状态">清空</button>
        </div>
      ) : (
        <div className="script-stage-start" data-testid="script-stage-start">
          <input
            className="input flex-1 text-[12px]"
            placeholder="这一期讲什么，例如：年轻人第一份工资怎么存"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <button type="button" className="btn btn-primary text-[11px]" onClick={() => beginWizard('chain')}>
            <NotebookPen size={12} /> 按主题写
          </button>
          <button type="button" className="btn text-[11px]" onClick={() => beginWizard('standard')}>
            <Wand2 size={12} /> 标准创作
          </button>
          <button type="button" className="btn text-[11px]" onClick={() => beginWizard('fast')}>
            <FastForward size={12} /> 快速创作
          </button>
          <button
            type="button"
            className="btn text-[11px]"
            disabled={!spoken.trim()}
            onClick={() => beginWizard('polish_only')}
          >
            <Eraser size={12} /> 打磨现稿
          </button>
        </div>
      )}
      {startChoice ? (
        <div className="script-memo-choice">
          <p>当前正文还在。要保存成新的一版再开始，还是在这一版上继续？</p>
          <button type="button" className="btn btn-primary text-[11px]" onClick={() => openWorkspace(startChoice, 'new')}>新建稿件版本</button>
          <button type="button" className="btn text-[11px]" onClick={() => openWorkspace(startChoice, 'continue')}>继续现稿</button>
          <button type="button" className="btn text-[11px]" onClick={() => setStartChoice(null)}>取消</button>
        </div>
      ) : null}
      {settingsOpen && ws ? (
        <section className="script-settings">
          <p>字数和时长只统计正文。当前估算语速 {rate} 字/秒，最终配音时长以音频为准。</p>
          <button type="button" className="btn text-[11px]" onClick={() => { void navigator.clipboard.writeText(spoken) }}>复制正文</button>
          <button type="button" className="btn text-[11px]" onClick={() => { void navigator.clipboard.writeText(buildCreativeBrief(ws, spoken, scriptMemo?.publish)) }}>复制完整创作简报</button>
          <p>{ws.project_card ? `${ws.project_card.platform} · ${ws.project_card.audience} · ${ws.project_card.duration_sec} 秒 / 约 ${ws.project_card.target_chars} 字 · ${ws.project_card.persona}` : '还没有确认创作设定'}</p>
          <p>{ws.topic ? `选题：${ws.topic.title}` : '选题未确认'}{ws.logic_line?.claim ? ` · 主张：${ws.logic_line.claim}` : ''}</p>
          <label>估算语速（字/秒）
            <input className="input" type="number" min={2} max={8} step={0.1} value={rate}
              onChange={(e) => {
                const chars_per_sec = Math.min(8, Math.max(2, Number(e.target.value) || CHARS_PER_SEC))
                const memo = useApp.getState().scriptMemo
                commitScriptState({
                  scriptWorkspace: { ...ws, chars_per_sec },
                  scriptMemo: memo ? { ...memo, chars_per_sec } : memo,
                })
              }} />
          </label>
          {ws.project_card ? (
            <>
              <label>平台
                <input className="input" value={ws.project_card.platform} onChange={(e) => {
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, platform: e.target.value } }, spoken)
                }} />
              </label>
              <label>受众
                <input className="input" value={ws.project_card.audience} onChange={(e) => {
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, audience: e.target.value } }, spoken)
                }} />
              </label>
              <label>时长（秒）
                <input className="input" type="number" min={15} max={600} value={ws.project_card.duration_sec} onChange={(e) => {
                  const duration_sec = Math.min(600, Math.max(15, Number(e.target.value) || ws.project_card!.duration_sec))
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, duration_sec, target_chars: Math.round(duration_sec / 60 * 270) } }, spoken)
                }} />
              </label>
              <label>口吻
                <input className="input" value={ws.project_card.persona} onChange={(e) => {
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, persona: e.target.value } }, spoken)
                }} />
              </label>
              <label>目标
                <input className="input" value={ws.project_card.goal} onChange={(e) => {
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, goal: e.target.value } }, spoken)
                }} />
              </label>
              <label>禁区
                <input className="input" value={ws.project_card.taboo.join('、')} onChange={(e) => {
                  commitBoth({ ...ws, stale_settings: true, stale_from: 'A', project_card: { ...ws.project_card!, taboo: e.target.value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean) } }, spoken)
                }} />
              </label>
            </>
          ) : null}
          {ws.material_bank.length ? <ul>{ws.material_bank.map((item) => <li key={item.id}>{item.content}{item.source ? ` · 来源：${item.source}` : ' · 待核验'}</li>)}</ul> : <p>素材引用会显示在这里，不会写进正文。</p>}
          {ws.outline.length ? <ol>{ws.outline.map((seg) => <li key={seg.id}>{seg.role}：{seg.key_point}</li>)}</ol> : null}
        </section>
      ) : null}
      {historyOpen && ws ? (
        <ul className="script-history">
          {ws.history.length ? ws.history.slice().reverse().map((node) => (
            <li key={node.id}>
              <span>{new Date(node.ts).toLocaleString()} · {STAGE_LABELS[node.stage]} · {node.summary || node.action} · {node.chars ?? 0} 字{node.named ? ' · 已命名' : ''}</span>
              {node.snapshot ? <button type="button" className="btn text-[11px]" onClick={() => {
                const restored = restoreSnapshot(ws, node)
                if (!restored) return
                commitBoth(restored, node.snapshot?.script || '')
                setViewingId(null)
              }}>恢复到这里</button> : <span>这一条没有可恢复快照</span>}
              {node.snapshot ? <button type="button" className="btn text-[11px]" onClick={() => {
                const restored = restoreSnapshot(ws, node)
                if (!restored) return
                const branched = {
                  ...restored,
                  history: [...ws.history, {
                    id: `h_branch_${Date.now().toString(36)}`,
                    parent_id: node.id,
                    stage: node.stage,
                    substep: node.substep,
                    action: '从这里修改',
                    summary: `从${STAGE_LABELS[node.stage]}修改`,
                    ts: Date.now(),
                    named: true,
                    chars: node.chars,
                    snapshot: node.snapshot,
                  }],
                }
                commitBoth(branched, node.snapshot?.script || '')
                setViewingId(null)
              }}>从这里修改</button> : null}
            </li>
          )) : <li>还没有可恢复的确认或编辑记录</li>}
        </ul>
      ) : null}

      {wizard && ws?.mode === 'chain' ? (
        <ScriptChain
          ws={ws}
          onPatch={(next) => patchScriptWorkspace(next)}
          onWrite={(text) => commitBoth({
            ...ws,
            chain_step: 'draft',
            stage: 'E',
            substep: 'E.expand',
            topic: ws.topic ?? { title: ws.user_brief.trim(), core_claim: ws.user_brief.trim(), angle: ws.track },
          }, text)}
        />
      ) : null}
      <textarea
        ref={ref}
        className="script-memo-text"
        data-script-memo
        data-testid="script-memo-text"
        hidden={wizard && ws?.mode === 'chain' && ws.chain_step !== 'draft'}
        value={viewingId ? (ws?.history.find((node) => node.id === viewingId)?.snapshot?.script ?? script) : script}
        readOnly={!!viewingId}
        spellCheck={false}
        placeholder={'这里只编辑要朗读的正文。项目、素材、大纲和发布信息在创作设定里。'}
        onChange={(e) => {
          setScript(e.target.value)
          persistView()
        }}
        onSelect={syncSel}
        onKeyUp={syncSel}
        onMouseUp={syncSel}
        onScroll={persistView}
        onBlur={() => { persistView(); sealScriptEdit() }}
      />
      {viewingId ? <button type="button" className="btn text-[11px]" onClick={() => setViewingId(null)}>返回当前正文</button> : null}
      {wizard && ws?.substep === 'F.package' ? (
        <div className="script-deliver">
          <button type="button" className="btn text-[11px]" onClick={() => {
            const live = useApp.getState()
            live.sealScriptEdit()
            live.setVoiceSeed({ text: readSpokenBody(live.script, live.scriptMemo), revision: live.scriptMemo?.revision ?? live.scriptWorkspace?.revision ?? 0, projectId: live.projectId })
            live.setLibraryTab('voice')
            live.toggleScript(false)
          }}>去配音</button>
          <button type="button" className="btn text-[11px]" onClick={() => {
            const pkg = ws.package
            useApp.getState().setCoverSeed({
              title: pkg?.titles[0] || ws.topic?.title || projectName,
              coverText: pkg?.cover_texts[0] || '',
              theme: ws.topic?.core_claim || ws.user_brief || '',
              visual: '竖版封面，标题画进画面',
              revision: scriptMemo?.revision ?? ws.revision,
            })
            useApp.getState().setModal('douyin')
            useApp.getState().toggleScript(false)
          }}>生成封面</button>
          <button type="button" className="btn text-[11px]" onClick={() => {
            const pkg = ws.package
            useApp.getState().setPublishSeed({
              title: pkg?.titles[0] || '',
              description: pkg?.description || '',
              tags: pkg?.hashtags || [],
              body: spoken,
              revision: scriptMemo?.revision ?? ws.revision,
              projectId,
            })
            useApp.getState().setModal('douyin')
            useApp.getState().toggleScript(false)
          }}>去发布准备</button>
        </div>
      ) : null}

      {wizard && ws && ws.mode !== 'chain' ? (
        <ScriptStageAskDock
          stageLabel={`${ws.stage} ${STAGE_LABELS[ws.stage]}`}
          substep={ws.substep}
          card={card}
          selectedIds={ws.selected_ids}
          customText={ws.custom_text}
          busy={stageBusy}
          error={stageError}
          pasteMat={pasteMat}
          onPasteMat={setPasteMat}
          onPasteSubmit={runMaterialsFromPaste}
          onPasteSkip={() => {
            if (!ws) return
            commitBoth({ ...ws, analogy_only: true, current_card: null })
            autoGenKey.current = ''
            void generateCard({ ...ws, analogy_only: true, current_card: null }, '用户声明仅创作类比，不要编造可核验数据')
          }}
          onToggle={toggleSelect}
          onCustom={(t) => patchScriptWorkspace({ custom_text: t })}
          onClearSelect={() => patchScriptWorkspace({ selected_ids: [] })}
          onRank={(ids) => patchScriptWorkspace({ selected_ids: ids })}
          onAdoptCustom={adoptCustom}
          onFactAction={(id, action) => {
            if (!ws || !card) return
            const opt = card.options.find((item) => String(item.id) === id)
            const claim = String(opt?.claim || opt?.content || '')
            const status = (opt?.status === 'mismatch' || opt?.status === 'missing' || opt?.status === 'limit' || opt?.status === 'ok') ? opt.status : 'missing'
            const result = applyFactAction(ws, spoken, { id, claim, status }, action, { source: ws.custom_text, text: ws.custom_text })
            if (result.error) { setStageError(result.error); return }
            commitBoth(result.ws, result.body)
            setStageError(null)
          }}
          onFormChange={(key, value) => {
            if (!card || stageBusy) return
            const update = (fields: typeof card.options) => fields.map(field => String(field.key || field.id) === key ? { ...field, suggested: value } : field)
            patchScriptWorkspace({ current_card: { ...card, options: update(card.options), ...(card.fields ? { fields: update(card.fields) } : {}) } })
          }}
          onConfirm={() => { void confirmCard() }}
          onRegen={() => {
            autoGenKey.current = ''
            void generateCard({ ...ws, current_card: null }, ws.custom_text || undefined)
          }}
          onSkip={['C.questions', 'C.materials', 'E.polish'].includes(ws.substep) ? () => { void skipOrAuto() } : undefined}
        />
      ) : null}

      {bar.visible ? (
        <div
          className="script-ai-bar"
          data-testid="script-ai-bar"
          style={{ left: bar.x, top: bar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button type="button" className="script-ai-ico" title="改写选区" data-testid="script-ai-rewrite" disabled={busy} onClick={() => openPanel('rewrite')}>
            <PencilLine size={14} />
          </button>
          <button type="button" className="script-ai-ico" title="在光标处插入" data-testid="script-ai-insert" disabled={busy} onClick={() => openPanel('insert')}>
            <Plus size={14} />
          </button>
          {!wizard ? (
            <>
              <button type="button" className="script-ai-ico" title="名词解释" data-testid="script-ai-explain" disabled={busy || !hasSel} onClick={() => openPanel('explain')}>
                <BookOpen size={14} />
              </button>
              <button type="button" className="script-ai-ico" title="针对选区提问" data-testid="script-ai-ask" disabled={busy || !hasSel} onClick={() => openPanel('ask')}>
                <Sparkles size={14} />
              </button>
            </>
          ) : null}
          {busy ? <CreativeProgress theme="type" compact className="w-[88px]" label="AI…" /> : null}
        </div>
      ) : null}

      {panel && (
        <div
          className="script-ai-panel"
          data-testid="script-ai-panel"
          style={{ left: Math.min(bar.x, window.innerWidth - 340), top: Math.min(bar.y + 40, window.innerHeight - 160) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="script-ai-panel-head">
            <span>
              {panel === 'rewrite' ? '改写' : panel === 'insert' ? '插入' : panel === 'explain' ? '名词解释' : '提问'}
            </span>
            <button type="button" className="icon-btn" aria-label="关闭" onClick={closeAiPanel}>
              <X size={12} />
            </button>
          </div>
          {panel !== 'explain' || !reply ? (
            <div className="flex gap-1.5">
              <input
                className="input flex-1 text-[12px]"
                data-testid="script-ai-instruction"
                autoFocus={panel !== 'explain'}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={
                  panel === 'rewrite' ? (hasSel ? '怎么改？如：更口语、再短' : '改写全文指示…')
                    : panel === 'insert' ? '插入什么？如：补一句过渡'
                      : panel === 'ask' ? '想问什么？'
                        : '可选：补充想了解的角度'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void runAi(panel)
                  }
                }}
              />
              <button type="button" className="btn btn-primary text-[11px] shrink-0" data-testid="script-ai-run" disabled={busy} onClick={() => { void runAi(panel) }}>
                {busy ? '…' : '发送'}
              </button>
            </div>
          ) : null}
          {busy ? <CreativeProgress theme="type" compact label="口播 AI 思考中…" /> : null}
          {error ? <div className="script-ai-msg err" data-testid="script-ai-error">{error}</div> : null}
          {reply ? <div className="script-ai-msg" data-testid="script-ai-reply">{reply}</div> : null}
          {pendingRewrite ? (
            <div className="script-ai-msg">
              <p>{pendingRewrite.note}</p>
              <p>修改后：{pendingRewrite.text}</p>
              {pendingRewrite.canApply ? <button type="button" className="btn btn-primary text-[11px]" onClick={applyPendingRewrite}>应用这次修改</button> : (
                <button type="button" className="btn text-[11px]" onClick={() => { void navigator.clipboard.writeText(pendingRewrite.text) }}>复制建议</button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
