import { useApp } from '../store'
import { SHORTCUTS } from '../lib/shortcuts'
import { usePreviewSuspend } from '../hooks/usePreviewSuspend'

function MoreActions() {
  const setModal = useApp((s) => s.setModal)
  const magnetic = useApp((s) => s.settings.magnetic)
  const multiCam = useApp((s) => s.multiCam)
  const groups: { title: string; items: { id: string; label: string; testid?: string; run: () => void }[] }[] = [
    {
      title: '文件',
      items: [
        { id: 'openfile', label: '打开工程…', run: () => { void useApp.getState().openProjectFromFile(); setModal(null) } },
        { id: 'pickmedia', label: '导入媒体…', run: () => { void useApp.getState().pickDesktopMedia(); setModal(null) } },
        { id: 'frame', label: '导出当前帧', run: () => { void useApp.getState().exportProgramFrame(); setModal(null) } },
        { id: 'localsave', label: '仅本地草稿', run: () => { useApp.getState().saveProject(); setModal(null) } },
      ],
    },
    {
      title: '工具',
      items: [
        { id: 'trim', label: '修剪', run: () => { useApp.getState().setTool('trim'); setModal(null) } },
        { id: 'slip', label: '滑动', run: () => { useApp.getState().setTool('slip'); setModal(null) } },
        { id: 'magnetic', label: magnetic ? '关闭磁性' : '开启磁性', run: () => { useApp.getState().setMagnetic(!magnetic); setModal(null) } },
      ],
    },
    {
      title: '编辑',
      items: [
        { id: 'copy', label: '复制/粘贴', run: () => { useApp.getState().copyOrPaste(); setModal(null) } },
        { id: 'link', label: '链接', run: () => { useApp.getState().linkSelected(); setModal(null) } },
        { id: 'unlink', label: '解链', run: () => { useApp.getState().unlinkSelected(); setModal(null) } },
        { id: 'gaps', label: '关闭空隙', run: () => { useApp.getState().closeGaps(); setModal(null) } },
        { id: 'marker', label: '添加标记', run: () => { useApp.getState().addMarker(); setModal(null) } },
        { id: 'work', label: '设工作区', run: () => { const s = useApp.getState(); s.setWorkArea(0, s.playhead); setModal(null) } },
        { id: 'track', label: '添加轨道', run: () => { useApp.getState().addTrack('video'); setModal(null) } },
        { id: 'seq', label: '新建序列', run: () => { useApp.getState().addSequence(); setModal(null) } },
        { id: 'multi', label: multiCam ? '关闭多机位' : '多机位', run: () => { useApp.getState().toggleMultiCam(); setModal(null) } },
      ],
    },
    {
      title: '设置',
      items: [
        { id: 'keys', label: '快捷键', testid: 'btn-shortcuts', run: () => setModal('shortcuts') },
        { id: 'prefs', label: '偏好设置', testid: 'btn-prefs', run: () => setModal('prefs') },
        { id: 'settings', label: '工程设置', testid: 'btn-settings', run: () => setModal('settings') },
        { id: 'full', label: '全屏预览', testid: 'btn-fullscreen', run: () => { useApp.getState().setFullscreen(true); setModal(null) } },
      ],
    },
  ]
  return (
    <div className="grid gap-3" data-testid="tl-more-menu">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>{g.title}</div>
          <div className="grid grid-cols-2 gap-1">
            {g.items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="btn btn-ghost justify-start text-[12px]"
                data-testid={it.testid ?? `tl-more-${it.id}`}
                onClick={it.run}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Modals() {
  const modal = useApp((s) => s.modal)
  usePreviewSuspend(!!modal, modal === 'export' ? 'dialog' : 'dialog')
  const setModal = useApp((s) => s.setModal)
  const drafts = useApp((s) => s.drafts)
  const settings = useApp((s) => s.settings)
  const prefs = useApp((s) => s.prefs)
  const exportQueue = useApp((s) => s.exportQueue)
  const cacheMb = useApp((s) => s.cacheMb)
  const sequences = useApp((s) => s.sequences)
  const activeSeqId = useApp((s) => s.activeSeqId)
  const newProject = useApp((s) => s.newProject)
  const openDraft = useApp((s) => s.openDraft)
  const saveAs = useApp((s) => s.saveAs)
  const renameDraft = useApp((s) => s.renameDraft)
  const duplicateDraft = useApp((s) => s.duplicateDraft)
  const deleteDraft = useApp((s) => s.deleteDraft)
  const updateSettings = useApp((s) => s.updateSettings)
  const updatePrefs = useApp((s) => s.updatePrefs)
  const enqueueExport = useApp((s) => s.enqueueExport)
  const clearCache = useApp((s) => s.clearCache)
  const setActiveSequence = useApp((s) => s.setActiveSequence)

  if (!modal) return null

  return (
    <div className="modal-backdrop" data-testid={`modal-${modal}`} onClick={() => setModal(null)}>
      <div className="modal" style={modal === 'more' ? { width: 'min(360px, 100%)' } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex justify-between items-center" style={{ borderColor: 'var(--border)' }}>
          <span className="font-medium" style={{ fontFamily: 'var(--font-display)' }}>
            {modal === 'drafts' ? '草稿管理' : modal === 'settings' ? '工程设置' : modal === 'prefs' ? '偏好设置' : modal === 'shortcuts' ? '快捷键' : modal === 'more' ? '更多' : '导出'}
          </span>
          <button className="icon-btn" onClick={() => setModal(null)}>×</button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 grid gap-3">
          {modal === 'more' && <MoreActions />}
          {modal === 'drafts' && (
            <>
              <div className="flex gap-2">
                <button className="btn btn-primary" data-testid="btn-new-project" onClick={() => newProject()}>新建项目</button>
                <button className="btn btn-ghost" data-testid="btn-save-as" onClick={() => saveAs(`${useApp.getState().projectName} 副本`)}>另存为</button>
              </div>
              {drafts.map((d) => (
                <div key={d.id} className="flex items-center gap-2 p-2 rounded-lg border" style={{ borderColor: 'var(--border)' }} data-testid={`draft-${d.id}`}>
                  <button className="btn btn-ghost flex-1 justify-start" onClick={() => openDraft(d.id)}>{d.name}</button>
                  <button className="btn btn-ghost" onClick={() => renameDraft(d.id, `${d.name}*`)}>重命名</button>
                  <button className="btn btn-ghost" onClick={() => duplicateDraft(d.id)}>复制</button>
                  <button className="btn btn-ghost" onClick={() => deleteDraft(d.id)}>删</button>
                </div>
              ))}
              <div className="field">
                <label>多序列</label>
                <div className="flex flex-wrap gap-1">
                  {sequences.map((s) => (
                    <button key={s.id} className={`btn btn-ghost ${s.id === activeSeqId ? 'active' : ''}`} onClick={() => setActiveSequence(s.id)}>{s.name}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          {modal === 'settings' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="field"><label>宽度</label><input type="number" data-testid="set-width" value={settings.width} onChange={(e) => updateSettings({ width: +e.target.value })} /></div>
                <div className="field"><label>高度</label><input type="number" data-testid="set-height" value={settings.height} onChange={(e) => updateSettings({ height: +e.target.value })} /></div>
                <div className="field"><label>帧率</label><input type="number" data-testid="set-fps" value={settings.fps} onChange={(e) => updateSettings({ fps: +e.target.value })} /></div>
                <div className="field"><label>静帧秒数</label><input type="number" value={settings.stillDuration} onChange={(e) => updateSettings({ stillDuration: +e.target.value })} /></div>
              </div>
              <div className="field">
                <label>画幅</label>
                <select data-testid="set-aspect" value={settings.aspect} onChange={(e) => {
                  const a = e.target.value
                  const map: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080] }
                  const [w, h] = map[a] ?? [1920, 1080]
                  updateSettings({ aspect: a, width: w, height: h })
                }}>
                  <option value="16:9">16:9 横屏</option>
                  <option value="9:16">9:16 竖屏</option>
                  <option value="1:1">1:1 方形</option>
                  <option value="4:3">4:3</option>
                </select>
              </div>
              <div className="field">
                <label>画布背景</label>
                <select data-testid="set-canvas-bg" value={settings.canvasBg} onChange={(e) => updateSettings({ canvasBg: e.target.value as typeof settings.canvasBg })}>
                  <option value="black">纯黑</option>
                  <option value="color">纯色</option>
                  <option value="blur">模糊</option>
                  <option value="image">图片</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" data-testid="set-proxy" checked={settings.useProxy} onChange={(e) => updateSettings({ useProxy: e.target.checked })} />代理模式
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" data-testid="set-hwaccel" checked={settings.hwAccel} onChange={(e) => updateSettings({ hwAccel: e.target.checked })} />硬件加速
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" data-testid="set-native-preview" checked={!!settings.nativePreview} onChange={(e) => updateSettings({ nativePreview: e.target.checked })} />原生节目预览（B2 popup）
              </label>
              <button className="btn btn-ghost" data-testid="btn-clear-cache" onClick={clearCache}>清理缓存 ({cacheMb.toFixed(1)} MB)</button>
            </>
          )}

          {modal === 'prefs' && (
            <>
              <div className="field">
                <label>性能模式</label>
                <select data-testid="pref-performance" value={prefs.performance} onChange={(e) => updatePrefs({ performance: e.target.value as typeof prefs.performance })}>
                  <option value="quality">质量</option>
                  <option value="balanced">平衡</option>
                  <option value="speed">速度</option>
                </select>
              </div>
              <div className="field">
                <label>预览缓存分辨率</label>
                <select
                  data-testid="pref-preview-cache-res"
                  value={prefs.previewCacheMaxEdge ?? 720}
                  onChange={(e) => updatePrefs({ previewCacheMaxEdge: +e.target.value as 0 | 480 | 720 | 1080 })}
                >
                  <option value={480}>480p（省内存、更长可缓存）</option>
                  <option value={720}>720p（默认）</option>
                  <option value={1080}>1080p（更清晰）</option>
                  <option value={0}>与监视器同分辨率</option>
                </select>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  仅影响播放 RAM 缓存清晰度与可缓存时长；改后需重新播放填充绿条
                </p>
              </div>
              <div className="field"><label>默认时长</label><input type="number" value={prefs.defaultDuration} onChange={(e) => updatePrefs({ defaultDuration: +e.target.value })} /></div>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>快捷键：Space 播放 · S 吸附 · V 选择 · C 剃刀 · Ctrl+Z 撤销</p>
            </>
          )}

          {modal === 'shortcuts' && (
            <div className="grid gap-1" data-testid="shortcuts-list">
              {SHORTCUTS.map((s) => (
                <div key={`${s.cat}-${s.keys}`} className="flex justify-between gap-4 text-[12px] py-1 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{s.cat}</span>
                  <kbd className="tabular-nums px-1.5 py-0.5 rounded text-[11px]" style={{ background: 'var(--surface-2)' }}>{s.keys}</kbd>
                  <span className="flex-1 text-right">{s.action}</span>
                </div>
              ))}
            </div>
          )}

          {modal === 'export' && (
            <>
              {[
                { id: '1080p', label: '横屏 1080p H.264' },
                { id: '9x16', label: '竖屏 9:16' },
                { id: 'audio', label: '仅音频 MP3' },
                { id: 'range', label: '工作区区间' },
                { id: 'frame', label: '静帧封面' },
              ].map((p) => (
                <button
                  key={p.id}
                  className="btn btn-ghost justify-start"
                  data-testid={`export-${p.id}`}
                  onClick={() => enqueueExport({
                    preset: p.id,
                    audioOnly: p.id === 'audio',
                    rangeOnly: p.id === 'range',
                  })}
                >
                  {p.label}
                </button>
              ))}
              {exportQueue.map((j) => (
                <div key={j.id} className="text-[12px]" data-testid={`export-job-${j.id}`}>
                  {j.name} — {j.status} {Math.round(j.progress)}%
                  {j.error ? <div style={{ color: 'var(--danger, #c44)' }}>{j.error}</div> : null}
                  {j.path && j.status === 'done' ? (
                    <div className="truncate" style={{ color: 'var(--text-muted)' }} title={j.path}>{j.path}</div>
                  ) : null}
                  <div className="h-1.5 rounded-full mt-1" style={{ background: 'var(--surface-2)' }}>
                    <div className="h-full rounded-full" style={{ width: `${j.progress}%`, background: 'var(--accent)' }} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
