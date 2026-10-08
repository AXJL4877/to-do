import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Send, Sparkles, Zap } from 'lucide-react'
import type { ScriptCard, ScriptOption, ScriptSubstep } from '../lib/scriptWorkspace'
import { SUBSTEP_LABELS } from '../lib/scriptWorkspace'
import { optionLabel } from '../lib/scriptStageApply'
import { CreativeProgress } from './CreativeProgress'

function contentText(o: ScriptOption) {
  if (typeof o.content === 'string') return o.content
  if (Array.isArray(o.content)) {
    return (o.content as { key_point?: string; role?: string }[])
      .map((s, i) => `${i + 1}. ${s.role || ''}：${s.key_point || ''}`)
      .join('\n')
  }
  if (o.content != null) {
    try { return JSON.stringify(o.content, null, 0) } catch { return String(o.content) }
  }
  if (o.suggested != null) return String(o.suggested)
  return ''
}

type Props = {
  stageLabel: string
  substep: ScriptSubstep
  card: ScriptCard | null
  selectedIds: string[]
  customText: string
  busy?: boolean
  error?: string | null
  pasteMat?: string
  onPasteMat?: (t: string) => void
  onPasteSubmit?: () => void
  onPasteSkip?: () => void
  onToggle: (id: string) => void
  onCustom: (t: string) => void
  onClearSelect?: () => void
  onConfirm: () => void
  onRegen: () => void
  onAdoptCustom?: () => void
  onFactAction?: (id: string, action: 'add_source' | 'soften' | 'delete' | 'human_verify') => void
  onRank?: (ids: string[]) => void
  onSkip?: () => void
  onFormChange?: (key: string, value: string) => void
}

/** 备忘录底部：按当前流程提问 + 选项 + 自定义（非全屏弹窗） */
export function ScriptStageAskDock({
  stageLabel, substep, card, selectedIds, customText, busy, error,
  pasteMat, onPasteMat, onPasteSubmit, onPasteSkip,
  onToggle, onCustom, onClearSelect, onConfirm, onRegen, onAdoptCustom, onFactAction, onRank, onSkip, onFormChange,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const [customOn, setCustomOn] = useState(false)
  const [waitSec, setWaitSec] = useState(0)
  const [height, setHeight] = useState(() => {
    try { return Number(localStorage.getItem('script-dock-height')) || 360 } catch { return 360 }
  })
  const resizeStart = useRef<{ y: number; height: number } | null>(null)
  const changeHeight = (value: number) => {
    const next = Math.max(180, Math.min(window.innerHeight * 0.72, value))
    setHeight(next)
    try { localStorage.setItem('script-dock-height', String(next)) } catch { /* optional preference */ }
  }

  useEffect(() => {
    if (!busy) { setWaitSec(0); return }
    setWaitSec(0)
    const id = window.setInterval(() => setWaitSec((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [busy])

  useEffect(() => {
    setCustomOn(false)
  }, [card?.question_for_user, substep])

  const choiceKind = card?.card_type
  const multi = choiceKind === 'multi_select' || choiceKind === 'diff_review'
  const isForm = choiceKind === 'form'
  const isFree = choiceKind === 'free_input'
  const isRank = choiceKind === 'rank'
  const opts = (isForm ? card?.fields : null) || card?.options || []
  const canSend = !busy && !!card && (
    isForm
    || isFree
    || choiceKind === 'diff_review'
    || substep === 'E.fact'
    || (!customOn && selectedIds.length > 0)
  )

  const pickCustom = () => {
    setCustomOn(true)
    onClearSelect?.()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const pickOption = (id: string) => {
    setCustomOn(false)
    onCustom('')
    onToggle(id)
  }

  const moveRank = (id: string, dir: number) => {
    const ids = opts.map((item, index) => String(item.key || item.id || `field-${index}`))
    const order = selectedIds.length === ids.length ? [...selectedIds] : ids
    const index = order.indexOf(id)
    const next = index + dir
    if (index < 0 || next < 0 || next >= order.length) return
    const copy = [...order]
    const [item] = copy.splice(index, 1)
    copy.splice(next, 0, item)
    onRank?.(copy)
  }

  const send = () => {
    if (!canSend) return
    onConfirm()
  }

  const showMaterialsPaste = substep === 'C.materials' && onPasteMat && !card && !busy

  return (
    <div className="script-ask-dock" data-testid="script-stage-ask-dock" style={{ height }}>
      <div className="script-dock-resize" role="separator" aria-label="调整正文与问答区高度" aria-orientation="horizontal"
        aria-valuemin={180} aria-valuemax={Math.floor(window.innerHeight * 0.72)} aria-valuenow={Math.round(height)} tabIndex={0}
        onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); changeHeight(height + (e.key === 'ArrowUp' ? 24 : -24)) } }}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); resizeStart.current = { y: e.clientY, height }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { const start = resizeStart.current; if (start) changeHeight(start.height + start.y - e.clientY) }}
        onPointerUp={() => { resizeStart.current = null }} onPointerCancel={() => { resizeStart.current = null }}
      ><span /></div>
      <div className="script-ask-scroll">
      <div className="script-ask-dock-head">
        <Sparkles size={13} style={{ color: 'var(--accent)' }} />
        <span className="script-ask-dock-title">{stageLabel} · {SUBSTEP_LABELS[substep]}</span>
        {busy ? (
          <span className="script-ask-dock-wait">{waitSec}s</span>
        ) : null}
      </div>

      <p className="script-ask-dock-q">
        {busy && !card
          ? `正在准备选项（通常 10～25 秒）…`
          : (card?.question_for_user || '请确认或补充信息')}
      </p>
      {card?.notes ? <p className="script-ask-dock-note">{card.notes}</p> : null}
      {error ? <div className="script-ask-dock-err" role="alert"><p>{error}</p><button type="button" className="btn" disabled={busy} onClick={onRegen}>重试本步</button></div> : null}

      {showMaterialsPaste ? (
        <div className="script-ask-paste">
          <p className="script-ask-dock-note">先把资料贴进备忘录上方也行；或在这里粘贴后点「整理入库」</p>
          <textarea
            className="script-paste"
            data-testid="script-material-paste"
            value={pasteMat || ''}
            rows={3}
            placeholder={'段落空一行。\n可写：来源：某某报告'}
            onChange={(e) => onPasteMat?.(e.target.value)}
          />
          <div className="script-ask-paste-actions">
            <button type="button" className="btn btn-primary text-[11px]" onClick={onPasteSubmit}>整理入库</button>
            <button type="button" className="btn text-[11px]" onClick={onPasteSkip}>无资料继续</button>
          </div>
        </div>
      ) : null}

      {busy ? (
        <CreativeProgress theme="type" compact label={`思考中 ${waitSec}s…`} />
      ) : null}

      {card && opts.length > 0 ? (
        <div className="script-ask-opts" data-testid="script-chat-choices">
          {opts.map((o, i) => {
            const id = String(o.key || o.id || `field-${i}`)
            const on = !customOn && selectedIds.includes(id)
            const letter = String.fromCharCode(65 + (i % 26))
            const body = contentText(o)
            if (isForm) {
              const key = String(o.key || o.id)
              const value = Array.isArray(o.suggested) ? o.suggested.join('、') : String(o.suggested ?? '')
              return <label className="script-form-field" key={id}>
                <span>{optionLabel(o)}</span>
                <input className="input" type={key === 'duration_sec' ? 'number' : 'text'} min={key === 'duration_sec' ? 15 : undefined}
                  value={value} disabled={busy} onChange={e => onFormChange?.(key, e.target.value)}
                  list={o.choices?.length ? `script-field-${id}` : undefined} />
                {o.choices?.length ? <datalist id={`script-field-${id}`}>{o.choices.map(String).map(choice => <option key={choice} value={choice} />)}</datalist> : null}
              </label>
            }
            const inputType = multi ? 'checkbox' : 'radio'
            const summary = body.length > 180 ? `${body.slice(0, 80)}…` : body
            return (
              <div
                key={id}
                className={`script-ask-opt${on ? ' on' : ''}${card.recommended_id === id ? ' rec' : ''}`}
              >
                <span className="script-ask-opt-letter">
                  {isRank ? null : <input type={inputType} name="script-card-choice" checked={on} disabled={busy} onChange={() => pickOption(id)} aria-label={optionLabel(o)} />}
                  {letter}
                </span>
                <span className="script-ask-opt-main">
                  <span className="script-ask-opt-title">
                    {optionLabel(o)}
                    {card.recommended_id === id ? <em>推荐</em> : null}
                    {isRank ? (
                      <span className="script-ask-rank">
                        <button type="button" className="btn text-[11px]" disabled={busy || i === 0} onClick={() => moveRank(id, -1)}>上移</button>
                        <button type="button" className="btn text-[11px]" disabled={busy || i === opts.length - 1} onClick={() => moveRank(id, 1)}>下移</button>
                      </span>
                    ) : null}
                  </span>
                  {card.card_type === 'diff_review' ? (
                    <span className="script-ask-opt-body script-review-diff">
                      <span className="script-review-before">原文：{o.before || '（无）'}</span>
                      <span className="script-review-after">修改：{o.after || '（删除此处）'}</span>
                      {o.reason || o.rule ? <span>原因：{o.reason || o.rule}</span> : null}
                    </span>
                  ) : body ? (
                    body.length > 180 ? (
                      <span className="script-ask-opt-body">
                        <span>{summary}</span>
                        <details>
                          <summary>展开全文</summary>
                          {body}
                        </details>
                      </span>
                    ) : <span className="script-ask-opt-body">{body}</span>
                  ) : null}
                  {o.reason && card.card_type !== 'diff_review' ? <span className="script-ask-opt-body">推荐理由：{o.reason}</span> : null}
                  {o.risk ? <span className="script-ask-opt-body">风险：{o.risk}</span> : null}
                  {substep === 'E.fact' && (o.status === 'missing' || o.status === 'mismatch') ? (
                    <span className="script-ask-fact">
                      <button type="button" className="btn text-[11px]" onClick={() => onFactAction?.(id, 'add_source')}>补充来源</button>
                      <button type="button" className="btn text-[11px]" onClick={() => onFactAction?.(id, 'soften')}>改为非事实</button>
                      <button type="button" className="btn text-[11px]" onClick={() => onFactAction?.(id, 'delete')}>删除断言</button>
                      <button type="button" className="btn text-[11px]" onClick={() => onFactAction?.(id, 'human_verify')}>记录人工核验</button>
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
          {!isForm && card.allow_custom !== false ? (
            <button
              type="button"
              className={`script-ask-opt custom${customOn ? ' on' : ''}`}
              disabled={busy}
              data-testid="script-chat-custom-opt"
              onClick={pickCustom}
            >
              <span className="script-ask-opt-letter">✎</span>
              <span className="script-ask-opt-main">
                <span className="script-ask-opt-title">自定义</span>
                <span className="script-ask-opt-body muted">{card.custom_hint || '直接说你的想法'}</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      </div>

      {(card || (!showMaterialsPaste && !busy)) ? (
        <div className="script-ask-composer">
          <div className="script-ask-tools">
            <button type="button" className="btn text-[11px]" disabled={busy} onClick={onRegen}>
              <RefreshCw size={11} /> {card ? '重新生成' : '生成本步'}
            </button>
            {onSkip ? (
              <button type="button" className="btn text-[11px]" disabled={busy || !card} onClick={onSkip}>
                <Zap size={11} /> AI 代决
              </button>
            ) : null}
            <span className="script-ask-hint">
              {isForm ? '可直接修改设置' : multi ? `已选 ${selectedIds.length}` : selectedIds[0] ? '已选一项' : '点选项或输入修改要求'}
            </span>
          </div>
          <div className="script-ask-input-row">
            {!isForm && <textarea
              ref={inputRef}
              className="script-ask-input"
              data-testid="script-card-custom"
              rows={2}
              disabled={busy}
              value={customText}
              placeholder={card?.custom_hint || '也可以直接输入…'}
              onChange={(e) => {
                onCustom(e.target.value)
                if (e.target.value.trim()) {
                  setCustomOn(true)
                  onClearSelect?.()
                }
              }}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || composing.current) return
                if (isFree) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (canSend) send()
                }
              }}
            />}
            <button
              type="button"
              className="btn btn-primary script-ask-send"
              data-testid="script-card-confirm"
              disabled={!canSend}
              onClick={send}
            >
              <Send size={14} /> {isFree ? '采用这段' : '确认并继续'}
            </button>
            {customText.trim() && !isForm && !isFree ? (
              <span className="script-ask-custom-actions">
                <button type="button" className="btn text-[11px]" disabled={busy} onClick={onAdoptCustom}>直接采用</button>
                <button type="button" className="btn text-[11px]" disabled={busy} onClick={onRegen}>让 AI 重写</button>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
