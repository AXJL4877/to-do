import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ImageOff, Search, Sparkles, X } from 'lucide-react'
import clsx from 'clsx'
import type { StylePack } from './AiStyleForm'

const FREE = ''

/** 风格库弹窗：左侧卡片网格，右侧预览与详情 */
export function AiStylePicker({ styles, currentId, onPick, onClose }: {
  styles: StylePack[]
  currentId: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [focusId, setFocusId] = useState(currentId || styles[0]?.id || FREE)
  const [previewIdx, setPreviewIdx] = useState(0)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return styles
    return styles.filter((s) => [s.name, s.description, ...s.tags].some((t) => t.toLowerCase().includes(q)))
  }, [query, styles])
  const focused = styles.find((s) => s.id === focusId) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function focus(id: string) {
    setFocusId(id)
    setPreviewIdx(0)
  }

  function pick(id: string) {
    onPick(id)
    onClose()
  }

  return createPortal(
    <div className="modal-backdrop" data-testid="ai-style-picker" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(960px, 100%)', height: 'min(660px, 90vh)', maxHeight: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="eyebrow shrink-0">风格库 · {styles.length}</span>
          <div className="relative flex-1 max-w-[280px] ml-auto">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              data-testid="ai-style-search"
              className="w-full h-[28px] pl-7 pr-2 rounded-md text-[12px] border"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}
              placeholder="搜索风格、标签…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="icon-btn" data-testid="ai-style-picker-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden">
          <div className="md:flex-1 md:min-h-0 md:overflow-y-auto p-4">
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              <button
                type="button"
                data-testid="ai-style-card-free"
                className={clsx('style-card', focusId === FREE && 'is-focused')}
                onClick={() => focus(FREE)}
                onDoubleClick={() => pick(FREE)}
              >
                <div className="style-card-media grid place-items-center" style={{ background: 'linear-gradient(135deg, var(--surface-2), var(--accent-dim))' }}>
                  <Sparkles size={28} style={{ color: 'var(--accent)' }} />
                </div>
                <div className="style-card-body">
                  <span className="style-card-name">自由生成</span>
                  <span className="style-card-sub">不套风格，自己写提示词</span>
                </div>
                {currentId === FREE && <span className="style-card-badge"><Check size={10} />使用中</span>}
              </button>

              {filtered.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`ai-style-card-${s.id}`}
                  className={clsx('style-card group', focusId === s.id && 'is-focused')}
                  onClick={() => focus(s.id)}
                  onDoubleClick={() => pick(s.id)}
                >
                  <div className="style-card-media">
                    {s.previews[0] ? (
                      <>
                        <img src={s.previews[0]} alt={s.name} loading="lazy" />
                        {s.previews[1] && (
                          <img src={s.previews[1]} alt="" loading="lazy" className="opacity-0 group-hover:opacity-100" />
                        )}
                      </>
                    ) : (
                      <div className="w-full h-full grid place-items-center" style={{ color: 'var(--text-muted)' }}>
                        <ImageOff size={22} />
                      </div>
                    )}
                    {s.previews.length > 1 && <span className="style-card-count">{s.previews.length} 张</span>}
                  </div>
                  <div className="style-card-body">
                    <span className="style-card-name">{s.name}</span>
                    <span className="style-card-sub">{s.tags.slice(0, 3).join(' · ') || s.author}</span>
                  </div>
                  {currentId === s.id && <span className="style-card-badge"><Check size={10} />使用中</span>}
                </button>
              ))}
            </div>
            {filtered.length === 0 && (
              <p className="text-[12px] text-center mt-8" style={{ color: 'var(--text-muted)' }}>没有匹配「{query}」的风格</p>
            )}
          </div>

          <aside
            className="md:w-[340px] shrink-0 border-t md:border-t-0 md:border-l flex flex-col md:min-h-0"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}
            data-testid="ai-style-detail"
          >
            <div className="md:flex-1 md:min-h-0 md:overflow-y-auto p-4 flex flex-col gap-3">
              {focused ? (
                <>
                  <div className="rounded-lg overflow-hidden border h-[260px] md:h-auto md:aspect-square bg-white grid place-items-center" style={{ borderColor: 'var(--border)' }}>
                    {focused.previews[previewIdx] ? (
                      <img src={focused.previews[previewIdx]} alt={`${focused.name} 预览`} className="w-full h-full object-contain" />
                    ) : (
                      <ImageOff size={28} style={{ color: 'var(--text-muted)' }} />
                    )}
                  </div>
                  {focused.previews.length > 1 && (
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                      {focused.previews.map((p, i) => (
                        <button
                          key={p}
                          type="button"
                          className={clsx('shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 bg-white', i === previewIdx ? '' : 'opacity-70 hover:opacity-100')}
                          style={{ borderColor: i === previewIdx ? 'var(--accent)' : 'transparent' }}
                          onClick={() => setPreviewIdx(i)}
                          data-testid={`ai-style-thumb-${i}`}
                        >
                          <img src={p} alt="" className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[15px] font-semibold">{focused.name}</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>v{focused.version} · {focused.author}</span>
                    </div>
                    <p className="text-[12px] m-0 mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{focused.description}</p>
                  </div>
                  {focused.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {focused.tags.map((t) => <span key={t} className="style-tag">{t}</span>)}
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <span className="eyebrow">可调项</span>
                    {focused.inputs.map((inp) => (
                      <div key={inp.id} className="text-[11px] leading-snug">
                        <span className="font-medium">{inp.label}</span>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {' · '}
                          {inp.type === 'select'
                            ? inp.options.map((o) => o.label).join(' / ')
                            : `自然语言描述${inp.required ? '（必填）' : ''}，≤${inp.maxLength} 字`}
                        </span>
                      </div>
                    ))}
                    <div className="text-[11px]">
                      <span className="font-medium">输出</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {' · '}{focused.cutout ? `透明底 PNG / 保留背景（默认${focused.cutout.default ? '透明底' : '保留背景'}）` : '保留背景'}
                      </span>
                    </div>
                    <div className="text-[11px]">
                      <span className="font-medium">画幅</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {focused.image.aspectRatios.join(' / ')}</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-2 items-start">
                  <Sparkles size={22} style={{ color: 'var(--accent)' }} />
                  <span className="text-[15px] font-semibold">自由生成</span>
                  <p className="text-[12px] m-0 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    不限定风格，自由填写提示词、选择模型与尺寸。适合一次性的素材需求。
                  </p>
                </div>
              )}
            </div>
            <div className="p-3 border-t flex gap-2 sticky bottom-0 md:static" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                data-testid="ai-style-apply"
                onClick={() => pick(focusId)}
              >
                {focusId === currentId ? '继续使用' : '使用此风格'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
