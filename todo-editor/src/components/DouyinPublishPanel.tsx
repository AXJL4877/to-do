import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import { desktop, isDesktopApp } from '../lib/desktop'
import { fetchDouyinMeta, generateDouyinCover, generateMetaAndCover, pickCoverHeadline, pickCoverStyleHint, resolvePublishBrief } from '../lib/douyinPublishAi'
import { takeDouyinPendingVideo } from '../lib/douyinPending'
import { pathToFileUrl } from '../lib/importFiles'
import { CreativeProgress } from './CreativeProgress'
import { runIndependentTasks } from '../lib/independentTasks'

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
  video_bytes?: number
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

function withBust(url: string, bust?: number | string) {
  if (!url || bust == null || bust === '') return url
  return `${url}${url.includes('?') ? '&' : '?'}t=${bust}`
}

function coverSrc(a: Asset | null | undefined, bust?: number | string) {
  if (!a) return ''
  if (a.cover_url) return withBust(a.cover_url, bust ?? a.updated_at)
  if (a.cover_path) return withBust(pathToFileUrl(a.cover_path), bust ?? a.updated_at)
  return ''
}

function seedStyleHint(seed: { coverText?: string; theme?: string; visual?: string } | null | undefined) {
  if (!seed) return ''
  return [seed.coverText, seed.theme, seed.visual].filter(Boolean).join('。')
}

function fileBase(p?: string | null) {
  if (!p) return ''
  const s = String(p).replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function formatBytes(n?: number) {
  if (!n || n <= 0) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function phoneLabel(p: Phone) {
  const name = p.model || p.product || '手机'
  const state = p.state === 'device' ? '已连接' : p.state === 'unauthorized' ? '未授权' : p.state
  const dy = p.douyin ? ' · 抖音运行中' : ''
  return `${name} · ${state}${dy}`
}

function normPath(p?: string | null) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

function applyBriefNote(source: string, title: string) {
  if (source === 'script') return '文案来源：本工程口播 + 项目主题'
  if (source === 'production') return `文案来源：工程口播不足，已用最长成片稿「${title}」兜底`
  return '文案来源：项目名（暂无口播稿）'
}

/** 内置抖音发布台：资产库 + 发布页 + 新投放 */
export function DouyinPublishPanel() {
  const setModal = useApp((s) => s.setModal)
  const exportQueue = useApp((s) => s.exportQueue)
  const projectName = useApp((s) => s.projectName)
  const script = useApp((s) => s.script)
  const recentExports = useMemo(
    () => [...exportQueue].reverse().filter((j) => j.status === 'done' && j.path && !j.audioOnly).slice(0, 8),
    [exportQueue],
  )
  const lastDone = recentExports[0]

  const publishSeed = useApp((s) => s.publishSeed)
  const coverSeed = useApp((s) => s.coverSeed)
  const [tab, setTab] = useState<Tab>(() => loadUi().tab || 'publish')
  const [videoPath, setVideoPath] = useState(lastDone?.path ?? '')
  const [coverPath, setCoverPath] = useState('')
  const [coverPreview, setCoverPreview] = useState('')
  const [title, setTitle] = useState(() => coverSeed?.title || publishSeed?.title || projectName || '成片')
  const [caption, setCaption] = useState(() => publishSeed?.description || '仅供参考，不构成投资建议。')
  const [tags, setTags] = useState(() => publishSeed?.tags?.length ? publishSeed.tags.join(',') : '财经,A股')
  const [styleHint, setStyleHint] = useState(() => seedStyleHint(coverSeed) || '财经黑板粉笔风，深色黑板，粉笔白字与橙色强调')
  const [slug, setSlug] = useState(() => defaultSlug(coverSeed?.title || publishSeed?.title || projectName || '成片'))
  /** 拆开忙态：文案 / 封面可并行；投放与 ADB 共用 actionBusy */
  const [metaBusy, setMetaBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [metaMsg, setMetaMsg] = useState<string | null>(null)
  const [coverMsg, setCoverMsg] = useState<string | null>(null)
  const [inbox, setInbox] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [selected, setSelected] = useState<string | null>(() => loadUi().selectedSlug || null)
  const [phones, setPhones] = useState<Phone[]>([])
  const [phoneSerial, setPhoneSerial] = useState<string>('')
  const [phonesBusy, setPhonesBusy] = useState(false)
  const [phonesError, setPhonesError] = useState<string | null>(null)
  const [usbNames, setUsbNames] = useState<string[]>([])
  const [restored, setRestored] = useState(false)
  /** 用户是否亲手选过成片路径；未选手动时跟随最近导出 */
  const [videoLocked, setVideoLocked] = useState(false)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  /** 发布台专用文稿（优先工程口播），不覆盖工程口播备忘录 */
  const [publishScript, setPublishScript] = useState(script)
  const titleRef = useRef(title)
  const styleHintRef = useRef(styleHint)
  const coverBusyRef = useRef(coverBusy)
  const coverPreviewRef = useRef(coverPreview)
  titleRef.current = title
  styleHintRef.current = styleHint
  coverBusyRef.current = coverBusy
  coverPreviewRef.current = coverPreview

  useLayoutEffect(() => {
    if (!publishSeed) return
    setTitle(publishSeed.title || projectName || '成片')
    setCaption(publishSeed.description || '')
    setTags(publishSeed.tags.join(','))
    setPublishScript(publishSeed.body)
    setSlug(defaultSlug(publishSeed.title || projectName || '成片'))
    setSourceNote(`发布信息来自稿件版本 ${publishSeed.revision}，不含创作简报`)
    setTab('stage')
  }, [publishSeed, projectName])

  useLayoutEffect(() => {
    if (!coverSeed) return
    if (coverSeed.title) setTitle(coverSeed.title)
    const hint = seedStyleHint(coverSeed)
    if (hint) setStyleHint(hint)
    setCoverMsg('已带入标题、封面短句和主题。确认后再生成，不会自动开始。')
    setTab('stage')
  }, [coverSeed])

  const selectedAsset = useMemo(
    () => assets.find((a) => a.slug === selected) || null,
    [assets, selected],
  )

  /** 当前正在编辑/发布的那条成片路径（发布页跟资产，新投放跟表单） */
  const activeVideoPath = tab === 'publish'
    ? (selectedAsset?.video_path || videoPath || '')
    : (videoPath || '')
  const activeVideoName = fileBase(activeVideoPath) || (activeVideoPath ? '未命名视频' : '')
  const anyBusy = metaBusy || coverBusy || actionBusy
  const exportMismatch = !!(
    lastDone?.path
    && activeVideoPath
    && normPath(lastDone.path) !== normPath(activeVideoPath)
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
    setVideoLocked(true)
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

  const refreshPhones = useCallback(async (opts?: { restartAdb?: boolean }) => {
    const api = desktop()
    if (!api?.douyinPublish) return
    setPhonesBusy(true)
    try {
      const r = await api.douyinPublish({
        action: opts?.restartAdb ? 'restart-adb' : 'phones',
        restartAdb: opts?.restartAdb,
      })
      const list = Array.isArray(r.phones) ? (r.phones as Phone[]) : []
      setPhones(list)
      const usb = (r.usb as { phones?: { name?: string; adb?: boolean }[] } | undefined)?.phones || []
      setUsbNames([...new Set(usb.map((p) => String(p.name || '')).filter(Boolean))].slice(0, 4))
      setPhoneSerial((prev) => {
        if (prev && list.some((p) => p.serial === prev && p.state === 'device')) return prev
        const ready = list.find((p) => p.state === 'device')
        return ready?.serial || ''
      })
      const hint = typeof r.hint === 'string' ? r.hint : ''
      if (list.some((p) => p.state === 'device')) {
        setPhonesError(null)
      } else if (hint) {
        setPhonesError(hint)
      } else if (!r.ok) {
        setPhonesError(String(r.error || '检测手机失败'))
      } else if (!list.length) {
        setPhonesError('未检测到可调试的手机')
      } else {
        const st = list.map((p) => p.state).join('/')
        setPhonesError(`已看到 ${list.length} 台设备（${st}），但还不能推送`)
      }
    } catch (e) {
      setPhonesError(e instanceof Error ? e.message : String(e))
    } finally {
      setPhonesBusy(false)
    }
  }, [])

  useEffect(() => {
    if (lastDone?.path && !videoLocked && tab === 'stage') setVideoPath(lastDone.path)
  }, [lastDone?.path, videoLocked, tab])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const pending = takeDouyinPendingVideo()
      const pack = await refreshAssets()
      if (!alive || !pack) return
      if (!restored) {
        const exportPath = pending || lastDone?.path || ''
        const seeded = !!(useApp.getState().coverSeed || useApp.getState().publishSeed)
        const keepCover = coverBusyRef.current || !!coverPreviewRef.current

        if (seeded) {
          if (exportPath) {
            setVideoPath(exportPath)
            setVideoLocked(true)
          }
          setRestored(true)
          return
        }

        // 1) 从导出队列点进来，或最近导出尚未进资产库 → 新投放该成片
        if (exportPath && (pending || !pack.assets.some((a) => normPath(a.video_path) === normPath(exportPath)))) {
          setTab('stage')
          setSelected(null)
          setVideoPath(exportPath)
          setVideoLocked(true)
          if (!keepCover) {
            setCoverPath('')
            setCoverPreview('')
          }
          saveUi({ selectedSlug: null, tab: 'stage' })
          setMsg(`已选中成片：${fileBase(exportPath)}（来自最近导出）`)
          try {
            const brief = await resolvePublishBrief({ projectName, script })
            if (!coverBusyRef.current && !coverPreviewRef.current) {
              setTitle(brief.title)
              setSlug(defaultSlug(brief.title))
              setStyleHint(brief.styleHint)
            }
            setPublishScript(brief.script || script)
            setSourceNote(applyBriefNote(brief.source, brief.title))
          } catch { /* */ }
          setRestored(true)
          return
        }

        // 2) 资产库已有同路径视频 → 进该条发布页
        if (exportPath && !coverBusyRef.current && !coverPreviewRef.current) {
          const hitByVideo = pack.assets.find((a) => normPath(a.video_path) === normPath(exportPath))
          if (hitByVideo) {
            applyAssetToForm(hitByVideo)
            void desktop()?.douyinUseAsset?.(hitByVideo.slug)
            setMsg(`已打开资产：${hitByVideo.title || hitByVideo.slug} · ${fileBase(hitByVideo.video_path)}`)
            setRestored(true)
            return
          }
        }

        // 3) 恢复上次选中 / 最新资产
        const want = loadUi().selectedSlug || pack.status?.selectedSlug || null
        const hit = want ? pack.assets.find((a) => a.slug === want) : null
        const newest = [...pack.assets].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
        if (hit) {
          applyAssetToForm(hit)
          void desktop()?.douyinUseAsset?.(hit.slug)
        } else if (newest && (loadUi().tab || 'publish') === 'publish') {
          applyAssetToForm(newest)
        } else {
          setTab(loadUi().tab === 'stage' ? 'stage' : 'publish')
        }
        setRestored(true)
      }
    })()
    const id = setInterval(() => { void refreshAssets() }, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [refreshAssets, applyAssetToForm, restored, lastDone?.path, projectName, script])

  useEffect(() => {
    void refreshPhones()
    const id = setInterval(() => { void refreshPhones() }, 12000)
    return () => clearInterval(id)
  }, [refreshPhones])

  /** 打开新投放：用本工程口播 + 项目主题，不用「最近一次成片任务」 */
  const prepareStageFromLatest = useCallback(async () => {
    setTab('stage')
    setSelected(null)
    setCoverPath('')
    setCoverPreview('')
    setMetaMsg(null)
    setCoverMsg(null)
    saveUi({ selectedSlug: null, tab: 'stage' })
    if (lastDone?.path) {
      setVideoPath(lastDone.path)
      setVideoLocked(false)
    }
    try {
      const brief = await resolvePublishBrief({ projectName, script })
      setTitle(brief.title)
      setSlug(defaultSlug(brief.title))
      setStyleHint(brief.styleHint)
      setPublishScript(brief.script || script)
      setSourceNote(applyBriefNote(brief.source, brief.title))
    } catch {
      setTitle(projectName || '成片')
      setSlug(defaultSlug(projectName || '成片'))
      setPublishScript(script)
      setSourceNote(script?.trim() ? '文案来源：本工程口播 + 项目主题' : null)
    }
  }, [lastDone?.path, projectName, script])

  const pickVideo = async () => {
    const r = await desktop()?.pickVideoFile?.()
    if (r?.ok && r.path) {
      setVideoPath(r.path)
      setVideoLocked(true)
    }
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
    setMetaMsg(null)
    setCoverMsg(null)
    const r = await desktop()?.douyinUseAsset?.(a.slug)
    setMsg(r?.ok
      ? `已选：${a.title || a.slug}${a.video_path ? ` · ${fileBase(a.video_path)}` : ' · 无视频'}`
      : (r?.error || '选用失败'))
  }

  const writeMeta = async () => {
    if (metaBusy) return
    setMetaBusy(true)
    setMetaMsg('AI 正在写标题/简介/标签…')
    try {
      const brief = await resolvePublishBrief({ projectName, script: script || publishScript })
      setPublishScript(brief.script || script || publishScript)
      setSourceNote(applyBriefNote(brief.source, brief.title))
      const meta = await fetchDouyinMeta({
        projectName: projectName || brief.title || title,
        script: brief.script || script || publishScript,
        hint: brief.title && brief.title !== projectName ? brief.title : undefined,
      })
      setTitle(meta.title)
      setCaption(meta.caption)
      setTags(meta.tags.join(','))
      if (tab === 'stage') setSlug(defaultSlug(meta.title))
      setMetaMsg('文案已生成')
    } catch (e) {
      setMetaMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMetaBusy(false)
    }
  }

  const makeCover = async () => {
    if (coverBusy) return
    const headline = pickCoverHeadline({
      formTitle: titleRef.current,
      seedTitle: useApp.getState().coverSeed?.title,
      projectName,
    })
    if (!headline.trim()) { setCoverMsg('请先填写或生成标题'); return }
    if (headline !== title) setTitle(headline)
    setCoverBusy(true)
    try {
      const brief = await resolvePublishBrief({ projectName, script: script || publishScript })
      const r = await generateDouyinCover({
        title: headline,
        styleHint: pickCoverStyleHint({
          formHint: styleHintRef.current,
          seedHint: seedStyleHint(useApp.getState().coverSeed),
        }),
        script: brief.script || script || publishScript,
        quality: '1K',
        onProgress: (m) => setCoverMsg(m),
      })
      setCoverPath(r.path)
      setCoverPreview(withBust(r.previewUrl, r.jobId))
      if (tab === 'publish' && selected) {
        const attached = await desktop()?.douyinAttachCover?.({ slug: selected, coverPath: r.path })
        if (attached?.ok) {
          setCoverMsg('封面已按文案生成并写入资产')
          await refreshAssets()
          return
        }
      }
      setCoverMsg('封面已按文案生成（标题画进画面）')
    } catch (e) {
      setCoverMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setCoverBusy(false)
    }
  }

  /** 发布页 / 新投放：文案与封面真正并行 */
  const runMetaAndCoverParallel = async () => {
    if (metaBusy || coverBusy) return
    setMetaBusy(true)
    setCoverBusy(true)
    setMetaMsg('对齐口播与主题…')
    setCoverMsg('等待封面标题…')
    try {
      const brief = await resolvePublishBrief({ projectName, script: script || publishScript })
      setPublishScript(brief.script || script || publishScript)
      setSourceNote(applyBriefNote(brief.source, brief.title))
      const coverTitle = pickCoverHeadline({
        formTitle: titleRef.current,
        seedTitle: useApp.getState().coverSeed?.title,
        briefTitle: brief.title,
        projectName,
      })
      const spoken = brief.script || script || publishScript
      const coverHint = pickCoverStyleHint({
        formHint: styleHintRef.current,
        seedHint: seedStyleHint(useApp.getState().coverSeed),
        briefHint: brief.styleHint,
      })
      setMetaMsg('文案生成中…')
      setCoverMsg('按口播文案生成封面…')
      await runIndependentTasks([
        {
          run: () => fetchDouyinMeta({
            projectName: projectName || coverTitle,
            script: spoken,
            hint: coverTitle !== projectName ? coverTitle : undefined,
          }),
          onSuccess: (meta) => {
            setTitle(meta.title)
            setCaption(meta.caption)
            setTags(meta.tags.join(','))
            if (tab === 'stage') setSlug(defaultSlug(meta.title))
            setMetaMsg('文案已生成（按本片口播）')
          },
          onError: e => setMetaMsg(e instanceof Error ? e.message : String(e)),
          onFinally: () => setMetaBusy(false),
        },
        {
          run: () => generateDouyinCover({
            title: coverTitle,
            styleHint: coverHint,
            script: spoken,
            quality: '1K',
            onProgress: setCoverMsg,
          }),
          onSuccess: async (cover) => {
            setCoverPath(cover.path)
            setCoverPreview(withBust(cover.previewUrl, cover.jobId))
            let note = '封面已按文案生成'
            if (tab === 'publish' && selected) {
              const attached = await desktop()?.douyinAttachCover?.({ slug: selected, coverPath: cover.path })
              if (attached?.ok) {
                note = `${note} · 已写入资产`
                await refreshAssets()
              }
            }
            setCoverMsg(note)
          },
          onError: e => setCoverMsg(e instanceof Error ? e.message : String(e)),
          onFinally: () => setCoverBusy(false),
        },
      ])
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setMetaMsg(err)
      setCoverMsg(err)
      setMetaBusy(false)
      setCoverBusy(false)
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
    setActionBusy(true)
    setMsg(null)
    try {
      let nextTitle = title
      let nextCaption = caption
      let nextTags = tags
      let nextCover = coverPath
      let nextSlug = slug

      if (opts?.withAi) {
        setMsg('对齐本工程口播与主题…')
        setMetaBusy(true)
        setCoverBusy(true)
        const brief = await resolvePublishBrief({ projectName, script: script || publishScript })
        setPublishScript(brief.script || script || publishScript)
        setSourceNote(applyBriefNote(brief.source, brief.title))
        const coverTitle = pickCoverHeadline({
          formTitle: titleRef.current,
          seedTitle: useApp.getState().coverSeed?.title,
          briefTitle: brief.title,
          projectName,
        })
        const spoken = brief.script || script || publishScript
        const coverHint = pickCoverStyleHint({
          formHint: styleHintRef.current,
          seedHint: seedStyleHint(useApp.getState().coverSeed),
          briefHint: brief.styleHint,
        })
        setMsg('文案与封面并行生成…')
        setMetaMsg('文案生成中…')
        setCoverMsg('按口播文案生成封面…')
        try {
          const { meta, cover } = await generateMetaAndCover({
            projectName: projectName || coverTitle,
            script: spoken,
            coverTitle,
            styleHint: coverHint,
            onProgress: (m) => setMsg(m),
          })
          nextTitle = meta.title
          nextCaption = meta.caption
          nextTags = meta.tags.join(',')
          nextSlug = defaultSlug(meta.title)
          nextCover = cover.path
          setTitle(nextTitle)
          setCaption(nextCaption)
          setTags(nextTags)
          setSlug(nextSlug)
          setCoverPath(cover.path)
          setCoverPreview(withBust(cover.previewUrl, cover.jobId))
          setMetaMsg('文案已生成（按本片口播）')
          setCoverMsg('封面已按文案生成')
        } finally {
          setMetaBusy(false)
          setCoverBusy(false)
        }
      }

      if (!videoPath && !nextCover) { setMsg('请选择成片或先生成封面'); return }

      setMsg(`投放中：${fileBase(videoPath) || '（仅封面）'}…`)
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
      setMsg(`已投放「${fileBase(videoPath) || r.slug}」→ ${r.slug}${r.dir ? `（${r.dir}）` : ''}`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(false)
      setMetaBusy(false)
      setCoverBusy(false)
    }
  }

  const runAdb = async (action: 'push' | 'stage' | 'fill') => {
    if (!selected) { setMsg('请先在左侧选中要发的资产'); return }
    if (!activeVideoPath && action !== 'fill') {
      setMsg('当前资产没有视频文件，无法推送到发布页选片')
      return
    }
    setActionBusy(true)
    setMsg(null)
    try {
      if (!(await savePublishMeta())) return
      const labels = { push: '推到手机相册', stage: '打开抖音发布页', fill: '填写标题简介' } as const
      setMsg(`${labels[action]}：${activeVideoName || selected}…`)
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
        setMsg(`已推「${activeVideoName}」到发布页（${serial || '手机'}）。可继续点「填标题简介」。`)
      } else {
        setMsg(`已推送「${activeVideoName}」到 ${serial || '手机'} 相册`)
      }
      void refreshPhones()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(false)
    }
  }

  if (!isDesktopApp()) {
    return <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>抖音发布台仅桌面版可用。</p>
  }

  const readyPhones = phones.filter((p) => p.state === 'device')
  const publishCover = coverPreview || coverSrc(selectedAsset)
  const videoMissing = !activeVideoPath

  return (
    <div className="grid gap-3" data-testid="douyin-publish-panel" style={{ minWidth: 'min(820px, 100%)' }}>
      {/* 手机状态条 */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        data-testid="dy-phones"
      >
        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>手机</span>
        {!readyPhones.length && !phonesBusy ? (
          <span className="text-[12px] min-w-0 flex-1" style={{ color: 'var(--accent)' }} title={phonesError || undefined}>
            {phonesError || '未检测到可调试的手机'}
            {usbNames.length ? (
              <span style={{ color: 'var(--text-muted)' }}> · USB：{usbNames.join(' / ')}</span>
            ) : null}
          </span>
        ) : null}
        {readyPhones.length > 0 && phonesError ? (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{phonesError}</span>
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
                style={{ background: ok ? '#818181' : '#707070' }}
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
          {phonesBusy ? '扫描中…' : '刷新'}
        </button>
        <button
          type="button"
          className="btn btn-ghost text-[11px]"
          data-testid="dy-phones-restart-adb"
          disabled={phonesBusy}
          title="重启本机 adb 服务后再扫描"
          onClick={() => { void refreshPhones({ restartAdb: true }) }}
        >
          重启 adb
        </button>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(220px, 260px) 1fr', minHeight: 440 }}>
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
          <div className="flex-1 overflow-y-auto px-2 pb-2 grid gap-1.5" style={{ maxHeight: 500 }}>
            <button
              type="button"
              className={`btn justify-start text-left text-[11px] ${tab === 'stage' ? 'btn-primary' : 'btn-ghost'}`}
              data-testid="dy-tab-stage"
              onClick={() => { void prepareStageFromLatest() }}
            >
              + 新投放成片
            </button>
            {!assets.length ? (
              <p className="text-[11px] px-1" style={{ color: 'var(--text-muted)' }}>暂无资产。先投放成片。</p>
            ) : assets.map((a) => {
              const on = selected === a.slug && tab === 'publish'
              const thumb = coverSrc(a)
              const vName = fileBase(a.video_path)
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
                  title={a.video_path || '无视频'}
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
                      <div
                        className="text-[10px] truncate mt-0.5"
                        style={{ color: vName ? 'var(--text-primary)' : 'var(--accent)' }}
                        title={a.video_path || undefined}
                      >
                        {vName || '无视频文件'}
                      </div>
                      <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                        {a.kind === 'video' ? '视频' : '纯图'}
                        {a.cover_path ? ' · 有封面' : ' · 缺封面'}
                        {a.video_bytes ? ` · ${formatBytes(a.video_bytes)}` : ''}
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
              <button type="button" className="btn btn-primary mt-3" onClick={() => { void prepareStageFromLatest() }}>
                去投放新成片
              </button>
            </div>
          ) : null}

          {(tab === 'publish' && selectedAsset) || tab === 'stage' ? (
            <>
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <h3 className="text-[14px] font-medium m-0" style={{ fontFamily: 'var(--font-display)' }}>
                  {tab === 'publish' ? '发布页' : '新投放'}
                  {tab === 'publish' && selectedAsset ? (
                    <span className="text-[12px] font-normal ml-2" style={{ color: 'var(--text-muted)' }}>
                      {selectedAsset.slug}
                    </span>
                  ) : null}
                </h3>
                {sourceNote ? (
                  <span className="text-[11px] truncate max-w-[50%]" style={{ color: 'var(--accent)' }} title={sourceNote}>{sourceNote}</span>
                ) : null}
              </div>

              {exportMismatch ? (
                <div
                  className="rounded-lg px-3 py-2 flex flex-wrap items-center gap-2"
                  style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)' }}
                  data-testid="dy-export-mismatch"
                >
                  <span className="text-[12px] flex-1 min-w-0">
                    最近导出是 <b>{lastDone?.name || fileBase(lastDone?.path)}</b>，与当前投放视频不同
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary text-[11px]"
                    onClick={() => { void prepareStageFromLatest() }}
                  >
                    改用刚导出的成片
                  </button>
                </div>
              ) : null}

              {/* 当前成片：始终可见，避免找不到「投的是哪个视频」 */}
              <div
                className="rounded-lg px-3 py-2.5 grid gap-1.5"
                style={{
                  border: `1px solid ${videoMissing ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'var(--surface-2)',
                }}
                data-testid="dy-active-video"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {tab === 'publish' ? '当前投放视频' : '将要投放的视频'}
                  </span>
                  {tab === 'stage' ? (
                    <button type="button" className="btn btn-ghost text-[10px]" onClick={() => { void pickVideo() }}>
                      浏览…
                    </button>
                  ) : activeVideoPath || selectedAsset?.folder ? (
                    <button
                      type="button"
                      className="btn btn-ghost text-[10px]"
                      title={activeVideoPath || selectedAsset?.folder}
                      onClick={() => {
                        const target = activeVideoPath || selectedAsset?.folder
                        if (target) void desktop()?.revealPath?.(target)
                      }}
                    >
                      在资源管理器中显示
                    </button>
                  ) : null}
                </div>
                {videoMissing ? (
                  <div className="text-[13px]" style={{ color: 'var(--accent)' }}>
                    未绑定视频文件
                    {tab === 'stage' ? ' — 请选择成片或点下方最近导出' : ' — 这条资产只有封面/图，推发布页选片会失败'}
                  </div>
                ) : (
                  <>
                    <div className="text-[14px] font-medium truncate" title={activeVideoPath} data-testid="dy-active-video-name">
                      {activeVideoName}
                    </div>
                    <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }} title={activeVideoPath}>
                      {activeVideoPath}
                    </div>
                  </>
                )}
                {tab === 'stage' && recentExports.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pt-1" data-testid="dy-recent-exports">
                    <span className="text-[10px] self-center" style={{ color: 'var(--text-muted)' }}>最近导出</span>
                    {recentExports.map((j) => {
                      const on = videoPath === j.path
                      return (
                        <button
                          key={j.id}
                          type="button"
                          className="btn text-[10px]"
                          style={{
                            borderColor: on ? 'var(--accent)' : 'var(--border)',
                            background: on ? 'var(--accent-dim)' : 'transparent',
                          }}
                          title={j.path}
                          onClick={() => {
                            setVideoPath(j.path!)
                            setVideoLocked(true)
                          }}
                        >
                          {j.name || fileBase(j.path)}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                {tab === 'stage' ? (
                  <div className="flex gap-2 pt-0.5">
                    <input
                      className="input flex-1 text-[11px]"
                      data-testid="dy-video"
                      value={videoPath}
                      onChange={(e) => {
                        setVideoPath(e.target.value)
                        setVideoLocked(true)
                      }}
                      placeholder="mp4 本机路径"
                    />
                  </div>
                ) : null}
              </div>

              <div
                className="rounded-lg p-3 grid gap-2"
                style={{ border: '1px solid var(--border)', background: 'var(--surface-1)' }}
                data-testid="dy-ai-actions"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {tab === 'stage' ? (
                    <button
                      type="button"
                      className="btn btn-primary text-[12px]"
                      data-testid="dy-ai-all"
                      disabled={actionBusy || metaBusy || coverBusy}
                      title="按本片口播写文案与封面（纯文生图），再写入资产库"
                      onClick={() => { void stage({ withAi: true }) }}
                    >
                      {actionBusy || (metaBusy && coverBusy) ? '处理中…' : '一键：文案+封面+投放'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary text-[12px]"
                      data-testid="dy-ai-parallel"
                      disabled={metaBusy || coverBusy}
                      title="文案与封面都按口播生成，互不等待"
                      onClick={() => { void runMetaAndCoverParallel() }}
                    >
                      {metaBusy && coverBusy ? '生成中…' : '一键：文案+封面'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px]"
                    data-testid="dy-ai-meta"
                    disabled={metaBusy}
                    onClick={() => { void writeMeta() }}
                  >
                    {metaBusy ? '文案生成中…' : '只写文案'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-[11px]"
                    data-testid="dy-ai-cover"
                    disabled={coverBusy}
                    title="按口播文案纯文生图，不抽帧、不用参考图"
                    onClick={() => { void makeCover() }}
                  >
                    {coverBusy ? '封面生成中…' : '只生封面'}
                  </button>
                  {tab === 'publish' ? (
                    <button
                      type="button"
                      className="btn btn-ghost text-[11px] ml-auto"
                      data-testid="dy-save-meta"
                      disabled={actionBusy || metaBusy}
                      onClick={() => { void (async () => {
                        setActionBusy(true)
                        const ok = await savePublishMeta()
                        if (ok) setMsg('文案已写回资产')
                        setActionBusy(false)
                      })() }}
                    >
                      保存文案
                    </button>
                  ) : null}
                </div>
                <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>
                  简介与封面都按本工程口播文案；封面纯文生图（不抽帧、不用参考图），避免第一次被示例图带偏。
                </p>
                {(metaBusy || coverBusy) ? (
                  <div className="grid gap-1.5">
                    {metaBusy ? <CreativeProgress theme="type" compact label={metaMsg || '正在写标题与简介…'} /> : null}
                    {coverBusy ? <CreativeProgress theme="brush" compact label={coverMsg || '按文案绘制竖封面…'} /> : null}
                  </div>
                ) : (metaMsg || coverMsg) ? (
                  <div className="grid gap-0.5 text-[10px]">
                    {metaMsg ? <div style={{ color: /失败|错误|超时/.test(metaMsg) ? 'var(--accent)' : 'var(--text-muted)' }}>{metaMsg}</div> : null}
                    {coverMsg ? <div style={{ color: /失败|错误|超时|请先/.test(coverMsg) ? 'var(--accent)' : 'var(--text-muted)' }}>{coverMsg}</div> : null}
                  </div>
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
                  <button type="button" className="btn btn-ghost text-[11px]" disabled={coverBusy} onClick={() => { void pickCover() }}>
                    换本机图
                  </button>
                </div>

                <div className="grid gap-2 content-start">
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
                  <details className="text-[11px]" data-testid="dy-style-details">
                    <summary className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>封面高级选项</summary>
                    <div className="field mt-2">
                      <label>风格补充（题材仍跟口播文案）</label>
                      <input data-testid="dy-style" value={styleHint} onChange={(e) => setStyleHint(e.target.value)} />
                    </div>
                    {tab === 'stage' ? (
                      <div className="field mt-2">
                        <label>文件夹名</label>
                        <input data-testid="dy-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
                      </div>
                    ) : null}
                  </details>
                </div>
              </div>

              {tab === 'stage' ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid="dy-stage"
                  disabled={actionBusy || anyBusy}
                  onClick={() => { void stage() }}
                >
                  仅投放当前文案/封面 · {activeVideoName || '无视频'}
                </button>
              ) : (
                <div
                  className="rounded-lg p-3 grid gap-2"
                  style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}
                >
                  <div className="text-[12px] font-medium">发到手机</div>
                  <p className="text-[11px] m-0" style={{ color: 'var(--text-muted)' }}>
                    将推送：<strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{activeVideoName || '（无视频）'}</strong>
                    {readyPhones.length
                      ? ` → ${phoneSerial || readyPhones[0].serial}。填好后请你自己点「发作品」。`
                      : '。先连接并授权手机，再推送。'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-push" disabled={actionBusy || !readyPhones.length || videoMissing} onClick={() => { void runAdb('push') }}>
                      1. 推相册
                    </button>
                    <button type="button" className="btn btn-ghost text-[11px]" data-testid="dy-stage-adb" disabled={actionBusy || !readyPhones.length || videoMissing} onClick={() => { void runAdb('stage') }}>
                      2. 推到发布页
                    </button>
                    <button type="button" className="btn btn-primary text-[11px]" data-testid="dy-fill" disabled={actionBusy || !readyPhones.length} onClick={() => { void runAdb('fill') }}>
                      3. 填标题简介
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}

          {msg ? (
            <div className="text-[12px]" style={{ color: /失败|错误|超时|未检测|无视频/.test(msg) ? 'var(--accent)' : 'var(--text-muted)' }}>
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
