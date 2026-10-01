import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, FilePlus2, Folder, FolderOpen, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { projectNameFromPath, useApp, type DraftEntry } from '../store'
import { desktop, isDesktopApp } from '../lib/desktop'
import { usePreviewSuspend } from '../hooks/usePreviewSuspend'
import { BrandLogo } from './BrandLogo'

type Preset = { id: string; label: string; sub: string; width: number; height: number; aspect: string }

const PRESETS: Preset[] = [
  { id: 'h1080', label: '横屏 1080p', sub: '1920 × 1080 · 16:9', width: 1920, height: 1080, aspect: '16:9' },
  { id: 'v1080', label: '竖屏 1080p', sub: '1080 × 1920 · 9:16 短视频', width: 1080, height: 1920, aspect: '9:16' },
  { id: 'sq', label: '方形', sub: '1080 × 1080 · 1:1', width: 1080, height: 1080, aspect: '1:1' },
  { id: 'h4k', label: '横屏 4K', sub: '3840 × 2160 · 16:9', width: 3840, height: 2160, aspect: '16:9' },
  { id: 'h720', label: '横屏 720p', sub: '1280 × 720 · 16:9', width: 1280, height: 720, aspect: '16:9' },
  { id: 'r43', label: '4:3', sub: '1440 × 1080 · 4:3', width: 1440, height: 1080, aspect: '4:3' },
]
const FPS = [24, 25, 30, 50, 60]
const PARENT_KEY = 'todo.project.parent'

/** 旧版本地草稿里有内容（片段或素材）且没绑工程文件的，才值得转存 */
function draftSnapshot(id: string): { settings?: { width?: number; height?: number; fps?: number }; clips: number; media: number } | null {
  try {
    const data = JSON.parse(localStorage.getItem(`todo-draft-${id}`) || 'null')
    if (!data) return null
    const clips = Array.isArray(data.sequences) ? data.sequences.reduce((n: number, q: { clips?: unknown[] }) => n + (q.clips?.length ?? 0), 0) : 0
    const media = Array.isArray(data.media) ? data.media.length : 0
    return clips || media ? { settings: data.settings, clips, media } : null
  } catch {
    return null
  }
}

function legacyDrafts(drafts: DraftEntry[]) {
  return drafts.flatMap((d) => {
    if (d.path) return []
    const snap = draftSnapshot(d.id)
    return snap ? [{ draft: d, ...snap }] : []
  })
}

function joinPath(dir: string, ...parts: string[]) {
  const sep = dir.includes('\\') ? '\\' : '/'
  return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

function PresetShape({ w, h }: { w: number; h: number }) {
  const s = 22 / Math.max(w, h)
  return (
    <span className="newproj-shape-box">
      <span className="newproj-shape" style={{ width: Math.round(w * s), height: Math.round(h * s) }} />
    </span>
  )
}

/** 新建项目：名称 + 保存位置 + 序列预设；fromDraftId 时把旧草稿转存成项目 */
export function NewProjectDialog() {
  const dialog = useApp((s) => s.newProjectDialog)
  const drafts = useApp((s) => s.drafts)
  const setDialog = useApp((s) => s.setNewProjectDialog)
  const createProject = useApp((s) => s.createProject)
  usePreviewSuspend(!!dialog, 'dialog')
  const fromDraft = dialog?.fromDraftId ? drafts.find((d) => d.id === dialog.fromDraftId) : undefined
  const isDesktop = isDesktopApp()

  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [preset, setPreset] = useState('h1080')
  const [fps, setFps] = useState(30)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dialog) return
    setError(null)
    setBusy(false)
    const snap = fromDraft ? draftSnapshot(fromDraft.id) : null
    setName(fromDraft?.name ?? '未命名项目')
    const hit = PRESETS.find((p) => p.width === snap?.settings?.width && p.height === snap?.settings?.height)
    setPreset(hit?.id ?? 'h1080')
    setFps(FPS.includes(Number(snap?.settings?.fps)) ? Number(snap?.settings?.fps) : 30)
    const saved = localStorage.getItem(PARENT_KEY)
    if (saved) setParentDir(saved)
    else void desktop()?.getPaths().then((p) => setParentDir((cur) => cur || p.projectsRoot || p.projects))
  }, [dialog, fromDraft])

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDialog(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, setDialog])

  if (!dialog) return null
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[0]
  const trimmed = name.trim()
  const target = parentDir && trimmed ? joinPath(parentDir, trimmed, `${trimmed}.todo.json`) : ''

  async function browse() {
    try {
      const r = await desktop()?.pickDirectory?.({ title: '选择项目保存位置', defaultPath: parentDir })
      if (r?.ok && r.path) { setParentDir(r.path); setError(null) }
    } catch {
      setError('选择文件夹失败：桌面端主进程是旧版本，请重启应用；也可以直接在输入框里填路径')
    }
  }

  async function submit() {
    if (busy) return
    if (!trimmed) { setError('请填写项目名称'); return }
    if (isDesktop && !parentDir) { setError('请选择保存位置'); return }
    setBusy(true)
    setError(null)
    const ok = await createProject({
      name: trimmed,
      parentDir,
      settings: { width: p.width, height: p.height, aspect: p.aspect, fps },
      fromDraftId: fromDraft?.id,
    })
    setBusy(false)
    if (ok && isDesktop) localStorage.setItem(PARENT_KEY, parentDir)
    if (!ok) setError(useApp.getState().toast || '新建项目失败')
  }

  return createPortal(
    <div className="modal-backdrop" style={{ zIndex: 80 }} data-testid="newproj-dialog" onClick={() => setDialog(null)}>
      <div className="modal" style={{ width: 'min(620px, 100%)', maxHeight: 'calc(100vh - 32px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--border)' }}>
          <FilePlus2 size={14} style={{ color: 'var(--accent)' }} />
          <span className="font-medium" style={{ fontFamily: 'var(--font-display)' }}>{fromDraft ? '草稿转存为项目' : '新建项目'}</span>
          <button className="icon-btn ml-auto" onClick={() => setDialog(null)} aria-label="关闭"><X size={14} /></button>
        </div>
        <form className="p-4 grid grid-cols-1 gap-4 min-h-0 overflow-y-auto overflow-x-hidden" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div className="field">
            <label>项目名称</label>
            <input autoFocus data-testid="newproj-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
          </div>
          {isDesktop && (
            <div className="field">
              <label>保存位置</label>
              <div className="flex gap-2">
                <input className="flex-1 min-w-0" data-testid="newproj-parent" value={parentDir} onChange={(e) => setParentDir(e.target.value)} />
                <button type="button" className="btn btn-ghost shrink-0" data-testid="newproj-browse" onClick={() => void browse()}>
                  <Folder size={13} />浏览…
                </button>
              </div>
              <div className="text-[11px] leading-relaxed break-all" style={{ color: 'var(--text-muted)' }}>
                {target ? `将创建 ${target}，并在项目文件夹里放 AI 生成物、导出和缓存` : '会在这里新建一个以项目名命名的文件夹'}
              </div>
            </div>
          )}
          <div className="field">
            <label>序列预设</label>
            <div className="newproj-presets" data-testid="newproj-presets">
              {PRESETS.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={clsx('newproj-preset', preset === x.id && 'active')}
                  data-testid={`newproj-preset-${x.id}`}
                  onClick={() => setPreset(x.id)}
                >
                  <PresetShape w={x.width} h={x.height} />
                  <span className="min-w-0">
                    <b>{x.label}</b>
                    <small>{x.sub}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>帧率</label>
            <div className="skill-seg">
              {FPS.map((f) => (
                <button key={f} type="button" className={clsx(fps === f && 'active')} onClick={() => setFps(f)}>{f} fps</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[11px] flex-1 min-w-[160px]" style={{ color: error ? 'var(--error)' : 'var(--text-muted)' }}>
              {error || (fromDraft ? '草稿里的片段和素材会一起搬进新项目' : '画幅和帧率之后也能在「工程设置」里改')}
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>取消</button>
            <button type="submit" className="btn btn-primary" data-testid="newproj-submit" disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
              {fromDraft ? '转存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

/** 启动起始页：新建 / 打开 / 最近项目；桌面版未打开项目时显示 */
export function StartScreen() {
  const recent = useApp((s) => s.recentProjects)
  const drafts = useApp((s) => s.drafts)
  const toast = useApp((s) => s.toast)
  const setDialog = useApp((s) => s.setNewProjectDialog)
  const openProjectFromFile = useApp((s) => s.openProjectFromFile)
  const removeRecentProject = useApp((s) => s.removeRecentProject)
  const refreshRecentProjects = useApp((s) => s.refreshRecentProjects)
  const isDesktop = isDesktopApp()
  const [opening, setOpening] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const legacy = useMemo(() => legacyDrafts(drafts), [drafts])

  useEffect(() => {
    void refreshRecentProjects()
    void desktop()?.discoverProjects?.().then((r) => {
      if (r?.roots?.length) setRoots(r.roots)
      if (r?.ok && r.projects) useApp.setState({ recentProjects: r.projects })
    })
    void desktop()?.getPaths?.().then((p) => {
      if (p?.projectsRoot) setRoots((cur) => cur.includes(p.projectsRoot!) ? cur : [...cur, p.projectsRoot!])
    })
  }, [refreshRecentProjects])

  async function open(filePath?: string) {
    setOpening(filePath ?? '')
    try { await openProjectFromFile(filePath) } finally { setOpening(null) }
  }

  function openLocal(id: string) {
    useApp.getState().openDraft(id, { localOnly: true })
    useApp.setState({ started: true })
  }

  const visible = recent.filter((r) => r.exists)
  const missing = recent.filter((r) => !r.exists)

  return (
    <div className="start-screen" data-testid="start-screen">
      <div className="start-card">
        <aside className="start-side">
          <BrandLogo />
          <div className="grid gap-2 mt-8">
            <button className="btn btn-primary justify-start h-10" data-testid="start-new" onClick={() => setDialog({})}>
              <FilePlus2 size={15} />新建项目
            </button>
            {isDesktop && (
              <button className="btn btn-ghost justify-start h-10" data-testid="start-open" disabled={opening != null} onClick={() => void open()}>
                <FolderOpen size={15} />打开项目…
              </button>
            )}
          </div>
          <div className="mt-auto text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {isDesktop
              ? (roots[0]
                ? `项目默认保存在：${roots[0]}。每个项目一个文件夹，可整个拷走。`
                : '每个项目是一个文件夹：工程文件、AI 生成物、导出和缓存都放在里面。')
              : '浏览器版：项目保存在本机浏览器里。'}
          </div>
        </aside>

        <section className="start-main">
          <div className="eyebrow flex items-center gap-1.5"><Clock size={11} />最近项目</div>
          {isDesktop ? (
            visible.length ? (
              <div className="grid gap-1 mt-2" data-testid="start-recent">
                {visible.map((r) => (
                  <div key={r.path} className="start-item">
                    <button className="start-item-main" disabled={opening != null} title={r.path} onClick={() => void open(r.path)}>
                      <b>{projectNameFromPath(r.path)}</b>
                      <small>{r.path.replace(/[\\/][^\\/]+$/, '')}</small>
                    </button>
                    {opening === r.path && <Loader2 size={13} className="animate-spin shrink-0" />}
                    <button className="icon-btn shrink-0" title="从列表移除（不删文件）" onClick={() => void removeRecentProject(r.path)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="start-empty">
                还没有项目，点「新建项目」开始
                {roots[0] ? <div className="mt-2 text-[11px]">也可把已有工程放到：{roots[0]}</div> : null}
              </div>
            )
          ) : (
            drafts.length ? (
              <div className="grid gap-1 mt-2" data-testid="start-local">
                {drafts.map((d) => (
                  <div key={d.id} className="start-item">
                    <button className="start-item-main" onClick={() => openLocal(d.id)}>
                      <b>{d.name}</b>
                      <small>{new Date(d.updatedAt).toLocaleString()}</small>
                    </button>
                  </div>
                ))}
              </div>
            ) : <div className="start-empty">还没有项目</div>
          )}

          {isDesktop && missing.length > 0 && (
            <>
              <div className="eyebrow mt-6">找不到的工程</div>
              <div className="grid gap-1 mt-2" data-testid="start-missing">
                {missing.map((r) => (
                  <div key={r.path} className="start-item missing">
                    <div className="start-item-main">
                      <b>{projectNameFromPath(r.path)}</b>
                      <small>已丢失 · {r.path}</small>
                    </div>
                    <button className="icon-btn shrink-0" title="从列表移除" onClick={() => void removeRecentProject(r.path)}><X size={12} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {isDesktop && legacy.length > 0 && (
            <>
              <div className="eyebrow mt-6">旧版本地草稿</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>草稿只存在软件缓存里，转存为项目后才有自己的文件夹</div>
              <div className="grid gap-1 mt-2" data-testid="start-legacy">
                {legacy.map(({ draft, clips, media }) => (
                  <div key={draft.id} className="start-item">
                    <div className="start-item-main">
                      <b>{draft.name}</b>
                      <small>{clips} 个片段 · {media} 个素材 · {new Date(draft.updatedAt).toLocaleString()}</small>
                    </div>
                    <button className="btn btn-ghost shrink-0 text-[11px] h-7" data-testid={`start-convert-${draft.id}`} onClick={() => setDialog({ fromDraftId: draft.id })}>
                      转存为项目
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      <NewProjectDialog />
      {toast && <div className="toast" data-testid="toast">{toast}</div>}
    </div>
  )
}
