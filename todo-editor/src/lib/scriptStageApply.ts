/**
 * 将用户确认结果写回 ScriptWorkspace，并推进子步骤。
 */
import {
  FIELD_LABELS,
  draftFullText,
  materialGateOk,
  nextSubstepAfterConfirm,
  pushHistory,
  stripMaterialMarks,
  targetChars,
  type FactAction,
  type MaterialItem,
  type OutlineSeg,
  type ProjectCard,
  type ScriptCard,
  type ScriptOption,
  type ScriptWorkspace,
  type Topic,
  unresolvedFacts,
} from './scriptWorkspace'

function optContent(o?: ScriptOption): string {
  if (!o) return ''
  if (typeof o.content === 'string') return o.content
  if (o.content != null) {
    try { return JSON.stringify(o.content) } catch { return String(o.content) }
  }
  return o.title || ''
}

function asOutline(content: unknown): OutlineSeg[] {
  if (!Array.isArray(content)) return []
  return content.map((raw, i) => {
    const s = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    return {
      id: String(s.id || `p${i + 1}`),
      role: String(s.role || ''),
      key_point: String(s.key_point || s.keyPoint || ''),
      target_chars: Math.max(20, Number(s.target_chars || s.targetChars) || 80),
      material_ids: Array.isArray(s.material_ids) ? s.material_ids.map(String) : [],
      emotion: s.emotion != null ? String(s.emotion) : undefined,
      locked: false,
    }
  })
}

function materialsFromOptions(opts: ScriptOption[]): MaterialItem[] {
  return opts.map((o, i) => {
    const tags = (o.tags || []).map(String)
    const type = (['data', 'case', 'analogy', 'authority'].find((t) => tags.includes(t)) || 'other') as MaterialItem['type']
    const cred = tags.includes('high') ? 'high' : tags.includes('low') ? 'low' : 'mid'
    return {
      id: String(o.id || `m${i + 1}`),
      type,
      content: optContent(o),
      source: String(o.reason || o.source || '用户资料'),
      date: o.date != null ? String(o.date) : undefined,
      credibility: (o.credibility as MaterialItem['credibility']) || cred,
      verified: false,
      provenance: type === 'analogy' ? 'analogy' : String(o.source || o.reason || '').trim() ? 'sourced' : 'pending',
    }
  })
}

export function applyFormConfirm(ws: ScriptWorkspace, card: ScriptCard, selectedIds: string[]): ScriptWorkspace {
  const fields = card.fields || card.options
  const map: Record<string, unknown> = {}
  for (const f of fields) {
    const key = String(f.key || f.id || '')
    if (!key) continue
    // 若用户点了某 choices，selected 可能是 choice 文本；否则用 suggested
    map[key] = f.suggested
  }
  // selected_ids 若匹配 choices 中的值，覆盖对应 field——简化：用全部 suggested
  const duration = Math.max(15, Number(map.duration_sec) || 90)
  const tabooRaw = map.taboo
  const taboo = Array.isArray(tabooRaw)
    ? tabooRaw.map(String)
    : String(tabooRaw || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  const cardOut: ProjectCard = {
    platform: String(map.platform || '抖音'),
    duration_sec: duration,
    target_chars: Number(card.target_chars) || targetChars(duration),
    audience: String(map.audience || '短视频观众'),
    persona: String(map.persona || '靠谱朋友'),
    goal: String(map.goal || '涨粉'),
    taboo,
  }
  // 允许用户在 selected 里改：若 option id 是 key 且 content 有值
  for (const id of selectedIds) {
    const f = fields.find((x) => String(x.key || x.id) === id || String(x.id) === id)
    if (!f) continue
    const k = String(f.key || f.id)
    const val = f.suggested ?? optContent(f)
    if (k === 'duration_sec') cardOut.duration_sec = Math.max(15, Number(val) || cardOut.duration_sec)
    else if (k === 'platform') cardOut.platform = String(val)
    else if (k === 'audience') cardOut.audience = String(val)
    else if (k === 'persona') cardOut.persona = String(val)
    else if (k === 'goal') cardOut.goal = String(val)
  }
  cardOut.target_chars = targetChars(cardOut.duration_sec)
  if (!cardOut.platform.trim() || !cardOut.audience.trim()) {
    throw new Error('请填写平台和受众')
  }
  if (cardOut.duration_sec < 15 || cardOut.duration_sec > 600) {
    throw new Error('时长需要在 15 到 600 秒之间')
  }
  const stale = hasSpokenBody(ws)
  let next = pushHistory({
    ...ws,
    project_card: cardOut,
    stale_settings: stale || ws.stale_settings,
    stale_from: stale ? 'A' : ws.stale_from,
  }, 'confirm:A', ws.body)
  const adv = nextSubstepAfterConfirm(next)
  next = { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' }
  return next
}

export function applyTopicConfirm(ws: ScriptWorkspace, opt: ScriptOption): ScriptWorkspace {
  const topic: Topic = {
    title: String(opt.title || ''),
    core_claim: optContent(opt),
    angle: (opt.tags && opt.tags[0]) || '',
    scores: opt.scores,
    risk: opt.risk,
  }
  let next = pushHistory({ ...ws, topic }, 'confirm:B')
  const adv = nextSubstepAfterConfirm(next)
  return { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' }
}

export function applyQuestionsConfirm(ws: ScriptWorkspace, opts: ScriptOption[]): ScriptWorkspace {
  const questions = opts.map((o, i) => ({
    id: String(o.id || `q${i + 1}`),
    text: String(o.title || optContent(o)),
    priority: ((o.tags || []).includes('must') ? 'must' : 'nice') as 'must' | 'nice',
    keywords: typeof o.content === 'string' ? o.content : undefined,
  }))
  let next = pushHistory({ ...ws, questions }, 'confirm:C.questions')
  const adv = nextSubstepAfterConfirm(next)
  return { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' }
}

export function applyMaterialsConfirm(ws: ScriptWorkspace, opts: ScriptOption[]): { ws: ScriptWorkspace; error?: string } {
  const bank = materialsFromOptions(opts)
  let next: ScriptWorkspace = { ...ws, material_bank: bank }
  const gate = materialGateOk(next)
  if (!gate.ok) return { ws: next, error: gate.reason }
  next = pushHistory(next, 'confirm:C.materials')
  const adv = nextSubstepAfterConfirm(next)
  return {
    ws: { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' },
  }
}

/** 用户直接粘贴素材文本时的本地入库（不经 AI） */
export function applyPastedMaterials(ws: ScriptWorkspace, text: string): ScriptWorkspace {
  const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const bank: MaterialItem[] = blocks.map((b, i) => {
    const m = b.match(/来源[:：]\s*(.+)$/m)
    return {
      id: `m${i + 1}`,
      type: /\d/.test(b) ? 'data' : 'case',
      content: b.replace(/\n来源[:：].+$/m, '').trim(),
      source: m?.[1]?.trim() || '',
      credibility: m ? 'mid' : 'low',
      verified: false,
      provenance: m ? 'sourced' : 'pending',
    }
  })
  return { ...ws, material_bank: bank.length ? bank : ws.material_bank }
}

export function applyHookConfirm(ws: ScriptWorkspace, opt: ScriptOption): ScriptWorkspace {
  const hook = { type: String(opt.title || ''), text: optContent(opt) }
  let next = pushHistory({ ...ws, hook }, 'confirm:D.hook')
  const adv = nextSubstepAfterConfirm(next)
  return { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' }
}

export function applyLogicConfirm(ws: ScriptWorkspace, card: ScriptCard, logicFromAi?: ScriptWorkspace['logic_line']): ScriptWorkspace {
  let logic = logicFromAi || null
  const fields = card.fields?.length ? card.fields : card.options
  if (fields.length) {
    const claim = fields.find((f) => f.key === 'claim' || f.id === 'claim')
    const qs = fields.filter((f) => /^q\d/i.test(String(f.key || f.id)))
    const nails = fields.filter((f) => /^nail/i.test(String(f.key || f.id)))
    const original = logic
    logic = {
      claim: claim ? String(claim.suggested ?? optContent(claim)) : original?.claim || '',
      next_questions: qs.length ? qs.map((q, i) => ({ id: String(q.key || q.id || `q${i + 1}`), text: String(q.suggested ?? optContent(q)) })) : original?.next_questions || [],
      nails: nails.length ? nails.map((n, i) => {
        const questionId = qs[i] ? String(qs[i].key || qs[i].id) : original?.next_questions[i]?.id || `q${i + 1}`
        return {
          question_id: questionId,
          material_ids: original?.nails.find(item => item.question_id === questionId)?.material_ids || [],
          note: String(n.suggested ?? optContent(n)),
        }
      }) : original?.nails || [],
    }
  }
  let next = pushHistory({ ...ws, logic_line: logic }, 'confirm:D.logic')
  const adv = nextSubstepAfterConfirm(next)
  return { ...next, stage: adv.stage, substep: adv.substep, current_card: null, selected_ids: [], custom_text: '' }
}

function hasSpokenBody(ws: ScriptWorkspace) {
  return !!ws.body.trim() || ws.draft.some((seg) => seg.versions.some((v) => v.text.trim()))
}

function placeOutline(prev: OutlineSeg[], next: OutlineSeg[]): OutlineSeg[] {
  const locked = prev.filter((seg) => seg.locked)
  if (!locked.length) return next
  const unlocked = next.filter((seg) => !locked.some((item) => item.id === seg.id))
  const ordered = [...unlocked]
  for (const seg of locked) {
    const incoming = next.find((item) => item.id === seg.id) || seg
    const at = prev.findIndex((item) => item.id === seg.id)
    ordered.splice(Math.max(0, Math.min(at, ordered.length)), 0, { ...incoming, locked: true, material_ids: seg.material_ids })
  }
  return ordered
}

export function applyOutlineConfirm(ws: ScriptWorkspace, opt: ScriptOption): ScriptWorkspace {
  const outline = placeOutline(ws.outline, asOutline(opt.content))
  const draft = [
    ...outline.map((seg) => {
      const prev = ws.draft.find((item) => item.id === seg.id)
      if (prev) return prev.locked === !!seg.locked ? prev : { ...prev, locked: !!seg.locked }
      return {
        id: seg.id,
        versions: [] as ScriptWorkspace['draft'][0]['versions'],
        current: 0,
        locked: !!seg.locked,
      }
    }),
    ...ws.draft.filter((item) => item.locked && !outline.some((seg) => seg.id === item.id)),
  ]
  let next = pushHistory({ ...ws, outline, draft, expand_index: 0 }, 'confirm:D.outline', ws.body)
  const adv = nextSubstepAfterConfirm(next)
  return {
    ws: {
      ...next,
      stage: adv.stage,
      substep: adv.substep,
      expand_index: adv.expand_index ?? 0,
      current_card: null,
      selected_ids: [],
      custom_text: '',
    },
  }.ws
}

export function applyExpandConfirm(ws: ScriptWorkspace, opt: ScriptOption): ScriptWorkspace {
  const seg = ws.outline[ws.expand_index]
  if (!seg) return ws
  const text = stripMaterialMarks(optContent(opt))
  const versions = [{ v: 1, stage: 'filled', text, self_check: opt.self_check }]
  const draft = ws.draft.map((d) => (d.id === seg.id ? { ...d, versions, current: 1 } : d))
  // 若尚无该段
  const has = draft.some((d) => d.id === seg.id)
  const nextDraft = has ? draft : [...draft, { id: seg.id, versions, current: 1 }]
  let next = pushHistory({ ...ws, draft: nextDraft }, `confirm:E.expand:${seg.id}`)
  const adv = nextSubstepAfterConfirm(next)
  return {
    ...next,
    stage: adv.stage,
    substep: adv.substep,
    expand_index: adv.expand_index ?? next.expand_index,
    current_card: null,
    selected_ids: [],
    custom_text: '',
  }
}

export function applyPolishConfirm(ws: ScriptWorkspace, card: ScriptCard, acceptedIds: string[]): { ws: ScriptWorkspace; script: string } {
  const activeIds = ws.outline.length ? new Set(ws.outline.map(seg => seg.id)) : null
  const textById = new Map(ws.draft.map(segment => {
    const version = segment.versions.find(v => v.v === segment.current) || segment.versions.at(-1)
    return [segment.id, version?.text || '']
  }))
  for (const diff of card.options.filter(option => acceptedIds.includes(String(option.id)))) {
    const before = String(diff.before || '')
    const after = String(diff.after || '')
    const matches = [...textById].filter(([id, text]) => (!activeIds || activeIds.has(id)) && before && text.includes(before))
    if (matches.length !== 1 || matches[0][1].indexOf(before) !== matches[0][1].lastIndexOf(before)) {
      throw new Error('修改位置不明确或原文已变化，请重新生成本步；跨段修改请拆成逐段建议')
    }
    const [id, text] = matches[0]
    if (ws.draft.find(segment => segment.id === id)?.locked || ws.outline.find(segment => segment.id === id)?.locked) {
      throw new Error('这条修改涉及已锁定段落，请取消该建议后继续')
    }
    textById.set(id, text.replace(before, () => after))
  }
  const draft = ws.draft.map(segment => {
    const previous = segment.versions.find(v => v.v === segment.current) || segment.versions.at(-1)
    const text = textById.get(segment.id) || ''
    if (text === (previous?.text || '')) return segment
    const v = Math.max(0, ...segment.versions.map(version => version.v)) + 1
    return { ...segment, current: v, versions: [...segment.versions, { v, stage: 'colloquial', text }] }
  })
  const text = draftFullText({ ...ws, draft })
  let next = pushHistory({ ...ws, draft }, 'confirm:E.polish')
  const adv = nextSubstepAfterConfirm(next)
  next = {
    ...next,
    stage: adv.stage,
    substep: adv.substep,
    current_card: null,
    selected_ids: [],
    custom_text: '',
  }
  return { ws: next, script: stripMaterialMarks(text) }
}

export function applyFactAction(
  ws: ScriptWorkspace,
  body: string,
  fact: { id: string; claim: string; status: 'ok' | 'limit' | 'missing' | 'mismatch'; paragraph_id?: string },
  action: FactAction,
  payload?: { source?: string; text?: string },
): { ws: ScriptWorkspace; body: string; error?: string } {
  const claim = fact.claim.trim()
  let nextBody = body
  let error: string | undefined
  if (action === 'delete' || action === 'soften') {
    if (!claim || body.indexOf(claim) < 0 || body.indexOf(claim) !== body.lastIndexOf(claim)) {
      error = '找不到这句唯一的原文，没有改动正文'
    } else if (action === 'delete') {
      nextBody = body.replace(claim, '')
    } else {
      const softened = (payload?.text || '').trim()
      if (!softened || softened === claim) error = '改写后的句子需要和原句不同'
      else nextBody = body.replace(claim, softened)
    }
    if (!error && nextBody === body) error = '句子没有改动，不能标成已处理'
  } else if (action === 'add_source') {
    const source = (payload?.source || '').trim()
    if (!source) error = '请补上资料出处'
  } else if (action === 'human_verify') {
    /* 人工核验是明确动作，允许句子保持不变。 */
  }
  if (error) return { ws, body, error }
  const revision = ws.revision + 1
  const facts = ws.fact_check.some((item) => item.id === fact.id)
    ? ws.fact_check.map((item) => item.id === fact.id
      ? { ...item, resolved: true, resolution: { action, at_revision: revision, source: payload?.source }, body_revision: revision, paragraph_id: fact.paragraph_id || item.paragraph_id }
      : item)
    : [...ws.fact_check, {
      id: fact.id,
      claim: fact.claim,
      status: fact.status,
      paragraph_id: fact.paragraph_id,
      body_revision: revision,
      resolved: true,
      resolution: { action, at_revision: revision, source: payload?.source },
    }]
  let material_bank = ws.material_bank
  if (action === 'add_source') {
    material_bank = [...material_bank, {
      id: `src_${fact.id}`,
      type: 'other' as const,
      content: claim || '补充来源',
      source: payload?.source || '',
      credibility: 'mid' as const,
      verified: false,
      provenance: 'sourced' as const,
    }]
  }
  if (action === 'human_verify') {
    material_bank = material_bank.map((item) => item.id === fact.id || item.content === claim
      ? { ...item, verified: true, provenance: 'human_verified' as const }
      : item)
  }
  return {
    body: nextBody,
    ws: { ...ws, fact_check: facts, material_bank, revision, body: nextBody },
  }
}

export function applyFactConfirm(ws: ScriptWorkspace, card: ScriptCard, resolvedIds: string[]): { ws: ScriptWorkspace; error?: string } {
  const facts = (card.options || []).map((o) => {
    const id = String(o.id)
    const prev = ws.fact_check.find((item) => item.id === id)
    const status = (o.status || 'ok') as 'ok' | 'limit' | 'missing' | 'mismatch'
    const carried = prev?.resolution && prev.resolution.at_revision === ws.revision ? prev.resolution : undefined
    return {
      id,
      claim: String(o.claim || o.content || ''),
      status,
      material_id: o.material_id != null ? String(o.material_id) : undefined,
      location: o.location != null ? String(o.location) : undefined,
      paragraph_id: prev?.paragraph_id,
      body_revision: ws.revision,
      fix_options: o.fix_options,
      resolved: status === 'ok' || status === 'limit' || !!carried,
      resolution: carried,
    }
  })
  void resolvedIds
  let next: ScriptWorkspace = { ...ws, fact_check: facts }
  const bad = unresolvedFacts(next)
  if (bad.length) {
    return { ws: next, error: `还有 ${bad.length} 条无来源或不一致的断言没处理。勾选本身不会改句子，请补充来源、改成非事实表达、删除原句或记录人工核验。` }
  }
  next = pushHistory(next, 'confirm:E.fact', next.body)
  const adv = nextSubstepAfterConfirm(next)
  return {
    ws: {
      ...next,
      stage: adv.stage,
      substep: adv.substep,
      current_card: null,
      selected_ids: [],
      custom_text: '',
    },
  }
}

export function applyPackageConfirm(ws: ScriptWorkspace, card: ScriptCard, selectedId: string): { ws: ScriptWorkspace; script: string } {
  const titleOpt = card.options.find((o) => String(o.id) === selectedId) || card.options[0]
  const titles = card.titles?.length
    ? card.titles
    : card.options.map((o) => optContent(o)).filter(Boolean)
  const picked = titleOpt ? optContent(titleOpt) : titles[0] || ''
  const ordered = picked ? [picked, ...titles.filter((t) => t !== picked)].slice(0, 3) : titles.slice(0, 3)
  const pkg = {
    titles: ordered,
    cover_texts: (card.cover_texts || []).slice(0, 3),
    description: card.description || '',
    hashtags: card.hashtags || [],
  }
  const body = stripMaterialMarks(draftFullText(ws)) || ws.body
  const next = pushHistory({
    ...ws,
    body,
    package: pkg,
    current_card: null,
    selected_ids: [],
    custom_text: '',
    active: false,
  }, 'confirm:F', body)
  return { ws: next, script: body }
}

export function optionLabel(o: ScriptOption): string {
  const key = String(o.key || '')
  if (o.title || o.label) return String(o.title || o.label)
  if (key && FIELD_LABELS[key]) return FIELD_LABELS[key]
  return '选项'
}
