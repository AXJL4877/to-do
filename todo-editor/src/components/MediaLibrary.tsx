import { useMemo, useRef, useState } from 'react'
import {
  Upload, Type, Star, Camera, Sparkles, MoreHorizontal, Film,
  Music, Blend, Wand2, Aperture, LayoutTemplate, CaseSensitive, History, Trash2,
} from 'lucide-react'
import { useApp } from '../store'
import { parseMediaFiles, filesFromDataTransfer } from '../lib/importFiles'
import { AiPanel } from './AiPanel'
import { MotionPresetLibrary } from './MotionPresetLibrary'
import { beginDockDrag, defaultPanelDock, shouldIgnoreDockClick } from '../lib/panelDock'
import { beginMediaDrag, finishMediaDrag } from '../lib/mediaDrag'
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { MediaItem } from '../types'

/** 主页只露出高频；其余进「更多」 */
const PRIMARY = ['media', 'text', 'ai'] as const
const SECONDARY = ['audio', 'transition', 'effect', 'filter', 'preset', 'font', 'recent'] as const
type LibTab = (typeof PRIMARY)[number] | (typeof SECONDARY)[number]

const LABELS: Record<LibTab, string> = {
  media: '媒体', audio: '音频', text: '文字', transition: '转场', effect: '特效',
  filter: '滤镜', preset: '预设', font: '字体', recent: '最近', ai: 'AI+',
}

const ICONS: Record<LibTab, LucideIcon> = {
  media: Film, text: Type, ai: Sparkles,
  audio: Music, transition: Blend, effect: Wand2, filter: Aperture,
  preset: LayoutTemplate, font: CaseSensitive, recent: History,
}

function MediaThumb({ m }: { m: MediaItem }) {
  if (m.kind === 'audio') {
    return (
      <div className="w-full h-full grid place-items-center" style={{ background: 'var(--surface-2)' }}>
        <Music size={22} style={{ color: 'var(--text-muted)' }} />
      </div>
    )
  }
  if (m.kind === 'video') {
    return (
      <video
        src={m.url}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        className="w-full h-full object-cover pointer-events-none"
        onLoadedData={(e) => {
          const v = e.currentTarget
          try { if (v.currentTime < 0.05) v.currentTime = 0.04 } catch { /* */ }
        }}
      />
    )
  }
  return (
    <img
      src={m.url}
      alt=""
      draggable={false}
      className="w-full h-full object-cover pointer-events-none"
    />
  )
}

export function MediaLibrary() {
  const media = useApp((s) => s.media)
  const libraryTab = useApp((s) => s.libraryTab) as LibTab
  const selectedMediaId = useApp((s) => s.selectedMediaId)
  const fonts = useApp((s) => s.fonts)
  const setLibraryTab = useApp((s) => s.setLibraryTab)
  const setSelectedMedia = useApp((s) => s.setSelectedMedia)
  const importMedia = useApp((s) => s.importMedia)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const removeMedia = useApp((s) => s.removeMedia)
  const addTextClip = useApp((s) => s.addTextClip)
  const addTransition = useApp((s) => s.addTransition)
  const addEffect = useApp((s) => s.addEffect)
  const captureFrame = useApp((s) => s.captureFrame)
  const aiFloat = useApp((s) => s.aiFloat)
  const aiFloatKind = useApp((s) => s.aiFloatKind)
  const setAiFloat = useApp((s) => s.setAiFloat)
  const importFont = useApp((s) => s.importFont)
  const toggleFavorite = useApp((s) => s.toggleFavorite)
  const panelDock = useApp((s) => s.layout.panelDock) ?? defaultPanelDock
  const setLayout = useApp((s) => s.setLayout)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const list = useMemo(() => {
    if (libraryTab === 'audio') return media.filter((m) => m.kind === 'audio')
    if (libraryTab === 'recent') return [...media].reverse().slice(0, 12)
    return media.filter((m) => m.kind !== 'audio')
  }, [media, libraryTab])

  const inSecondary = (SECONDARY as readonly string[]).includes(libraryTab)
  const MoreIcon = inSecondary ? ICONS[libraryTab] : MoreHorizontal
  const moreLabel = inSecondary ? LABELS[libraryTab] : '更多'

  async function onFiles(files: FileList | File[] | null) {
    if (!files?.length) return
    const parsed = await parseMediaFiles([...files])
    importMedia(parsed)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const mediaId = e.dataTransfer.getData('application/todo-media-id')
    if (mediaId) return
    await onFiles(filesFromDataTransfer(e.dataTransfer))
  }

  return (
    <aside
      className={clsx('panel h-full', dragOver && 'ring-2')}
      style={dragOver ? { '--tw-ring-color': 'var(--accent)' } as React.CSSProperties : undefined}
      data-testid="media-library"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b shrink-0 select-none cursor-grab active:cursor-grabbing"
        style={{ borderColor: 'var(--border)' }}
        data-testid="media-library-header"
        title="拖到窗口左 / 右 / 下边缘停靠"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          beginDockDrag('media', e, (slot) => {
            const dock = useApp.getState().layout.panelDock
            useApp.getState().setLayout({ panelDock: { ...dock, media: slot } })
          })
        }}
      >
        <span className="eyebrow">媒体库</span>
        <div className="flex gap-1">
          <button className="icon-btn" data-testid="btn-capture-frame" onClick={captureFrame} title="AI 截帧（SQLite，不进媒体库）" aria-label="截帧"><Camera size={13} /></button>
          <button className="icon-btn active" data-testid="btn-import" onClick={() => fileRef.current?.click()} title="导入" aria-label="导入">
            <Upload size={13} />
          </button>
          <input ref={fileRef} type="file" multiple accept="video/*,audio/*,image/*" className="hidden" data-testid="input-import" onChange={(e) => onFiles(e.target.files)} />
        </div>
      </div>

      <div className="px-2 pt-2 shrink-0 relative">
        <div className="tab-row" data-testid="library-tabs">
          {PRIMARY.map((t) => {
            const Icon = ICONS[t]
            return (
              <button
                key={t}
                type="button"
                className={clsx('tab tab-icon', libraryTab === t && t !== 'ai' && 'active', t === 'ai' && panelDock.ai === 'tab' && libraryTab === 'ai' && 'active')}
                data-testid={`lib-tab-${t}`}
                title={t === 'ai' ? 'AI+（拖到边缘可停靠左/右/下）' : LABELS[t]}
                aria-label={LABELS[t]}
                onPointerDown={t === 'ai' ? (e) => {
                  beginDockDrag('ai', e, (slot) => {
                    const dock = useApp.getState().layout.panelDock
                    setLayout({ panelDock: { ...dock, ai: slot } })
                    useApp.getState().setLibraryTab('media')
                  })
                } : undefined}
                onClick={() => {
                  if (shouldIgnoreDockClick()) return
                  if (t === 'ai' && panelDock.ai !== 'tab') {
                    setLayout({ panelDock: { ...panelDock, ai: 'tab' } })
                  }
                  setLibraryTab(t)
                  setMoreOpen(false)
                }}
              >
                <Icon size={13} strokeWidth={2} />
              </button>
            )
          })}
          <button
            type="button"
            className={clsx('tab tab-icon', (moreOpen || inSecondary) && 'active')}
            data-testid="lib-tab-more"
            onClick={() => setMoreOpen((v) => !v)}
            title={moreLabel}
            aria-label={moreLabel}
          >
            <MoreIcon size={13} strokeWidth={2} />
          </button>
        </div>
        {moreOpen && (
          <div
            className="absolute left-2 right-2 top-full mt-1 z-20 rounded-lg border p-1 shadow-lg menu-pop"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
            data-testid="lib-more-menu"
          >
            {SECONDARY.map((t) => {
              const Icon = ICONS[t]
              return (
                <button
                  key={t}
                  type="button"
                  className={clsx(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px]',
                    libraryTab === t ? 'bg-[var(--accent-dim)] text-[var(--accent)]' : 'hover:bg-[var(--surface-2)]',
                  )}
                  data-testid={`lib-more-${t}`}
                  title={LABELS[t]}
                  onClick={() => { setLibraryTab(t); setMoreOpen(false) }}
                >
                  <Icon size={13} strokeWidth={2} className="shrink-0 opacity-80" />
                  <span>{LABELS[t]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 min-h-0" onClick={() => moreOpen && setMoreOpen(false)}>
        {libraryTab === 'ai' && panelDock.ai === 'tab' && (
          aiFloat && aiFloatKind === 'window' ? (
            <div className="grid place-items-center gap-2 py-8 px-2 text-center" data-testid="ai-popped-placeholder">
              <p className="text-[12px] m-0" style={{ color: 'var(--text-muted)' }}>AI+ 已弹出到独立窗口</p>
              <button type="button" className="btn btn-ghost" data-testid="btn-ai-float-restore-side" onClick={() => setAiFloat(false)}>
                还原到侧栏
              </button>
            </div>
          ) : aiFloat && aiFloatKind === 'panel' ? (
            <p className="text-[12px] px-1 py-4 text-center" style={{ color: 'var(--text-muted)' }} data-testid="ai-float-panel-hint">
              AI+ 在浮窗中 · 关闭浮窗可还原
            </p>
          ) : (
            <AiPanel />
          )
        )}
        {libraryTab === 'text' && (
          <div className="grid gap-1">
            <button className="btn btn-ghost w-full justify-start" data-testid="text-preset-title" onClick={addTextClip}>
              <Type size={13} />新建文本
            </button>
            <button className="btn btn-ghost w-full justify-start" data-testid="text-preset-subtitle" onClick={addTextClip}>字幕条</button>
            <button className="btn btn-ghost w-full justify-start" data-testid="text-preset-lower" onClick={addTextClip}>下三分之一</button>
            <button className="btn btn-ghost w-full justify-start" data-testid="sticker-emoji" onClick={() => addEffect('sticker', '贴纸')}>贴纸叠加</button>
          </div>
        )}
        {libraryTab === 'transition' && (
          <div className="grid grid-cols-2 gap-1">
            {(['dissolve', 'fadeBlack', 'fadeWhite', 'push', 'wipe'] as const).map((id) => (
              <button key={id} className="btn btn-ghost h-12" data-testid={`transition-${id}`} onClick={() => addTransition(id)}>{id}</button>
            ))}
          </div>
        )}
        {(libraryTab === 'effect' || libraryTab === 'filter') && (
          <div className="grid grid-cols-2 gap-1">
            {['模糊', '锐化', '暗角', '光效', '故障', '马赛克'].map((name) => (
              <button key={name} className="btn btn-ghost h-12" data-testid={`effect-${name}`} onClick={() => addEffect('blur', name)}>{name}</button>
            ))}
          </div>
        )}
        {libraryTab === 'preset' && (
          <div className="grid gap-1" data-testid="preset-list">
            <MotionPresetLibrary />
          </div>
        )}
        {libraryTab === 'font' && (
          <>
            {fonts.map((f) => <div key={f.id} className="px-2 py-1.5 text-[12px] rounded-md mb-1" style={{ background: 'var(--surface-2)' }}>{f.name}</div>)}
            <button className="btn btn-ghost w-full" data-testid="btn-import-font" onClick={() => importFont('Custom')}>导入字体</button>
          </>
        )}
        {(['media', 'audio', 'recent'].includes(libraryTab) || (libraryTab === 'ai' && panelDock.ai !== 'tab')) && (
          list.length === 0 ? (
            <div className="h-full min-h-[120px] grid place-items-center text-[12px] text-center px-2" style={{ color: 'var(--text-muted)' }} data-testid="media-empty">
              拖入或点击导入
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5" data-testid="media-grid">
              {list.map((m) => (
                <div
                  key={m.id}
                  className={clsx(
                    'group relative rounded-lg overflow-hidden border cursor-grab active:cursor-grabbing',
                    selectedMediaId === m.id && 'ring-2',
                  )}
                  style={{ borderColor: 'var(--border)', '--tw-ring-color': 'var(--accent)' } as React.CSSProperties}
                  data-testid={`media-item-${m.id}`}
                  draggable
                  onClick={() => setSelectedMedia(m.id)}
                  onDoubleClick={() => addClipFromMedia(m.id)}
                  onDragStart={(e) => beginMediaDrag(e.dataTransfer, m.id)}
                  onDragEnd={finishMediaDrag}
                  title={m.name}
                >
                  <div className="aspect-video w-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                    <MediaThumb m={m} />
                  </div>
                  <div
                    className="absolute inset-x-0 bottom-0 px-1.5 py-1 truncate text-[10px] font-medium"
                    style={{
                      color: '#F5F2EC',
                      background: 'linear-gradient(transparent, hsl(220 20% 8% / 0.75))',
                    }}
                  >
                    {m.offline ? '⚠ ' : ''}{m.name}
                  </div>
                  <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, background: 'hsl(220 20% 8% / 0.55)', color: '#F5F2EC' }}
                      data-testid={`fav-${m.id}`}
                      title="收藏"
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(m.id) }}
                    >
                      <Star size={11} fill={m.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22, background: 'hsl(220 20% 8% / 0.55)', color: '#F5F2EC' }}
                      data-testid={`del-media-${m.id}`}
                      title="从媒体库删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeMedia(m.id)
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </aside>
  )
}
