import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, Loader2, NotebookPen, PencilLine, Plus, Sparkles, X } from 'lucide-react'
import { useApp } from '../store'
import { requestScriptAi, type ScriptAiMode } from '../lib/scriptAi'

/** 口播语速按每秒约 4.5 字估算 */
const CHARS_PER_SEC = 4.5

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

function countChars(text: string) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
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

/** textarea 光标/选区末端相对页面的大致坐标 */
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

/** 口播备忘录：恢复光标/滚动；AI 为选区旁渐进快捷栏 */
export function ScriptMemo() {
  const script = useApp((s) => s.script)
  const projectId = useApp((s) => s.projectId)
  const projectName = useApp((s) => s.projectName)
  const setScript = useApp((s) => s.setScript)
  const toggleScript = useApp((s) => s.toggleScript)
  const ref = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<Sel>({ start: 0, end: 0, text: '' })
  const [bar, setBar] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false })
  const [panel, setPanel] = useState<PanelMode>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const restored = useRef(false)

  const persistView = useCallback(() => {
    const el = ref.current
    if (!el) return
    saveView(projectId, {
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
      scrollTop: el.scrollTop,
    })
  }, [projectId])

  const closeMemo = useCallback(() => {
    persistView()
    toggleScript(false)
  }, [persistView, toggleScript])

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
      setSel(readSel(el))
      // 下一帧再算浮栏位置（等 scroll 生效）
      requestAnimationFrame(() => placeBar(el))
    } else {
      const end = el.value.length
      el.setSelectionRange(end, end)
      setSel({ start: end, end, text: '' })
    }
  }, [projectId])

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

  function placeBar(el: HTMLTextAreaElement) {
    const cur = readSel(el)
    const idx = cur.end > cur.start ? cur.end : cur.start
    const pos = caretPagePos(el, idx)
    const pad = 8
    const x = Math.min(window.innerWidth - 220, Math.max(12, pos.x))
    const y = Math.min(window.innerHeight - 48, Math.max(56, pos.y + pad))
    setBar({ x, y, visible: true })
    setSel(cur)
  }

  const syncSel = useCallback(() => {
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
    setScript(next)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(selectFrom, selectTo)
      setSel(readSel(el))
      persistView()
      placeBar(el)
    })
  }

  const openPanel = (m: ScriptAiMode) => {
    setPanel(m)
    setReply(null)
    setError(null)
    setInstruction(
      m === 'explain' ? ''
        : m === 'insert' ? ''
          : m === 'ask' ? ''
            : '',
    )
    // 名词解释：有选区直接跑
    if (m === 'explain') {
      const el = ref.current
      const cur = readSel(el)
      if (cur.text.trim()) void runAi('explain', '')
    }
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
    setBusy(true)
    setError(null)
    setReply(null)
    try {
      const instr = (instrOverride ?? instruction).trim() || undefined
      const result = await requestScriptAi({
        mode: m,
        fullText: el.value,
        selection: cur.text || undefined,
        instruction: instr,
        cursorBefore: el.value.slice(0, cur.start),
        cursorAfter: el.value.slice(cur.end),
      })
      if (m === 'ask' || m === 'explain') {
        setReply(result.reply)
        return
      }
      if (m === 'rewrite') {
        if (cur.text) {
          const next = el.value.slice(0, cur.start) + result.text + el.value.slice(cur.end)
          applyText(next, cur.start, cur.start + result.text.length)
        } else {
          applyText(result.text, 0, result.text.length)
        }
        setReply(result.reply || '已改写')
        setPanel(null)
        return
      }
      const next = el.value.slice(0, cur.start) + result.text + el.value.slice(cur.end)
      applyText(next, cur.start, cur.start + result.text.length)
      setReply(result.reply || '已插入')
      setPanel(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const chars = countChars(script)
  const hasSel = sel.end > sel.start

  return (
    <div className="script-memo" data-testid="script-memo" ref={wrapRef}>
      <header className="script-memo-head">
        <NotebookPen size={15} style={{ color: 'var(--accent)' }} />
        <span className="font-medium" style={{ fontFamily: 'var(--font-display)' }}>口播稿</span>
        <span className="truncate" style={{ color: 'var(--text-muted)' }}>· {projectName}</span>
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {chars} 字 · 约 {fmtDuration(chars / CHARS_PER_SEC)}
          {hasSel ? ` · 已选 ${countChars(sel.text)} 字` : ''}
        </span>
        <span className="script-memo-key">~ 返回剪辑</span>
        <button className="icon-btn" onClick={closeMemo} aria-label="返回剪辑"><X size={14} /></button>
      </header>

      <textarea
        ref={ref}
        className="script-memo-text"
        data-script-memo
        data-testid="script-memo-text"
        value={script}
        spellCheck={false}
        placeholder={'把口播稿粘贴到这里…\n\n选中文字或点一下光标，旁侧会出现 AI 快捷栏。\n内容与光标位置会随项目记住，按 ~ 切回剪辑再回来仍在原处。'}
        onChange={(e) => {
          setScript(e.target.value)
          persistView()
        }}
        onSelect={syncSel}
        onKeyUp={syncSel}
        onMouseUp={syncSel}
        onScroll={persistView}
        onBlur={persistView}
      />

      {bar.visible && (
        <div
          className="script-ai-bar"
          data-testid="script-ai-bar"
          style={{ left: bar.x, top: bar.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="script-ai-ico"
            title="改写选区"
            data-testid="script-ai-rewrite"
            disabled={busy}
            onClick={() => openPanel('rewrite')}
          >
            <PencilLine size={14} />
          </button>
          <button
            type="button"
            className="script-ai-ico"
            title="在光标处插入"
            data-testid="script-ai-insert"
            disabled={busy}
            onClick={() => openPanel('insert')}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="script-ai-ico"
            title="名词解释"
            data-testid="script-ai-explain"
            disabled={busy || !hasSel}
            onClick={() => openPanel('explain')}
          >
            <BookOpen size={14} />
          </button>
          <button
            type="button"
            className="script-ai-ico"
            title="针对选区提问"
            data-testid="script-ai-ask"
            disabled={busy || !hasSel}
            onClick={() => openPanel('ask')}
          >
            <Sparkles size={14} />
          </button>
          {busy ? <Loader2 size={13} className="animate-spin script-ai-spin" /> : null}
        </div>
      )}

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
            <button type="button" className="icon-btn" aria-label="关闭" onClick={() => { setPanel(null); setReply(null); setError(null) }}>
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
              <button
                type="button"
                className="btn btn-primary text-[11px] shrink-0"
                data-testid="script-ai-run"
                disabled={busy}
                onClick={() => { void runAi(panel) }}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : '发送'}
              </button>
            </div>
          ) : null}
          {error ? <div className="script-ai-msg err" data-testid="script-ai-error">{error}</div> : null}
          {reply ? <div className="script-ai-msg" data-testid="script-ai-reply">{reply}</div> : null}
        </div>
      )}
    </div>
  )
}
