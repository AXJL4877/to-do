/**
 * 媒体库：标签栏 + 文件夹树（媒体/音频）+ 各功能面板。
 * 文件夹支持嵌套、拖素材进夹、网页浏览器截图入库。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload, Type, Star, Camera, Sparkles, MoreHorizontal, Film,
  Music, Blend, Wand2, Aperture, Zap, CaseSensitive, History, Trash2, Square, Blocks, Mic, Image as ImageIcon,
  Folder, FolderPlus, FolderOpen, ChevronRight, ChevronDown, Globe, Pencil, Music2,
} from 'lucide-react'
import { useApp } from '../store'
import { parseMediaFiles, filesFromDataTransfer } from '../lib/importFiles'
import { AiPanel } from './AiPanel'
import { MotionPresetLibrary } from './MotionPresetLibrary'
import { FancyTextPanel } from './FancyTextPanel'
import { DynamicTextPanel } from './DynamicTextPanel'
import { SkillsPanel } from './SkillsPanel'
import { VoicePanel } from './VoicePanel'
import { BgmPanel } from './BgmPanel'
import { beginDockDrag, defaultPanelDock, shouldIgnoreDockClick } from '../lib/panelDock'
import { beginMediaDrag, finishMediaDrag } from '../lib/mediaDrag'
import { desktop } from '../lib/desktop'
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { MediaFolder, MediaItem } from '../types'

/** 主页只露出高频；其余进「更多」 */
const PRIMARY = ['media', 'text', 'preset', 'skill', 'voice', 'bgm', 'ai'] as const
const SECONDARY = ['audio', 'transition', 'effect', 'filter', 'font', 'recent'] as const
type LibTab = (typeof PRIMARY)[number] | (typeof SECONDARY)[number] | 'dynamic-text'

const LABELS: Record<LibTab, string> = {
  media: '媒体', audio: '音频', text: '文字', transition: '转场', effect: '特效',
  filter: '滤镜', preset: '动效预设', font: '字体', recent: '最近', ai: 'AI+', skill: '拓展', voice: '配音', bgm: '配乐', 'dynamic-text': '动态文字片段',
}

const ICONS: Record<LibTab, LucideIcon> = {
  media: Film, text: Type, ai: Sparkles, skill: Blocks, voice: Mic, bgm: Music2, 'dynamic-text': Type,
  audio: Music, transition: Blend, effect: Wand2, filter: Aperture,
  preset: Zap, font: CaseSensitive, recent: History,
}

const SOLID_SWATCHES = ['#000000', '#FFFFFF', '#1F2937', '#F5F2EC', '#E11D48', '#F59E0B', '#10B981', '#2563EB', '#7C3AED', '#00FF00']
/** 虚拟「全部」：不对应真实 folderId，只是筛选 */
const FOLDER_ALL = '__all__'
const SYSTEM_FOLDERS = new Set(['f_all', 'f_broll', 'f_audio', 'f_sticker', 'f_web'])

/** 背景：纯色 / 本地图片 → 添加到播放头最底层视频轨；选中对应片段时直接改色 / 换图 */
function BackgroundRow() {
  const [mode, setMode] = useState<'color' | 'image'>('color')
  return (
    <div className="rounded-lg border p-2 mb-2 flex flex-col gap-1.5" style={{ borderColor: 'var(--border)' }} data-testid="background-row">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold">背景</span>
        <div className="tab-row ml-auto" style={{ gap: 2 }}>
          {(['color', 'image'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={clsx('tab', mode === k && 'active')}
              style={{ height: 20, padding: '0 8px', fontSize: 11 }}
              data-testid={`bg-mode-${k}`}
              onClick={() => setMode(k)}
            >
              {k === 'color' ? '纯色' : '图片'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'color' ? <SolidColorRow /> : <BackgroundImageRow />}
    </div>
  )
}

function BackgroundImageRow() {
  const media = useApp((s) => s.media)
  const importMedia = useApp((s) => s.importMedia)
  const addBackgroundImage = useApp((s) => s.addBackgroundImage)
  const setSelectedBackgroundImage = useApp((s) => s.setSelectedBackgroundImage)
  const selectedImageId = useApp((s) => {
    const ids = new Set(s.selectedClipIds)
    for (const c of s.seq().clips) {
      if (!ids.has(c.id) || !c.mediaId) continue
      const kind = s.media.find((m) => m.id === c.mediaId)?.kind
      if (kind === 'image' || kind === 'sticker') return c.mediaId
    }
    return null
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const images = media.filter((m) => (m.kind === 'image' || m.kind === 'sticker') && !m.offline)
  const use = (id: string) => {
    if (selectedImageId) setSelectedBackgroundImage(id)
    else addBackgroundImage(id)
  }
  async function onPick(files: FileList | null) {
    if (!files?.length) return
    const parsed = (await parseMediaFiles([...files])).filter((p) => p.kind === 'image' || p.kind === 'sticker')
    const [id] = importMedia(parsed, { silent: true })
    if (id) use(id)
    if (fileRef.current) fileRef.current.value = ''
  }
  return (
    <>
      <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
        {selectedImageId ? '已选中图片片段 · 点图直接替换' : '铺满画布，放在最底层视频轨，延到序列末尾'}
      </span>
      <div className="flex items-center gap-1 flex-wrap" data-testid="bg-image-list">
        {images.slice(-8).map((m) => (
          <button
            key={m.id}
            type="button"
            title={m.name}
            aria-label={`背景图 ${m.name}`}
            data-testid={`bg-image-${m.id}`}
            onClick={() => use(m.id)}
            style={{
              width: 40, height: 24, borderRadius: 4, padding: 0, overflow: 'hidden',
              border: '1px solid var(--border)',
              outline: selectedImageId === m.id ? '2px solid var(--accent)' : 'none',
              outlineOffset: 1,
            }}
          >
            <img src={m.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} draggable={false} />
          </button>
        ))}
        <button
          type="button"
          className="btn btn-ghost ml-auto"
          style={{ height: 24, padding: '0 8px', fontSize: 11 }}
          data-testid="bg-image-pick"
          onClick={() => fileRef.current?.click()}
        >
          <ImageIcon size={11} />本地图片
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="bg-image-input" onChange={(e) => onPick(e.target.files)} />
      </div>
    </>
  )
}

function SolidColorRow() {
  const addSolidClip = useApp((s) => s.addSolidClip)
  const setSelectedSolidColor = useApp((s) => s.setSelectedSolidColor)
  const selectedSolid = useApp((s) => {
    const ids = new Set(s.selectedClipIds)
    return s.seq().clips.find((c) => ids.has(c.id) && c.solid)?.solid?.color ?? null
  })
  const [color, setColor] = useState('#000000')
  const pick = (c: string) => {
    setColor(c)
    if (selectedSolid) setSelectedSolidColor(c)
  }
  return (
    <>
      <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }} data-testid="solid-row">
        {selectedSolid ? '已选中纯色片段 · 点色块直接改色' : '铺满画布，放在最底层视频轨'}
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {SOLID_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`颜色 ${c}`}
            data-testid={`solid-swatch-${c.slice(1)}`}
            onClick={() => pick(c)}
            style={{
              width: 18, height: 18, borderRadius: 4, background: c, padding: 0,
              border: '1px solid var(--border)',
              outline: (selectedSolid ?? color).toUpperCase() === c ? '2px solid var(--accent)' : 'none',
              outlineOffset: 1,
            }}
          />
        ))}
        <input
          type="color"
          data-testid="solid-custom"
          title="自定义颜色"
          value={(selectedSolid ?? color).toLowerCase()}
          onChange={(e) => pick(e.target.value.toUpperCase())}
          style={{ width: 22, height: 20, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
        />
        <button
          type="button"
          className="btn btn-ghost ml-auto"
          style={{ height: 24, padding: '0 8px', fontSize: 11 }}
          data-testid="solid-add"
          onClick={() => addSolidClip(selectedSolid ?? color)}
        >
          <Square size={11} fill={selectedSolid ?? color} />添加
        </button>
      </div>
    </>
  )
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

function folderDescendants(folders: MediaFolder[], rootId: string): Set<string> {
  const kids = new Map<string | null, string[]>()
  for (const f of folders) {
    const p = f.parentId ?? null
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p)!.push(f.id)
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of kids.get(id) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c) }
    }
  }
  return out
}

function FolderTree({
  selectedId, onSelect, dropTarget, onDropMedia, onHoverFolder,
}: {
  selectedId: string
  onSelect: (id: string) => void
  dropTarget: string | null
  onDropMedia: (folderId: string, mediaId: string) => void
  onHoverFolder: (folderId: string | null) => void
}) {
  const folders = useApp((s) => s.folders)
  const media = useApp((s) => s.media)
  const addFolder = useApp((s) => s.addFolder)
  const renameFolder = useApp((s) => s.renameFolder)
  const removeFolder = useApp((s) => s.removeFolder)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ f_all: true, f_broll: true })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const m of media) c.set(m.folderId, (c.get(m.folderId) ?? 0) + 1)
    return c
  }, [media])

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, MediaFolder[]>()
    for (const f of folders) {
      const p = f.parentId ?? null
      if (!map.has(p)) map.set(p, [])
      map.get(p)!.push(f)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return map
  }, [folders])

  function startRename(f: MediaFolder) {
    setRenaming(f.id)
    setRenameVal(f.name)
  }

  function commitRename() {
    if (renaming) renameFolder(renaming, renameVal)
    setRenaming(null)
  }

  function renderNode(f: MediaFolder, depth: number) {
    const kids = childrenOf.get(f.id) ?? []
    const open = expanded[f.id] !== false
    const active = selectedId === f.id
    const count = counts.get(f.id) ?? 0
    return (
      <div key={f.id}>
        <div
          className={clsx('media-folder-row', active && 'active', dropTarget === f.id && 'drop')}
          style={{ paddingLeft: 6 + depth * 12 }}
          data-testid={`folder-${f.id}`}
          onClick={() => onSelect(f.id)}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('application/todo-media-id')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            onHoverFolder(f.id)
          }}
          onDragLeave={() => onHoverFolder(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const mid = e.dataTransfer.getData('application/todo-media-id')
            if (mid) onDropMedia(f.id, mid)
            onHoverFolder(null)
          }}
        >
          {kids.length ? (
            <button
              type="button"
              className="media-folder-chevron"
              aria-label={open ? '折叠' : '展开'}
              onClick={(e) => { e.stopPropagation(); setExpanded((s) => ({ ...s, [f.id]: !open })) }}
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          ) : <span className="media-folder-chevron" />}
          {open && kids.length ? <FolderOpen size={12} className="shrink-0 opacity-70" /> : <Folder size={12} className="shrink-0 opacity-70" />}
          {renaming === f.id ? (
            <input
              className="media-folder-rename"
              value={renameVal}
              autoFocus
              data-testid={`folder-rename-${f.id}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="truncate flex-1 text-left">{f.name}</span>
          )}
          {count > 0 && <span className="media-folder-count">{count}</span>}
          <button
            type="button"
            className="media-folder-act"
            title="重命名"
            aria-label="重命名"
            onClick={(e) => { e.stopPropagation(); startRename(f) }}
          >
            <Pencil size={10} />
          </button>
          {!SYSTEM_FOLDERS.has(f.id) && (
            <button
              type="button"
              className="media-folder-act"
              title="删除文件夹"
              aria-label="删除文件夹"
              data-testid={`folder-del-${f.id}`}
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`删除文件夹「${f.name}」？素材会移到上级。`)) removeFolder(f.id)
              }}
            >
              <Trash2 size={10} />
            </button>
          )}
        </div>
        {open && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="media-folder-tree" data-testid="media-folder-tree">
      <div
        className={clsx('media-folder-row', selectedId === FOLDER_ALL && 'active', dropTarget === FOLDER_ALL && 'drop')}
        data-testid="folder-all"
        onClick={() => onSelect(FOLDER_ALL)}
      >
        <span className="media-folder-chevron" />
        <Folder size={12} className="shrink-0 opacity-70" />
        <span className="truncate flex-1 text-left">全部</span>
        <span className="media-folder-count">{media.length}</span>
      </div>
      {(childrenOf.get(null) ?? []).map((f) => renderNode(f, 0))}
      <button
        type="button"
        className="media-folder-add"
        data-testid="folder-add"
        onClick={() => {
          const parent = selectedId !== FOLDER_ALL ? selectedId : null
          const name = prompt('新文件夹名称', '新建文件夹')
          if (!name?.trim()) return
          const id = addFolder(name.trim(), parent)
          if (id) {
            setExpanded((s) => (parent ? { ...s, [parent]: true } : s))
            onSelect(id)
          }
        }}
      >
        <FolderPlus size={12} />新建文件夹
      </button>
    </div>
  )
}

export function MediaLibrary() {
  const media = useApp((s) => s.media)
  const folders = useApp((s) => s.folders)
  const libraryTab = useApp((s) => s.libraryTab) as LibTab
  const selectedMediaId = useApp((s) => s.selectedMediaId)
  const fonts = useApp((s) => s.fonts)
  const setLibraryTab = useApp((s) => s.setLibraryTab)
  const setSelectedMedia = useApp((s) => s.setSelectedMedia)
  const importMedia = useApp((s) => s.importMedia)
  const addClipFromMedia = useApp((s) => s.addClipFromMedia)
  const removeMedia = useApp((s) => s.removeMedia)
  const moveMedia = useApp((s) => s.moveMedia)
  const ensureFolder = useApp((s) => s.ensureFolder)
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
  const [folderId, setFolderId] = useState(FOLDER_ALL)
  const [folderDrop, setFolderDrop] = useState<string | null>(null)

  // 网页截图 → 自动进「网页截图」文件夹
  useEffect(() => {
    const d = desktop()
    if (!d?.onBrowserShot) return
    return d.onBrowserShot((shot) => {
      ensureFolder('f_web', '网页截图', null)
      const [id] = importMedia([{
        name: shot.name,
        url: shot.url,
        path: shot.path,
        kind: 'image',
        duration: useApp.getState().settings.stillDuration || 5,
        width: shot.width,
        height: shot.height,
        hasAudio: false,
        folderId: 'f_web',
      }])
      setLibraryTab('media')
      setFolderId('f_web')
      if (id) setSelectedMedia(id)
    })
  }, [ensureFolder, importMedia, setLibraryTab, setSelectedMedia])

  const folderScope = useMemo(() => {
    if (folderId === FOLDER_ALL) return null
    return folderDescendants(folders, folderId)
  }, [folders, folderId])

  const list = useMemo(() => {
    let base: MediaItem[]
    if (libraryTab === 'audio') base = media.filter((m) => m.kind === 'audio')
    else if (libraryTab === 'recent') base = [...media].reverse().slice(0, 12)
    else base = media.filter((m) => m.kind !== 'audio')
    if (folderScope && (libraryTab === 'media' || libraryTab === 'audio')) {
      base = base.filter((m) => folderScope.has(m.folderId))
    }
    return base
  }, [media, libraryTab, folderScope])

  const inSecondary = (SECONDARY as readonly string[]).includes(libraryTab)
  const MoreIcon = inSecondary ? ICONS[libraryTab] : MoreHorizontal
  const moreLabel = inSecondary ? LABELS[libraryTab] : '更多'
  const showFolders = libraryTab === 'media' || libraryTab === 'audio'

  async function onFiles(files: FileList | File[] | null) {
    if (!files?.length) return
    const parsed = await parseMediaFiles([...files])
    const dest = folderId !== FOLDER_ALL && folders.some((f) => f.id === folderId) ? folderId : undefined
    importMedia(parsed.map((p) => (dest ? { ...p, folderId: dest } : p)))
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    setFolderDrop(null)
    const mediaId = e.dataTransfer.getData('application/todo-media-id')
    if (mediaId) return
    await onFiles(filesFromDataTransfer(e.dataTransfer))
  }

  async function openBrowser() {
    const d = desktop()
    if (!d?.openBrowserWindow) {
      useApp.getState().setToast('请在桌面版中使用内置浏览器')
      return
    }
    ensureFolder('f_web', '网页截图', null)
    await d.openBrowserWindow()
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
          <button className="icon-btn" data-testid="btn-open-browser" onClick={() => void openBrowser()} title="内置浏览器（截图进媒体库）" aria-label="浏览器">
            <Globe size={13} />
          </button>
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

      <div className="flex-1 overflow-hidden p-2 min-h-0 flex flex-col" onClick={() => moreOpen && setMoreOpen(false)}>
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
          <FancyTextPanel />
        )}
        {libraryTab === 'skill' && <SkillsPanel />}
        {libraryTab === 'dynamic-text' && <DynamicTextPanel onBack={() => useApp.getState().setLibraryTab('skill')} />}
        {libraryTab === 'voice' && <VoicePanel />}
        {libraryTab === 'bgm' && <BgmPanel />}
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
        {libraryTab === 'media' && <BackgroundRow />}
        {(['media', 'audio', 'recent'].includes(libraryTab) || (libraryTab === 'ai' && panelDock.ai !== 'tab')) && (
          <div className={clsx('flex-1 min-h-0', showFolders && 'media-browser')}>
            {showFolders && (
              <FolderTree
                selectedId={folderId}
                onSelect={setFolderId}
                dropTarget={folderDrop}
                onHoverFolder={setFolderDrop}
                onDropMedia={(fid, mid) => { moveMedia([mid], fid); setFolderDrop(null) }}
              />
            )}
            <div className="media-grid-pane overflow-y-auto min-h-0">
              {list.length === 0 ? (
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
                      onDragStart={(e) => {
                        beginMediaDrag(e.dataTransfer, m.id)
                        setFolderDrop(null)
                      }}
                      onDragEnd={() => { finishMediaDrag(); setFolderDrop(null) }}
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
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
