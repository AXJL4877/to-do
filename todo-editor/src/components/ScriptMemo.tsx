import { useEffect, useRef } from 'react'
import { NotebookPen, X } from 'lucide-react'
import { useApp } from '../store'

/** 口播语速按每秒约 4.5 字估算 */
const CHARS_PER_SEC = 4.5

function countChars(text: string) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}

function fmtDuration(sec: number) {
  const s = Math.round(sec)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

export function ScriptMemo() {
  const script = useApp((s) => s.script)
  const projectName = useApp((s) => s.projectName)
  const setScript = useApp((s) => s.setScript)
  const toggleScript = useApp((s) => s.toggleScript)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  const chars = countChars(script)

  return (
    <div className="script-memo" data-testid="script-memo">
      <header className="script-memo-head">
        <NotebookPen size={15} style={{ color: 'var(--accent)' }} />
        <span className="font-medium" style={{ fontFamily: 'var(--font-display)' }}>口播稿</span>
        <span className="truncate" style={{ color: 'var(--text-muted)' }}>· {projectName}</span>
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {chars} 字 · 约 {fmtDuration(chars / CHARS_PER_SEC)}
        </span>
        <span className="script-memo-key">~ 返回剪辑</span>
        <button className="icon-btn" onClick={() => toggleScript(false)} aria-label="返回剪辑"><X size={14} /></button>
      </header>
      <textarea
        ref={ref}
        className="script-memo-text"
        data-script-memo
        data-testid="script-memo-text"
        value={script}
        spellCheck={false}
        placeholder={'把口播稿粘贴到这里…\n\n内容跟着当前项目保存，按 ~ 切回剪辑界面'}
        onChange={(e) => setScript(e.target.value)}
      />
    </div>
  )
}
