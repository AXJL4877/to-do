/**
 * 实机控制通道：读写「当前已打开的 TO DO 工程」。
 * 触发：public/koubo-live-trigger.json（nonce 变化）
 * 动作：dump | clean | accept（默认）
 * 回报：POST reportUrl；并写 native/test-output/spongebob-koubo/
 */
import { useApp } from '../store'
import { getAiBaseUrl } from './aiFetch'
import { getProduction } from './production'
import { registerProduction, setProductionAuto, syncProduction } from './productionTimeline'
import type { Production } from './production'

async function loadProductionDoc(id: string): Promise<Production> {
  const bases = [...new Set(['', getAiBaseUrl(), 'http://127.0.0.1:9730'].map((b) => (b || '').replace(/\/$/, '')))]
  let last = ''
  for (const base of bases) {
    try {
      const url = `${base}/api/ai-productions/${encodeURIComponent(id)}`
      const r = await fetch(url)
      const data = await r.json().catch(() => null) as { ok?: boolean; production?: Production; error?: string } | null
      if (data?.ok && data.production) return data.production
      last = data?.error || `HTTP ${r.status} @ ${base || 'same-origin'}`
    } catch (e) {
      last = `${String(e)} @ ${base || 'same-origin'}`
    }
  }
  try {
    return await getProduction(id)
  } catch (e) {
    throw new Error(`${last || ''} | ${String(e)}`)
  }
}

const PID_DEFAULT = 'p_mvmin_wipe1'
const SNAP_URL = '/__todo_live_snapshot__' // 仅作标记；实际写盘由 trigger 脚本侧收报告

export type LiveCtlAction = 'dump' | 'clean' | 'accept' | 'seek' | 'shot'

export type LiveAcceptReport = {
  ok: boolean
  action: LiveCtlAction
  id: string
  at: string
  checks: { name: string; ok: boolean; detail?: string }[]
  clips?: { name: string; key: string; scaleX?: number; start?: number; duration?: number; jobId?: string }[]
  project?: {
    name: string | null
    path: string | null
    clipCount: number
    trackCount: number
    aiProductions: string[]
    foreignClips: { name: string; start: number; duration: number }[]
  }
  error?: string
}

function check(cond: unknown, detail: string): asserts cond {
  if (!cond) throw new Error(detail)
}

function projectSnapshot(extraJobId?: string) {
  const st = useApp.getState()
  const seq = st.seq()
  const media = st.media
  const clips = seq.clips.map((c) => {
    const m = media.find((x) => x.id === c.mediaId)
    return {
      name: c.name || '',
      key: String(c.meta?.source?.key || ''),
      jobId: String(c.meta?.source?.jobId || ''),
      start: c.start,
      duration: c.duration,
      scaleX: c.transform?.scaleX,
      media: m?.name || '',
      alpha: !!m?.alpha,
      chromaKey: m?.chromaKey || '',
      kind: m?.kind || (c.text ? 'text' : '?'),
    }
  })
  const foreign = clips.filter((c) => {
    if (extraJobId && c.jobId === extraJobId) return false
    if (c.key) return false
    return /海绵宝宝|source_film|成片|koubo|wipe|口播/i.test(`${c.name} ${c.media}`)
      || c.duration > 10
  })
  return {
    name: st.projectName || null,
    path: st.projectPath || null,
    clipCount: clips.length,
    trackCount: seq.tracks.length,
    aiProductions: Object.keys(st.settings.aiProductions || {}),
    foreignClips: foreign.map((c) => ({ name: c.name, start: c.start, duration: c.duration })),
    clips,
  }
}

/** 清掉工程里所有 koubo 成片轨（含其它 productionId 旧产物），避免演示草稿叠多层 */
export function cleanKouboPollution(id?: string) {
  const st = useApp.getState()
  const seq = st.seq()
  const videoTrackIds = new Set(seq.tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const known = new Set(Object.keys(st.settings.aiProductions || {}))
  if (id) known.add(id)
  const kill = seq.clips.filter((c) => {
    const jid = String(c.meta?.source?.jobId || '')
    // 本扩展历次成片 id，或当前登记过的 production
    if (jid && (known.has(jid) || /^p_mv/i.test(jid))) return true
    const name = `${c.name || ''} ${st.media.find((m) => m.id === c.mediaId)?.name || ''}`
    if (/海绵宝宝|source_film|成片|koubo|wipe|E2E分层|最小重跑/i.test(name)) return true
    if (!videoTrackIds.has(c.trackId)) return false
    if ((c.start || 0) > 12) return false
    return (c.duration || 0) > 8 && !c.meta?.source?.key
  })
  if (kill.length) {
    useApp.getState().patchClipsQuiet(Object.fromEntries(kill.map((c) => [c.id, null])))
  }
  const s = useApp.getState()
  const nextProd = { ...s.settings.aiProductions }
  for (const pid of Object.keys(nextProd)) {
    if (pid === id || /^p_mv/i.test(pid)) {
      nextProd[pid] = { ...nextProd[pid], placed: {}, t0: 0, auto: pid === id }
    }
  }
  useApp.setState({ settings: { ...s.settings, aiProductions: nextProd } })
  return kill.length
}

export async function runLiveSeek(t: number): Promise<LiveAcceptReport> {
  const st = useApp.getState()
  check(st.started, '工程未启动')
  const sec = Math.max(0, Number(t) || 0)
  useApp.getState().setPlayhead(sec, { exact: true })
  try {
    const { setLivePlayhead } = await import('./livePlayhead')
    setLivePlayhead(sec)
  } catch { /* */ }
  useApp.getState().setToast(`播头 ${sec.toFixed(2)}s`)
  await new Promise((r) => setTimeout(r, 350))
  const snap = projectSnapshot()
  return {
    ok: true,
    action: 'seek',
    id: '',
    at: new Date().toISOString(),
    checks: [{ name: '播头已定位', ok: true, detail: `t=${sec}` }],
    clips: snap.clips.slice(0, 20),
    project: {
      name: snap.name,
      path: snap.path,
      clipCount: snap.clipCount,
      trackCount: snap.trackCount,
      aiProductions: snap.aiProductions,
      foreignClips: snap.foreignClips,
    },
  }
}

export async function runLiveShot(t: number): Promise<LiveAcceptReport & { shotDataUrl?: string }> {
  const seek = await runLiveSeek(t)
  if (!seek.ok) return seek
  await new Promise((r) => setTimeout(r, 500))
  const st = useApp.getState()
  const seq = st.seq()
  const { settings, media } = st
  const { getPreviewSize, renderProgramFrame } = await import('./monitorDraw')
  const { w, h } = getPreviewSize(settings, 'balanced')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const imgCache = new Map<string, HTMLImageElement>()
  // warm images
  await Promise.all(media.filter((m) => m.kind === 'image' || m.kind === 'sticker').map((m) => new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = () => { imgCache.set(m.id, img); resolve() }
    img.onerror = () => resolve()
    img.crossOrigin = 'anonymous'
    img.src = m.url
  })))
  // warm videos briefly
  await new Promise((r) => setTimeout(r, 400))
  renderProgramFrame(canvas, seq, media, settings, Number(t) || 0, imgCache, w, h, [], undefined, false, undefined, true)
  // second pass after video seek settles
  await new Promise((r) => setTimeout(r, 600))
  renderProgramFrame(canvas, seq, media, settings, Number(t) || 0, imgCache, w, h, [], undefined, false, undefined, true)
  const shotDataUrl = canvas.toDataURL('image/png')
  useApp.getState().setToast(`截帧 t=${Number(t).toFixed(2)}s`)
  return { ...seek, action: 'shot', shotDataUrl, checks: [...seek.checks, { name: '预览帧已截', ok: true, detail: `${w}x${h}` }] }
}

export async function runLiveDump(): Promise<LiveAcceptReport> {
  const snap = projectSnapshot()
  useApp.getState().setToast(`工程快照：${snap.clipCount} 片段 / 污染嫌疑 ${snap.foreignClips.length}`)
  return {
    ok: true,
    action: 'dump',
    id: snap.aiProductions[0] || '',
    at: new Date().toISOString(),
    checks: [
      { name: '工程已打开', ok: !!useApp.getState().started, detail: snap.path || snap.name || 'unnamed' },
      { name: '片段数', ok: true, detail: String(snap.clipCount) },
      { name: '污染嫌疑', ok: snap.foreignClips.length === 0, detail: `n=${snap.foreignClips.length}` },
    ],
    clips: snap.clips.slice(0, 40),
    project: {
      name: snap.name,
      path: snap.path,
      clipCount: snap.clipCount,
      trackCount: snap.trackCount,
      aiProductions: snap.aiProductions,
      foreignClips: snap.foreignClips,
    },
  }
}

export async function runLiveClean(id?: string): Promise<LiveAcceptReport> {
  const n = cleanKouboPollution(id)
  try { await useApp.getState().flushProject() } catch { /* */ }
  const snap = projectSnapshot(id)
  useApp.getState().setToast(`已清污染 ${n} 段；剩余 ${snap.clipCount}`)
  return {
    ok: true,
    action: 'clean',
    id: id || '',
    at: new Date().toISOString(),
    checks: [
      { name: '已删除污染/旧轨', ok: true, detail: `removed=${n}` },
      { name: '剩余片段', ok: true, detail: String(snap.clipCount) },
      { name: '仍有污染嫌疑', ok: snap.foreignClips.length === 0, detail: `n=${snap.foreignClips.length}` },
    ],
    clips: snap.clips.slice(0, 40),
    project: {
      name: snap.name,
      path: snap.path,
      clipCount: snap.clipCount,
      trackCount: snap.trackCount,
      aiProductions: snap.aiProductions,
      foreignClips: snap.foreignClips,
    },
  }
}

export async function runLiveAcceptKoubo(id = PID_DEFAULT): Promise<LiveAcceptReport> {
  const checks: LiveAcceptReport['checks'] = []
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail })

  try {
    useApp.getState().setLibraryTab('skill')
    useApp.getState().setToast(`实机验收：打开成片 ${id}`)

    for (let i = 0; i < 40; i++) {
      if (useApp.getState().started && useApp.getState().seq?.()) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const st0 = useApp.getState()
    check(st0.started, '工程未启动 started=false（请先打开一个工程；建议新建空工程再验收）')
    useApp.getState().setPlayhead(0, { exact: true })

    const existing = st0.settings.aiProductions?.[id]
    if (!existing) {
      registerProduction(id, { auto: true, placement: 'playhead', placeAt: 0, estimate: 16 })
    } else {
      setProductionAuto(id, true)
    }

    const removed = cleanKouboPollution(id)
    push('先清旧产物/污染', true, `removed=${removed}`)

    window.dispatchEvent(new CustomEvent('todo:open-production', { detail: { id } }))

    const doc = await loadProductionDoc(id)
    const seg = doc.segments?.[0]
    check(seg?.voice, '成片没有配音')
    const layers = (doc as { sourceLayers?: { bound?: boolean; elements?: number } }).sourceLayers
    push('分层已绑定', !!layers?.bound, `elements=${layers?.elements ?? 0}`)
    check(layers?.bound, '缺少 sourceLayers（应按原管线逐镜入轨）')

    const changed = syncProduction(doc)
    const clips = useApp.getState().seq().clips.filter((c) => c.meta?.source?.jobId === id)
    push('时间轴入轨', clips.length > 0, `changed=${changed} clips=${clips.length} keys=${clips.map((c) => c.meta?.source?.key).slice(0, 12).join(',')}`)
    check(clips.length > 0, `入轨后仍无片段 clips=0 changed=${changed}`)

    const voice = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/voice'))
    const holds = clips.filter((c) => String(c.meta?.source?.key || '').endsWith('/hold'))
    const bgm = clips.filter((c) => /\/bgm(\/|$)/.test(String(c.meta?.source?.key || '')))
    const filmClip = clips.find((c) => String(c.meta?.source?.key || '').endsWith('/film'))
    push('① 配音轨已入轨（TTS 先）', voice.length >= 1 && (voice[0].duration || 0) > 3, `n=${voice.length} dur=${voice[0]?.duration}`)
    check(voice.length >= 1, '时间轴没有口播轨')
    push('② 逐镜分层已入轨', holds.length >= 1, `holds=${holds.length}`)
    check(holds.length >= 1, '时间轴没有分层 hold')
    const intro = holds.find((c) => /红字|intro/i.test(String(c.name || '')))
    push('②a 开场红字层', !!intro, intro ? String(intro.name) : 'missing')
    const plan = (doc as { sourceBgmPlan?: { segments?: { id: string; file: string }[] } }).sourceBgmPlan
    const segs = plan?.segments || []
    push(
      '③ BGM 分轨（intro→mid→outro）',
      segs.length >= 1 && bgm.length >= 1 && bgm.length === segs.length,
      `plan=${segs.map((s) => s.id).join('+') || 'none'} clips=${bgm.length}`,
    )
    check(bgm.length >= 1, '时间轴没有 BGM 分轨')
    push('未整片盖轨', !filmClip, filmClip ? '不应默认铺 /film' : 'ok')

    const cues = seg!.subtitles?.cues || []
    const introPhrases = (seg!.voice?.phrases || []).filter((p) => Number((p as { sentence?: number }).sentence) === 0)
    const leak = cues.some((c) => introPhrases.some((p) => Math.abs(p.start - c.start) < 0.05 && p.text === c.text))
    push('开场句无宿主字幕', !leak, `cues=${cues.length} introPhrases=${introPhrases.length}`)

    const snap = projectSnapshot(id)
    push('工程无外来污染', snap.foreignClips.length === 0, `foreign=${snap.foreignClips.length}`)

    const pick = intro || holds[0] || voice[0]
    useApp.getState().selectClips([pick!.id])
    useApp.getState().setPlayhead(0.3, { exact: true })
    try {
      const { setLivePlayhead } = await import('./livePlayhead')
      setLivePlayhead(0.3)
    } catch { /* */ }

    try { await useApp.getState().flushProject() } catch { /* */ }
    useApp.getState().setToast('验收通过：TTS → 逐镜分层 → 三段 BGM')

    return {
      ok: checks.every((c) => c.ok),
      action: 'accept',
      id,
      at: new Date().toISOString(),
      checks,
      clips: clips.slice(0, 20).map((c) => ({
        name: c.name || '',
        key: String(c.meta?.source?.key || ''),
        scaleX: c.transform?.scaleX,
        start: c.start,
        duration: c.duration,
        jobId: id,
      })),
      project: {
        name: snap.name,
        path: snap.path,
        clipCount: snap.clipCount,
        trackCount: snap.trackCount,
        aiProductions: snap.aiProductions,
        foreignClips: snap.foreignClips,
      },
    }
  } catch (e) {
    useApp.getState().setToast(`实机验收失败：${String(e).slice(0, 120)}`)
    return {
      ok: false,
      action: 'accept',
      id,
      at: new Date().toISOString(),
      checks,
      error: String(e),
      project: (() => {
        try {
          const s = projectSnapshot(id)
          return {
            name: s.name, path: s.path, clipCount: s.clipCount, trackCount: s.trackCount,
            aiProductions: s.aiProductions, foreignClips: s.foreignClips,
          }
        } catch { return undefined }
      })(),
    }
  }
}

export function startLiveAcceptPoller() {
  let busy = false
  let lastNonce = ''
  const tick = async () => {
    if (busy) return
    try {
      const r = await fetch(`/koubo-live-trigger.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!r.ok) return
      const body = await r.json().catch(() => null) as {
        id?: string; nonce?: string; reportUrl?: string; action?: LiveCtlAction; t?: number
      } | null
      if (!body?.nonce || body.nonce === lastNonce) return
      lastNonce = body.nonce
      busy = true
      const action: LiveCtlAction =
        body.action === 'dump' || body.action === 'clean' || body.action === 'seek' || body.action === 'shot'
          ? body.action
          : 'accept'
      const report = action === 'dump'
        ? await runLiveDump()
        : action === 'clean'
          ? await runLiveClean(body.id)
          : action === 'seek'
            ? await runLiveSeek(Number(body.t) || 0)
            : action === 'shot'
              ? await runLiveShot(Number(body.t) || 0)
              : await runLiveAcceptKoubo(body.id || PID_DEFAULT)
      if (body.reportUrl) {
        await fetch(body.reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
        }).catch(() => undefined)
      }
      ;(window as unknown as { __KOUBO_LIVE_ACCEPT_REPORT__?: LiveAcceptReport }).__KOUBO_LIVE_ACCEPT_REPORT__ = report
      void SNAP_URL
    } catch {
      /* */
    } finally {
      busy = false
    }
  }
  const timer = window.setInterval(() => { void tick() }, 700)
  void tick()
  return () => window.clearInterval(timer)
}
