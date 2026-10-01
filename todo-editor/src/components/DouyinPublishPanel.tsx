import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from '../store'
import { desktop, isDesktopApp } from '../lib/desktop'
import { fetchDouyinMeta, generateDouyinCover } from '../lib/douyinPublishAi'
import { pathToFileUrl } from '../lib/importFiles'

type Asset = {
  id: string
  slug: string
  title: string
  caption?: string
  tags?: string[]
  kind?: string
  video_path?: string
  cover_path?: string
  cover_url?: string
  folder?: string
  updated_at?: number
}

type Phone = {
  serial: string
  state: string
  model?: string
  product?: string
  douyin?: boolean
}

type Tab = 'publish' | 'stage'

const LS_KEY = 'todo-douyin-ui'

function todayYmd() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function defaultSlug(title: string) {
  const base = title.trim().replace(/[<>:"/\\|?*\s]+/g, '-').replace(/-+/g, '-').slice(0, 40)
  return `${todayYmd()}${base ? `-${base}` : ''}`
}

function loadUi() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {} as { selectedSlug?: string; tab?: Tab }
    return JSON.parse(raw) as { selectedSlug?: string; tab?: Tab }
  } catch {
    return {} as { selectedSlug?: string; tab?: Tab }
  }
}

function saveUi(next: { selectedSlug?: string | null; tab?: Tab }) {
  const prev = loadUi()
  localStorage.setItem(LS_KEY, JSON.stringify({
    selectedSlug: next.selectedSlug ?? prev.selectedSlug,
    tab: next.tab ?? prev.tab,
  }))
}

function coverSrc(a: Asset | null | undefined) {
  if (!a) return ''
  if (a.cover_url) return a.cover_url
  if (a.cover_path) return pathToFileUrl(a.cover_path)
  return ''
}

function phoneLabel(p: Phone) {
  const name = p.model || p.product || '手机'
  const state = p.state === 'device' ? '已连接' : p.state === 'unauthorized' ? '未授权' : p.state
  const dy = p.douyin ? ' · 抖音运行中' : ''
  return `${name} · ${state}${dy}`
}

/** 内置抖音发布台：资产库 + 发布页 + 新投放 */
export function DouyinPublishPanel() {
  const setModal = useApp((s) => s.setModal)
  const exportQueue = useApp((s) => s.exportQueue)
  const projectName = useApp((s) => s.projectName)
  const script = useApp((s) => s.script)
  const lastDone = useMemo(
    () => [...exportQueue].reverse().find((j) => j.status === 'done' && j.path && !j.audioOnly),
    [exportQueue],
  )

  const [tab, setTab] = useState<Tab>(() => loadUi().tab || 'publish')
  const [videoPath, setVideoPath] = useState(lastDone?.path ?? '')
  const [coverPath, setCoverPath] = useState('')
  const [coverPreview, setCoverPreview] = useState('')
  const [title, setTitle] = useState(projectName || '成片')
  const [caption, setCaption] = useState('仅供参考，不构成投资建议。')
  const [tags, setTags] = useState('财经,A股')
  const [styleHint, setStyleHint] = useState('财经黑板粉笔风，深色黑板，粉笔白字与橙色强调')
  const [slug, setSlug] = useState(() => defaultSlug(projectName || '成片'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [inbox, setInbox] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [selected, setSelected] = useState<string | null>(() => loadUi().selectedSlug || null)
  const [phones, setPhones] = useState<Phone[]>([])
  const [phoneSerial, setPhoneSerial] = useState<string>('')
  const [phonesBusy, setPhonesBusy] = useState(false)
  const [restored, setRestored] = useState(false)

  const selectedAsset = useMemo(
    () => assets.find((a) => a.slug === selected) || null,
    [assets, selected],
  )

  const applyAssetToForm = useCallback((a: Asset) => {
    setSelected(a.slug)
    setTitle(a.title || a.slug)
    setCaption(a.caption || '')
    setTags(Array.isArray(a.tags) ? a.tags.join(',') : '')
    setSlug(a.slug)
    setCoverPath(a.cover_path || '')
    setCoverPreview(coverSrc(a))
    setVideoPath(a.video_path || '')
    setTab('publish')
    saveUi({ selectedSlug: a.slug, tab: 'publish' })
  }, [])

  const refreshAssets = useCallback(async () => {
    const api = desktop()
    if (!api?.douyinListAssets) return null
    const [st, list] = await Promise.all([api.douyinStatus?.(), api.douyinListAssets()])
    if (st?.inbox) setInbox(st.inbox)
    const next = list.ok ? ((list.assets || []) as Asset[]) : []
    if (list.ok) setAssets(next)
    return { status: st, assets: next }
  }, [])

  const refreshPhones = useCallback(async () => {
    const api = desktop()
    if (!api?.douyinPublish) return
    setPhonesBusy(true)
    try {
      const r = await api.douyinPublish({ action: 'phones' })
      const list = Array.isArray(r.phones) ? (r.phones as Phone[]) : []
      setPhones(list)
      setPhoneSerial((prev) => {
        if (prev && list.some((p) => p.serial === prev && p.state === 'device')) return prev
        const ready = list.find((p) => p.state === 'device')
        return ready?.serial || ''
      })
      if (!r.ok && r.error) setMsg((m) => m || String(r.error))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setPhonesBusy(false)
    }
  }, [])

  useEffect(() => {
    if (lastDone?.path && tab === 'stage' && !videoPath) setVideoPath(lastDone.path)
  }, [lastDone?.path, videoPath, tab])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const pack = await refreshAssets()
      if (!alive || !pack) return
      if (!restored) {
        const want = pack.status?.selectedSlug || loadUi().selectedSlug || null
        const hit = want ? pack.assets.find((a) => a.slug === want) : null
        if (hit) {
          applyAssetToForm(hit)
          void desktop()?.douyinUseAsset?.(hit.slug)
        } else if (pack.assets[0] && (loadUi().tab || 'publish') === 'publish') {
          applyAssetToForm(pack.assets[0])
        } else {
          setTab(loadUi().tab === 'stage' ? 'stage' : 'publish')
        }
        setRestored(true)
      }
    })()
    const id = setInterval(() => { void refreshAssets() }, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [refreshAssets, applyAssetToForm, restored])

  useEffect(() => {
    void refreshPhones()
    const id = setInterval(() => { void refreshPhones() }, 8000)
    return () => clearInterval(id)
  }, [refreshPhones])

  const pickVideo = async () => {
    const r = await desktop()?.pickVideoFile?.()
    if (r?.ok && r.path) setVideoPath(r.path)
  }
  const pickCover = async () => {
    const r = await desktop()?.pickImageFile?.()
    if (r?.ok && r.path) {
      setCoverPath(r.path)
      setCoverPreview(r.url || pathToFileUrl(r.path))
    }
  }

  const selectAsset = async (id: string) => {
    const a = assets.find((x) => x.slug === id || x.id === id)
    if (!a) return
    applyAssetToForm(a)
    const r = await desktop()?.douyinUseAsset?.(a.slug)
    setMsg(r?.ok ? `已打开发布页：${a.title || a.slug}` : (r?.error || '选用失败'))
  }

  const writeMeta = async () => {
    setBusy(true)
    setMsg('AI 正在写标题/简介/标签…')
    try {
      const meta = await fetchDouyinMeta({
        projectName: projectName || title,
        script,
        hint: title !== projectName ? title : undefined,
      })
      setTitle(meta.title)
      setCaption(meta.caption)
      setTags(meta.tags.join(','))
      if (tab === 'stage') setSlug(defaultSlug(meta.title))
      setMsg('文案已生成')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const makeCover = async () => {
    if (!title.trim()) { setMsg('请先填写或生成标题'); return }
    setBusy(true)
    try {
      const r = await generateDouyinCover({
        title: title.trim(),
        styleHint,
        onProgress: (m) => setMsg(m),
      })
      setCoverPath(r.path)
      setCoverPreview(r.previewUrl)
      if (tab === 'publish' && selected) {
        const attached = await desktop()?.douyinAttachCover?.({ slug: selected, coverPath: r.path })
        if (attached?.ok) {
          setMsg('封面已生成并写入资产')
          await refreshAssets()
          return
        }
      }
      setMsg('封面已生成（标题已画进画面）')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const savePublishMeta = async () => {
    if (!selected) { setMsg('请先选中资产'); return false }
    const api = desktop()
    if (!api?.douyinSaveMeta) { setMsg('需在桌面版使用'); return false }
    const r = await api.douyinSaveMeta({
      slug: selected,
      meta: {
        title: title.trim() || selected,
        caption: caption.trim(),
        tags: tags.split(/[,，#\s]+/).map((t) => t.trim()).filter(Boolean),
        trade_date: todayYmd(),
      },
    })
    if (!r.ok) { setMsg(r.error || '保存失败'); return false }
    await refreshAssets()
    return true
  }

  const stage = async (opts?: { withAi?: boolean }) => {
    const api = desktop()
    if (!api?.douyinStageAsset) { setMsg('需在桌面版使用'); return }
    setBusy(true)
    setMsg(null)
    try {
      let nextTitle = title
      let nextCaption = caption
      let nextTags = tags
      let nextCover = coverPath
      let nextSlug = slug

      if (opts?.withAi) {
        setMsg('① AI 写文案…')
        const meta = await fetchDouyinMeta({
          projectName: projectName || title,
          script,
        })
        nextTitle = meta.title
        nextCaption = meta.caption
        nextTags = meta.tags.join(',')
        nextSlug = defaultSlug(meta.title)
        setTitle(nextTitle)
        setCaption(nextCaption)
        setTags(nextTags)
        setSlug(nextSlug)

        setMsg('② AI 生成竖封面…')
        const cover = await generateDouyinCover({
          title: nextTitle,
          styleHint,
          onProgress: (m) => setMsg(`② ${m}`),
        })
        nextCover = cover.path
        setCoverPath(cover.path)
        setCoverPreview(cover.previewUrl)
      }

      if (!videoPath && !nextCover) { setMsg('请选择成片或先生成封面'); return }

      setMsg('③ 投放到资产库…')
      const r = await api.douyinStageAsset({
        videoPath: videoPath || undefined,
        coverPath: nextCover || undefined,
        slug: nextSlug.trim() || undefined,
        openDesk: false,
        useAsset: true,
        meta: {
          title: nextTitle.trim() || nextSlug,
          caption: nextCaption.trim() || `${nextTitle}。仅供参考，不构成投资建议。`,
          tags: nextTags.split(/[,，#\s]+/).map((t) => t.trim()).filter(Boolean),
          trade_date: todayYmd(),
        },
      })
      if (!r.ok) { setMsg(r.error || '投放失败'); return }
      const pack = await refreshAssets()
      const hit = pack?.assets.find((a) => a.slug === r.slug)
      if (hit) applyAssetToForm(hit)
      else if (r.slug) {
        setSelected(r.slug)
        setTab('publish')
        saveUi({ selectedSlug: r.slug, tab: 'publish' })
      }
      setMsg(`${r.note || '已投放'}：${r.dir}`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runAdb = async (action: 'push' | 'stage' | 'fill') => {
    if (!selected) { setMsg('请先在左侧选中要发的资产'); return }
    setBusy(true)
    setMsg(null)
    try {
      if (!(await savePublishMeta())) return
      const labels = { push: '推到手机相册', stage: '打开抖音发布页', fill: '填写标题简介' } as const
      setMsg(`${labels[action]}…`)
      const r = await desktop()?.douyinPublish?.({
        action,
        serial: phoneSerial || undefined,
      })
      if (!r?.ok) {
        setMsg(r?.error || `${action} 失败`)
        return
      }
      const serial = typeof r.serial === 'string' ? r.serial : phoneSerial
      if (action === 'fill') {
        setMsg(`已填到 ${serial || '手机'}。请检查后自己点「发作品」。`)
      } else if (action === 'stage') {
        setMsg(`已到发布页（${serial || '手机'}）。可继续点「填标题简介」。`)
      } else {
        setMsg(`已推送到 ${serial || '手机'} 相册`)
      }
      void refreshPhones()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!isDesktopApp()) {
    return <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>抖音发布台仅桌面版可用。</p>
  }

  const readyPhones = phones.filter((p) => p.state === 'device')
  const publishCover = coverPreview || coverSrc(selectedAsset)

  return (
    <div className="grid gap-3" data-testid="douyin-publish-panel" style={{ minWidth: 'min(780px, 100%)' }}>
      {/* 手机状态条 */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        data-testid="dy-phones"
      >
        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>手机</span>
        {!phones.length && !phonesBusy ? (
          <span className="text-[12px]" style={{ color: 'var(--accent)' }}>未检测到设备 · 请开 USB 调试并授权</span>
        ) : null}
        {phones.map((p) => {
          const active = p.serial === phoneSerial
          const ok = p.state === 'device'
          return (
            <button
              key={p.serial}
              type="button"
              className="btn text-[11px]"
              data-testid={`dy-phone-${p.serial}`}
              style={{
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: ok ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
              onClick={() => setPhoneSerial(p.serial)}
              title={p.serial}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full mr-1.5"
                style={{ background: ok ? '#3a9a5a' : '#c45c3e' }}
              />
              {phoneLabel(p)}
            </button>
          )
        })}
        <button
          type="button"
          className="btn btn-ghost text-[11px] ml-auto"
          data-testid="dy-phones-refresh"
          disabled={phonesBusy}
          onClick={() => { void refreshPhones() }}
        >
          {phonesBusy ? '扫描中…' : '刷新手机'}
        </button>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(200px, 240px) 1fr', minHeight: 420 }}>
        {/* 左侧资产库 */}
        <aside
          className="flex flex-col gap-2 rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-1)' }}
          data-testid="dy-assets"
        >
          <div className="flex items-center justify-between px-2.5 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-[12px] font-medium" style={{ fontFamily: 'var(--font-display)' }}>
              资产库 ({assets.length})
            </span>
            <button type="button" className="btn btn-ghost text-[10px]" onClick={() => { void refreshAssets() }}>刷新</button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 grid gap-1.5" style={{ maxHeight: 460 }}>
            <button
              type="button"
              className={`btn justify-start text-left text-[11px] ${tab === 'stage' ? 'btn-primary' : 'btn-ghost'}`}
              data-testid="dy-tab-stage"
              onClick={() => {
                setTab('stage')
                saveUi({ tab: 'stage', selectedSlug: selected })
                setTitle(projectName || '成片')
                setCaption('仅供参考，不构成投资建议。')
                setTags('财经,A股')
                setSlug(defaultSlug(projectName || '成片'))
                setCoverPath('')
                setCoverPreview('')
                setVideoPath(lastDone?.path ?? '')
              }}
            >
              + 新投放成片
            </button>
            {!assets.length ? (
              <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>暂无资产。先投放成片。</p>
            ) : assets.map((a) => {
              const on = selected === a.slug && tab === 'publish'
              const thumb = coverSrc(a)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="text-left rounded-md overflow-hidden"
                  data-testid={`dy-asset-${a.id}`}
                  style={{
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent-dim)' : 'var(--surface-0)',
                  }}
                  onClick={() => { void selectAsset(a.slug) }}
                >
                  <div className="flex gap-2 p-1.5">
                    <div
                      className="shrink-0 rounded overflow-hidden flex items-center justify-center"
                      style={{ width: 42, height: 56, background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>无封面</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="text-[12px] font-medium truncate">{a.title || a.slug}</div>
                      <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }} title={a.slug}>
                        {a.slug}
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {a.kind === 'video' ? '视频' : '纯图'}
                        {a.cover_path ? ' · 有封面' : ' · 缺封面'}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
          <div className="px-2 pb-2">
            <button type="button" className="btn btn-ghost text-[10px] w-full" data-testid="dy-reveal" onClick={() => { void desktop()?.douyinRevealInbox?.() }}>
              打开 inbox 文件夹
            </button>
            {inbox ? (
              <div className="text-[9px] truncate mt-1 px-0.5" style={{ color: 'var(--text-muted)' }} title={inbox}>{inbox}</div>
            ) : null}
          </div>
        </aside>

        {/* 右侧：发布页 / 新投放 */}
        <section className="grid gap-3 content-start">
          {tab === 'publish' && !selectedAsset ? (
            <div className="rounded-lg p-6 text-center" style={{ border: '1px dashed var(--border)' }}>
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>从左侧选一条资产，进入对应发布页</p>
              <button type="button" className="btn btn-primary mt-3" onClick={() => {
                setTab('stage')
                saveUi({ tab: 'stage' })
              }}>
                去投放新成片
              </button>
            </div>
          ) : null}

          {(tab === 'publish' && selectedAsset) || tab === 'stage' ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[14px] font-medium m-0" style={{ fontFamily: 'var(--font-display)' }}>
                  {tab === 'publish' ? '发布页' : '新投放'}
                </h3>
                {tab === 'publish' && selectedAsset ? (
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={selectedAsset.folder || selectedAsset.slug}>
                    {selectedAsset.slug}
                  </span>
                ) : null}
              </div>

              <div className="grid gap-3" style={{ gridTemplateColumns: '140px 1fr' }}>
                <div className="grid gap-2">
                  <div
                    className="rounded-lg overflow-hidden flex items-center justify-center"
                    style={{
                      aspectRatio: '3 / 4',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                    }}
                    data-testid="dy-cover-preview"
                  >
                    {publishCover ? (
                      <img src={publishCover} alt="封面" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-[11px] px-2 text-center" style={{ color: 'var(--text-muted)' }}>竖封面 3:4</span>
                    )}
                  </div>
                  <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-ai-cover" disabled={busy} onClick={() => { void makeCover() }}>
                    AI 生成封面
                  </button>
                  <button type="button" className="btn btn-ghost text-[11px]" onClick={() => { void pickCover() }}>换本机图</button>
                </div>

                <div className="grid gap-2 content-start">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-ai-meta" disabled={busy} onClick={() => { void writeMeta() }}>
                      AI 写文案
                    </button>
                    {tab === 'stage' ? (
                      <button type="button" className="btn btn-primary text-[11px]" data-testid="dy-ai-all" disabled={busy} onClick={() => { void stage({ withAi: true }) }}>
                        {busy ? '处理中…' : '一键：文案+封面+投放'}
                      </button>
                    ) : (
                      <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-save-meta" disabled={busy} onClick={() => { void (async () => {
                        setBusy(true)
                        const ok = await savePublishMeta()
                        if (ok) setMsg('文案已写回资产')
                        setBusy(false)
                      })() }}>
                        保存文案
                      </button>
                    )}
                  </div>

                  <div className="field">
                    <label>标题</label>
                    <input data-testid="dy-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>简介</label>
                    <textarea className="input" rows={3} data-testid="dy-caption" value={caption} onChange={(e) => setCaption(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>标签（逗号分隔）</label>
                    <input data-testid="dy-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>封面风格（生图）</label>
                    <input data-testid="dy-style" value={styleHint} onChange={(e) => setStyleHint(e.target.value)} />
                  </div>
                </div>
              </div>

              {tab === 'stage' ? (
                <>
                  <div className="field">
                    <label>成片视频</label>
                    <div className="flex gap-2">
                      <input className="input flex-1" data-testid="dy-video" value={videoPath} onChange={(e) => setVideoPath(e.target.value)} placeholder="mp4 路径" />
                      <button type="button" className="btn btn-ghost" onClick={() => { void pickVideo() }}>浏览</button>
                    </div>
                    {lastDone?.path ? (
                      <button type="button" className="btn btn-ghost text-[11px] justify-start mt-1" onClick={() => setVideoPath(lastDone.path!)}>
                        用最近导出：{lastDone.name}
                      </button>
                    ) : null}
                  </div>
                  <div className="field">
                    <label>文件夹名</label>
                    <input data-testid="dy-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
                  </div>
                  <button type="button" className="btn btn-ghost" data-testid="dy-stage" disabled={busy} onClick={() => { void stage() }}>
                    仅投放（用当前文案/封面）
                  </button>
                </>
              ) : (
                <div
                  className="rounded-lg p-3 grid gap-2"
                  style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}
                >
                  <div className="text-[12px] font-medium">发到手机</div>
                  <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>
                    {readyPhones.length
                      ? `当前机：${phoneSerial || readyPhones[0].serial}。填好后请你自己点「发作品」。`
                      : '先连接并授权手机，再推送。'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-push" disabled={busy || !readyPhones.length} onClick={() => { void runAdb('push') }}>
                      1. 推相册
                    </button>
                    <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-stage-adb" disabled={busy || !readyPhones.length} onClick={() => { void runAdb('stage') }}>
                      2. 推到发布页
                    </button>
                    <button type="button" className="btn btn-primary text-[11px]" data-testid="dy-fill" disabled={busy || !readyPhones.length} onClick={() => { void runAdb('fill') }}>
                      3. 填标题简介
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}

          {msg ? (
            <div className="text-[12px]" style={{ color: /失败|错误|超时|未检测/.test(msg) ? 'var(--accent)' : 'var(--text-muted)' }}>
              {msg}
            </div>
          ) : null}

          <div className="flex justify-end">
            <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>关闭</button>
          </div>
        </section>
      </div>
    </div>
  )
}
