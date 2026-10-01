/**
 * 口播分段层：长口播 → 口播段（每段一条配音、一组镜头）。
 *
 * 切分单位是「句」（句号 / 问号 / 叹号 / 分号 / 换行处断开；超长句再按逗号拆成分句）。空行是段落边界（优先在这里切），
 * 单独一行的 --- 是硬边界（一定切开，且不进配音）。
 * 三种模式：
 *   semantic  LLM 按意群决定在哪些句子前切开（只给句子编号，不改写原文），并顺带给出全片标题、各段小标题、反复出现的角色设定
 *   paragraph 按空行分段，过长的段落再按字数切
 *   length    只按字数切
 * 不论哪种模式，最后都过 enforceLimits：每段尽量接近目标字数、绝不超过上限，且不在承接句前切开
 * （「于是 / 所以 / 因为 / 而是 / 这叫…」开头的句子紧承上一句）。各段文字按顺序拼起来就是原文。
 */

/** 句首出现这些词：和上一句是一个意思，不能在它前面切 */
export const GLUE_RE = /^[“"「『（(]*(于是|所以|因为|而是|但是|可是|不过|然而|因此|这叫|这就是|这便是|说白了|也就是说|换句话说|换言之|比如|例如|结果|接着|然后|同时|并且|而且|甚至|否则|那么)/
const SENTENCE_END = /([。！？!?…；;]+[”’」』）)\]]*)/
const CLAUSE_END = /([，,、：:]+[”’」』）)\]]*)/

/** 计字：只数文字和数字 */
export const charCount = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length

/**
 * 文案 → 句子单位：{ text（原样，含标点和后随空白）, chars, para（其后是段落边界） }
 * @param {string} script
 * @param {number} clauseOver 超过这么多字的句子再按逗号拆开
 */
export function splitUnits(script, clauseOver = 100) {
  const units = []
  // 单独一行的 --- 是硬边界：一定换段，本身不朗读
  const blocks = String(script ?? '').replace(/\r\n?/g, '\n').split(/^[ \t]*-{3,}[ \t]*$/m)
  for (const block of blocks) {
    const before = units.length
    units.push(...blockUnits(block, clauseOver))
    if (units.length > before && before > 0) units[before - 1].hard = true
  }
  return units
}

function blockUnits(block, clauseOver) {
  const units = []
  const paras = block.replace(/^\s+|\s+$/g, '').split(/\n\s*\n/)
  for (const para of paras) {
    const lines = para.split('\n')
    const start = units.length
    for (const line of lines) {
      for (const sentence of splitBy(line, SENTENCE_END)) {
        if (charCount(sentence) > clauseOver) units.push(...splitBy(sentence, CLAUSE_END).map((t) => ({ text: t, clause: true })))
        else units.push({ text: sentence, clause: false })
      }
      // 行尾换行归给本行最后一句，拼回去仍是原文的分行
      if (units.length > start && lines.length > 1) units[units.length - 1].text += '\n'
    }
    if (units.length > start) {
      const last = units[units.length - 1]
      last.para = true
      last.text = `${last.text.replace(/\n+$/, '')}\n\n`
    }
  }
  return units
    .map((u) => ({ ...u, text: u.para ? u.text : u.text.replace(/\n+$/, '\n'), chars: charCount(u.text) }))
    .filter((u) => u.chars > 0 || u.text.trim())
    .reduce((out, u) => {
      // 纯标点 / 空白碎片并进前一句
      if (u.chars === 0 && out.length) {
        const last = out[out.length - 1]
        out[out.length - 1] = { ...last, text: last.text + u.text, para: last.para || u.para }
      } else out.push(u)
      return out
    }, [])
}

function splitBy(s, re) {
  const parts = String(s).split(re)
  const out = []
  for (let i = 0; i < parts.length; i += 2) {
    const t = (parts[i] ?? '') + (parts[i + 1] ?? '')
    if (t.trim()) out.push(t)
  }
  return out
}

const canCutBefore = (u) => !GLUE_RE.test(u.text.trimStart())

/**
 * 句子单位 + 切点（每段第一个单位的编号）→ 满足字数约束的切点。
 * 超上限的段在内部找最接近目标的可切点再切；过短的段（< 目标 30%）并进前一段（合并后不超上限时）。
 */
export function enforceLimits(units, starts, { target, max }) {
  const n = units.length
  let cuts = [...new Set([0, ...starts.filter((s) => Number.isInteger(s) && s > 0 && s < n)])].sort((a, b) => a - b)
  // 承接句前的切点挪到前面最近的可切点（挪不动就删掉）
  cuts = cuts.map((c) => {
    let k = c
    while (k > 0 && !canCutBefore(units[k])) k--
    return k
  })
  const hard = new Set(units.flatMap((u, i) => (u.hard && i + 1 < n ? [i + 1] : [])))
  cuts = [...new Set([...cuts, ...hard])].sort((a, b) => a - b)

  const len = (a, b) => units.slice(a, b).reduce((t, u) => t + u.chars, 0)
  const out = []
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i]
    const b = cuts[i + 1] ?? n
    out.push(...splitLong(units, a, b, target, max))
  }
  // 过短的段并进前一段（开场白这类第一段除外）
  const merged = []
  for (let i = 0; i < out.length; i++) {
    const a = out[i]
    const b = out[i + 1] ?? n
    if (merged.length && !hard.has(a) && len(a, b) < target * 0.3 && len(merged[merged.length - 1], b) <= max) continue
    merged.push(a)
  }
  return merged
}

/** [a, b) 超过 max 时按目标字数递归切开；切点优先段落边界、只落在可切句前 */
function splitLong(units, a, b, target, max) {
  let total = 0
  for (let i = a; i < b; i++) total += units[i].chars
  if (total <= max || b - a <= 1) return [a]
  let best = -1
  let bestScore = Infinity
  let acc = 0
  for (let i = a + 1; i < b; i++) {
    acc += units[i - 1].chars
    if (!canCutBefore(units[i])) continue
    const rest = total - acc
    if (acc > max && best >= 0) break
    // 离目标越近越好；段落边界、整句边界优先；剩下的部分太短也不好
    let score = Math.abs(acc - target)
    if (units[i - 1].para) score -= target * 0.25
    if (units[i - 1].clause) score += target * 0.15
    if (rest < target * 0.35) score += target
    if (acc > max) score += 10 * (acc - max)
    if (score < bestScore) { bestScore = score; best = i }
  }
  // 整段找不到可切点（全是承接句）：硬切在离目标最近的句子前，宁可断承接也不能超上限
  if (best < 0) {
    acc = 0
    for (let i = a + 1; i < b; i++) {
      acc += units[i - 1].chars
      if (best < 0 || Math.abs(acc - target) < bestScore) { bestScore = Math.abs(acc - target); best = i }
    }
  }
  return [...splitLong(units, a, best, target, max), ...splitLong(units, best, b, target, max)]
}

/** 启发式切点：按字数（paragraph=true 时每个段落边界都优先切开） */
export function heuristicStarts(units, { target, max, paragraph = false }) {
  const starts = [0]
  let len = 0
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    if (i > 0 && canCutBefore(u)) {
      const prev = units[i - 1]
      const atPara = prev.hard || (prev.para && len >= (paragraph ? target * 0.5 : target * 0.75))
      const full = len >= target * 0.6 && len + u.chars > target
      if (atPara || full || len + u.chars > max) {
        starts.push(i)
        len = 0
      }
    }
    len += u.chars
  }
  return enforceLimits(units, starts, { target, max })
}

export function buildSegmentMessages(units, { target, max, title }) {
  const lines = []
  for (const [i, u] of units.entries()) {
    lines.push(`[${i}] (${u.chars}字) ${u.text.trim().replace(/\n/g, ' ')}`)
    if (u.hard) lines.push('---')
    else if (u.para) lines.push('')
  }
  const system = [
    '你是口播短视频的剪辑编辑。一条长口播会被切成若干「口播段」，每段单独配音，并配一组边讲边画的画面。',
    '输入是编号后的句子表，每行「[编号] (字数) 句子」，空行是原文的段落边界。',
    '只输出一个 JSON 对象，不要解释：',
    '{',
    '  "title": "不超过 12 字的全片标题",',
    '  "cast": [ 反复出现的人物 / 角色（0~6 个），每个 { "name": "口播里的称呼", "look": "英文外观描述，≤120 字符，画成极简粉笔小人时的固定特征：身形、帽子、衣着、道具" } ],',
    '  "segments": [ 按顺序，每段 { "start": 这段从哪个句子编号开始（第一段必须是 0）, "title": "不超过 10 字的小标题" } ]',
    '}',
    '切分规则：',
    `1. 语意为主：一段讲完一个完整意群（一个场景 / 一个论点 / 一个概念的定义和解释）。尽量每段约 ${target} 字（按句子字数累加），完整意群可以略长，但硬上限 ${max} 字。不要为了凑字数切碎。`,
    '2. 空行是强边界，优先在段落边界切；「---」行是作者指定的换段点，那里必须切开。',
    '3. 不要在以「于是 / 所以 / 因为 / 而是 / 但是 / 这叫 / 这就是 / 说白了 / 也就是说」等承接词开头的句子前切开；「这叫××」和紧跟的人话定义必须在同一段。',
    '4. 开场白（自我介绍、抛问题）可以单独成短段；结尾的总结、关注引导也可以单独成段。',
    '5. 只决定在哪切，不改写、不增删原文。',
    title ? `全片暂定标题：${title}` : '',
  ].filter(Boolean).join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }]
}

const clean = (v, max) => String(v ?? '').replace(/[{}\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function sanitizeOutline(raw, units, limits) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!r) throw new Error('分段结果不是对象')
  const list = (Array.isArray(r.segments) ? r.segments : [])
    .map((s) => ({ start: Math.round(Number(s?.start)), title: clean(s?.title, 10) }))
    .filter((s) => Number.isInteger(s.start) && s.start >= 0 && s.start < units.length)
  if (!list.length) throw new Error('分段结果里没有段')
  const titleAt = new Map(list.map((s) => [s.start, s.title]))
  const starts = enforceLimits(units, list.map((s) => s.start), limits)
  const cast = (Array.isArray(r.cast) ? r.cast : [])
    .map((c) => ({ name: clean(c?.name, 12), look: clean(c?.look, 160) }))
    .filter((c) => c.name && c.look)
    .slice(0, 6)
  return { title: clean(r.title, 12), cast, starts, titles: starts.map((s) => titleAt.get(s) ?? '') }
}

/** 切点 → 段文本（原文按顺序摘取，段内保留换行，去掉首尾空白） */
export function segmentTexts(units, starts) {
  return starts.map((a, i) => units.slice(a, starts[i + 1] ?? units.length).map((u) => u.text).join('').trim())
}

/**
 * @param {string} script 已清洗的口播
 * @param {{ mode: 'semantic'|'paragraph'|'length', target: number, max: number, chat?: (messages) => Promise<any>, title?: string }} o
 * @returns {Promise<{ title: string, cast: {name: string, look: string}[], segments: { text: string, title: string }[], source: string, notes: string }>}
 */
export async function segmentScript(script, o) {
  const limits = { target: o.target, max: o.max }
  const units = splitUnits(script, Math.min(o.max, Math.max(60, Math.round(o.target * 0.9))))
  if (!units.length) throw new Error('口播里没有可朗读的文字')
  const pack = (starts, titles, source, notes, title = '', cast = []) => ({
    title, cast, source, notes,
    segments: segmentTexts(units, starts).map((text, i) => ({ text, title: titles[i] ?? '' })),
  })
  if (o.mode === 'semantic' && o.chat && units.length > 1) {
    try {
      const outline = sanitizeOutline(await o.chat(buildSegmentMessages(units, { ...limits, title: o.title })), units, limits)
      return pack(outline.starts, outline.titles, 'ai', '', outline.title, outline.cast)
    } catch (e) {
      const starts = heuristicStarts(units, { ...limits, paragraph: true })
      return pack(starts, [], 'fallback', `AI 分段失败，改按段落 + 字数切：${String(e instanceof Error ? e.message : e).slice(0, 80)}`)
    }
  }
  const starts = heuristicStarts(units, { ...limits, paragraph: o.mode !== 'length' })
  return pack(starts, [], o.mode === 'length' ? 'length' : 'paragraph', '')
}
