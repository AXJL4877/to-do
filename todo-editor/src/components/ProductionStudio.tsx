/**
 * 成片工作台：一条长口播成片的全部节点（口播段 → 镜头 → 元素 → 候选图）。
 * 改哪里只重做哪里：编辑只改文档，「生成改动」只跑待生成的节点；每段 / 每个镜头 / 每个元素都能单独生成。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Clapperboard, Crosshair, Loader2, Merge, Plus, RefreshCw, Scissors, Sparkles, Square, Trash2, Upload, Wand2, X } from 'lucide-react'
import { CreativeProgress } from './CreativeProgress'
import clsx from 'clsx'
import { useApp } from '../store'
import { aiUrl } from '../lib/aiFetch'
import { GROUP_LABELS, ROLE_LABELS, paramVisible, phaseText, type SkillGroup, type SkillPack, type SkillParam, type SkillParams } from '../lib/aiSkills'
import {
  boardSpan, cancelProduction, editProduction, getProduction, isProductionRunning, pendingCount, pickedVariant, runProduction, uploadProductionVariant,
  type Production, type ProductionBoard, type ProductionElement, type ProductionOp, type ProductionRole, type ProductionScope, type ProductionSegment,
} from '../lib/production'
import { applyProduction, invalidateProduction, onProductionUpdate, segmentClipStart, setProductionAuto } from '../lib/productionTimeline'
import { ELEMENT_COLORS, SkillParamControl } from './SkillStudio'

type Ctx = {
  doc: Production
  locked: boolean
  maxElements: number
  edit: (ops: ProductionOp[]) => Promise<boolean>
  run: (scope?: ProductionScope, stopAfter?: 'plan') => Promise<void>
  upload: (element: string, file: File) => Promise<void>
}

const fmt = (s: number) => `${s.toFixed(1)}s`
const charLen = (s: string) => (s.match(/[\p{L}\p{N}]/gu) || []).length

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('读取图片失败'))
    r.readAsDataURL(file)
  })
}

/** 这一段的状态徽标 */
function segBadges(doc: Production, seg: ProductionSegment) {
  const out: { text: string; tone?: 'dirty' | 'error' }[] = []
  const failedIds = new Set((doc.status?.failed ?? []).map((f) => f.id))
  const nodeIds = [seg.id, ...seg.boards.flatMap((b) => [b.id, ...b.elements.map((e) => e.id)])]
  if (nodeIds.some((id) => failedIds.has(id))) out.push({ text: '有失败', tone: 'error' })
  if (!seg.voice || seg.dirty.voice) out.push({ text: '待配音', tone: 'dirty' })
  else if (seg.dirty.plan) out.push({ text: '待分镜', tone: 'dirty' })
  else {
    const n = seg.boards.filter((b) => b.dirty || b.elements.some((e) => e.dirty)).length
    if (n) out.push({ text: `${n} 块待生成`, tone: 'dirty' })
  }
  return out
}

export function ProductionStudio({ id, pack, onClose }: { id: string; pack: SkillPack | null; onClose: () => void }) {
  const [doc, setDoc] = useState<Production | null>(null)
  const [segId, setSegId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paramsDraft, setParamsDraft] = useState<SkillParams | null>(null)
  const auto = useApp((s) => s.settings.aiProductions?.[id]?.auto ?? false)

  useEffect(() => {
    let alive = true
    getProduction(id).then((p) => { if (alive) setDoc(p) }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    const off = onProductionUpdate((p) => { if (p.id === id) setDoc(p) })
    return () => { alive = false; off() }
  }, [id])

  const seg = doc?.segments.find((s) => s.id === segId) ?? doc?.segments[0] ?? null
  const running = !!doc && isProductionRunning(doc)
  const pending = doc ? pendingCount(doc) : 0

  /**
   * 运行中的状态文案。
   *
   * 为什么需要：`preserveSource` 型扩展（如海绵宝宝口播）把整条包内管线交给一个子进程，
   * 宿主只能转发它的 stdout，**算不出百分比**，于是 `pct` 长期停在 0 ——
   * 界面看起来就是"卡在 原工作流（0%）"（实测一次真机跑 38 分钟都这样）。
   * 进度算不出来就说实话：显示**已运行多久**并带上工作流最新一行阶段文字，
   * 让"在跑"和"卡死"能区分开。两者界面都拿得到（lock.since / status.phase），不需要新数据。
   */
  const runStatusText = (() => {
    if (!running) return ''
    const since = doc?.lock?.since
    const mins = typeof since === 'number' && since > 0 ? Math.floor((Date.now() - since) / 60000) : null
    const base = mins == null
      ? '生成中'
      : `生成中 · 已运行 ${mins < 1 ? '不到 1 分钟' : `${mins} 分钟`}`
    const phase = String(doc?.status?.phase || '').trim()
    const tail = phase && !/^原工作流/.test(phase) ? ` · ${phase}` : ''
    return `${base}${tail}（改动请等这一轮结束，或先停止）`
  })()

  const act = useCallback(async (fn: () => Promise<Production>) => {
    setBusy(true)
    setError(null)
    try {
      const p = await fn()
      setDoc(p)
      applyProduction(p)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const edit = useCallback((ops: ProductionOp[]) => act(() => editProduction(id, ops)), [act, id])
  const run = useCallback(async (scope?: ProductionScope, stopAfter?: 'plan') => {
    await act(async () => (await runProduction(id, { scope, stopAfter })).production)
  }, [act, id])
  const upload = useCallback(async (element: string, file: File) => {
    await act(async () => uploadProductionVariant(id, element, await readDataUrl(file)))
  }, [act, id])
  const stop = useCallback(async () => {
    try {
      await cancelProduction(id)
      invalidateProduction(id)
      useApp.getState().setToast('正在停止：手上这一步做完就停')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [id])

  const groups = useMemo(() => {
    if (!pack) return []
    const out = new Map<SkillGroup, SkillParam[]>()
    for (const p of pack.params) out.set(p.group, [...(out.get(p.group) ?? []), p])
    return [...out.entries()]
  }, [pack])
  const params = paramsDraft ?? doc?.params ?? {}
  const paramsChanged = !!paramsDraft && !!doc && JSON.stringify(paramsDraft) !== JSON.stringify(doc.params)

  if (!doc) {
    return createPortal(
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal p-8 text-center text-[12px]" style={{ color: error ? 'var(--error)' : 'var(--text-muted)' }} onClick={(e) => e.stopPropagation()}>
          {error || <Loader2 size={16} className="animate-spin inline" />}
        </div>
      </div>,
      document.body,
    )
  }

  const ctx: Ctx = { doc, locked: running || busy, maxElements: pack?.planner?.maxElements ?? 4, edit, run, upload }
  const total = doc.segments.reduce((t, s) => t + (s.voice?.duration ?? 0), 0)
  const boards = doc.segments.reduce((n, s) => n + s.boards.length, 0)
  const status = doc.status
  const unplanned = !doc.segments.length || doc.segments.some((s) => !s.plan)

  return createPortal(
    <div className="modal-backdrop" data-testid="production-studio" onClick={onClose}>
      <div className="modal" style={{ width: 'min(1240px, 100%)', height: 'min(820px, 94vh)', maxHeight: 'none' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Clapperboard size={14} style={{ color: 'var(--accent)' }} />
          <input
            key={doc.title}
            className="skill-element-label"
            style={{ width: 200 }}
            defaultValue={doc.title}
            maxLength={24}
            disabled={ctx.locked}
            title="片名"
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== doc.title) void edit([{ op: 'setTitle', title: v }]) }}
          />
          <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {doc.segments.length ? `${doc.segments.length} 段 · ${boards} ${doc.skillId === 'builtin.dynamic-text' ? '个文字镜头' : '块黑板'} · ${fmt(total)}` : '还没分段'}
          </span>
          <span className="min-w-0 flex-1 flex items-center gap-2">
            {running && (
              <CreativeProgress
                theme="chalk"
                compact
                percent={status?.pct ?? 0}
                label={doc.queuedJobId && !doc.runningJobId ? '排队中' : phaseText(status?.phase) || '成片生成中'}
                className="max-w-[220px]"
              />
            )}
          </span>
          <label className="flex items-center gap-1.5 text-[11px] cursor-pointer shrink-0" style={{ color: 'var(--text-secondary)' }} title="生成好的配音、元素、字幕自动铺进时间轴，改动后原位替换">
            <input type="checkbox" checked={auto} onChange={(e) => setProductionAuto(id, e.target.checked)} />
            自动入轨
          </label>
          <button className="icon-btn" data-testid="production-close" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>

        {status?.failed?.length ? (
          <div className="px-4 py-2 text-[11px] border-b" style={{ borderColor: 'var(--border)', color: 'var(--error)' }}>
            {status.failed.length} 处失败（成功的已保留，点「生成改动」只补失败的）：
            {status.failed.slice(0, 3).map((f) => `「${f.label}」${f.error}`).join('；')}
          </div>
        ) : null}

        {/*
          产物成功 ≠ 质量门通过。包内工作流按约定"成片产出即交付、质量门未过只告警"，
          但那条告警只在子进程 stdout 上，宿主只留 tail —— 用户看不到。
          这里如实展示，避免"片子已经到手却不知道有几道门没过"。
        */}
        {doc.quality && doc.quality.productOk && !doc.quality.gatesOk ? (
          <div
            className="px-4 py-2 text-[11px] border-b flex items-start gap-2"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            data-testid="production-quality-warning"
          >
            <span
              className="prod-badge shrink-0"
              style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}
              title="产物已生成，只是质量门有未通过项"
            >
              质量门未全过
            </span>
            <span className="min-w-0">
              成片与分层已产出并正常入轨
              {doc.quality.failedGates.length ? `；未通过：${doc.quality.failedGates.join('、')}` : ''}
              {doc.quality.note ? `（${doc.quality.note}）` : ''}
            </span>
          </div>
        ) : null}

        <div className="flex flex-1 min-h-0">
          <div className="w-[230px] shrink-0 overflow-y-auto p-3 border-r flex flex-col gap-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
            <span className="eyebrow">口播段</span>
            {doc.outline?.notes && <p className="m-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{doc.outline.notes}</p>}
            <div className="prod-seg-list" data-testid="production-segments">
              {doc.segments.map((s, i) => (
                <button key={s.id} type="button" className={clsx('prod-seg', seg?.id === s.id && 'active')} data-testid={`production-seg-${s.id}`} onClick={() => setSegId(s.id)}>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-semibold shrink-0">{i + 1}</span>
                    <span className="text-[11px] font-semibold truncate">{s.title || '口播段'}</span>
                    <span className="prod-badge ml-auto">{s.voice ? fmt(s.voice.duration) : `${charLen(s.text)}字`}</span>
                  </span>
                  <span className="prod-seg-text">{s.text}</span>
                  <span className="flex gap-1 flex-wrap">
                    {segBadges(doc, s).map((b) => <span key={b.text} className={clsx('prod-badge', b.tone === 'dirty' && 'is-dirty', b.tone === 'error' && 'is-error')}>{b.text}</span>)}
                  </span>
                </button>
              ))}
            </div>
            {!doc.segments.length && (
              <p className="m-0 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{doc.script.slice(0, 600)}{doc.script.length > 600 ? '…' : ''}</p>
            )}
            {doc.cast.length > 0 && (
              <div className="flex flex-col gap-1 mt-2">
                <span className="eyebrow">角色设定</span>
                {doc.cast.map((c) => <p key={c.name} className="m-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }} title={c.look}><b>{c.name}</b> · {c.look}</p>)}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto p-4 flex flex-col gap-4">
            {seg ? <SegmentEditor key={seg.id} ctx={ctx} seg={seg} index={doc.segments.indexOf(seg)} /> : (
              <div className="m-auto text-center text-[12px] flex flex-col gap-2 items-center" style={{ color: 'var(--text-muted)' }}>
                {running ? <><Loader2 size={16} className="animate-spin" />{phaseText(status?.phase) || '正在生成…'}</> : (status?.error || '点下面的「一键成片」或「先出分镜」开始')}
              </div>
            )}
          </div>

          {pack && (
            <div className="w-[290px] shrink-0 overflow-y-auto p-4 flex flex-col gap-4 border-l" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
              {groups.map(([g, list]) => {
                const shown = list.filter((p) => paramVisible(p, params))
                if (!shown.length) return null
                return (
                  <section key={g} className="flex flex-col gap-2.5">
                    <span className="eyebrow">{GROUP_LABELS[g]}</span>
                    {shown.map((p) => <SkillParamControl key={p.id} p={p} values={params} onChange={(k, v) => setParamsDraft({ ...params, [k]: v })} />)}
                  </section>
                )
              })}
              {paramsChanged && (
                <div className="flex gap-1.5 sticky bottom-0 py-2" style={{ background: 'var(--surface-0)' }}>
                  <button type="button" className="btn btn-primary flex-1" disabled={ctx.locked} data-testid="production-params-apply"
                    onClick={() => void edit([{ op: 'setParams', params: paramsDraft! }]).then((ok) => { if (ok) setParamsDraft(null) })}>
                    应用参数
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setParamsDraft(null)}>还原</button>
                </div>
              )}
              <p className="m-0 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                参数改完只标出受影响的部分：画面参数只重渲，音色重配音，分段参数只在还没分段时生效。
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t flex-wrap" style={{ borderColor: 'var(--border)' }}>
          <span className="text-[11px] min-w-0 flex-1 truncate" style={{ color: error ? 'var(--error)' : 'var(--text-secondary)' }} data-testid="production-summary" title={running ? runStatusText : undefined}>
            {error || status?.error || (running ? runStatusText : pending ? `${pending} 处待生成` : status?.phase || '全部已生成')}
          </span>
          {running ? (
            <button type="button" className="btn btn-ghost" data-testid="production-stop" onClick={() => void stop()}>
              <Square size={12} />停止
            </button>
          ) : (
            <>
              {unplanned && (
                <button type="button" className="btn btn-ghost" disabled={busy} data-testid="production-plan" title="先配音、分段、拆分镜，不生图不渲染：挑好描述再出画面，省钱"
                  onClick={() => void run(undefined, 'plan')}>
                  <Wand2 size={13} />先出分镜
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={busy || (!pending && !!doc.segments.length)} data-testid="production-run" onClick={() => void run()}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {doc.segments.length && !unplanned ? `生成改动${pending ? `（${pending}）` : ''}` : '一键成片'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const SegmentEditor = memo(function SegmentEditor({ ctx, seg, index }: { ctx: Ctx; seg: ProductionSegment; index: number }) {
  const { doc, locked, edit, run } = ctx
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(seg.text)
  useEffect(() => setText(seg.text), [seg.text])
  const textChanged = text.trim() !== seg.text
  const last = index === doc.segments.length - 1
  const phrases = seg.voice?.phrases ?? []
  const usedStarts = new Set(seg.boards.map((b) => b.start))
  const sentenceStarts = phrases.map((p, i) => ({ p, i })).filter(({ p, i }) => i > 0 && p.sentence !== phrases[i - 1].sentence && !usedStarts.has(i))

  function locate() {
    const t = segmentClipStart(doc, seg)
    if (t == null) useApp.getState().setToast('这段还没上时间轴')
    else useApp.getState().setPlayhead(t)
  }

  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="eyebrow">第 {index + 1} 段</span>
          <input
            key={seg.title}
            className="skill-element-label"
            defaultValue={seg.title}
            placeholder="小标题"
            maxLength={10}
            disabled
            title="小标题由 AI 分段时给出"
          />
          {seg.voice && <span className="prod-badge">{fmt(seg.voice.duration)} · {phrases.length} 个短语</span>}
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className="btn btn-ghost" style={{ height: 26 }} title="播放头跳到这段" onClick={locate}><Crosshair size={12} />定位</button>
            <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={locked} data-testid="production-seg-run" title="只把这一段补齐（配音 / 分镜 / 生图 / 渲染里待生成的）"
              onClick={() => void run({ segments: [seg.id] })}><Sparkles size={12} />只生成这段</button>
            <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={locked || !seg.voice} title="丢掉这段的分镜，下次生成让 AI 重新拆（描述没变的元素沿用原图）"
              onClick={() => void edit([{ op: 'replanSegment', segment: seg.id }])}><RefreshCw size={12} />重拆分镜</button>
            <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} disabled={locked || last} title="和下一段合并" onClick={() => void edit([{ op: 'mergeSegment', segment: seg.id }])}><Merge size={12} /></button>
            <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} disabled={locked || doc.segments.length <= 1} title="删除这段"
              onClick={() => { if (window.confirm('删除这一段口播？它在时间轴上的配音、画面、字幕也会一起删掉')) void edit([{ op: 'removeSegment', segment: seg.id }]) }}><Trash2 size={12} /></button>
          </span>
        </div>
        <textarea
          ref={textRef}
          rows={4}
          className="skill-textarea"
          data-testid="production-seg-text"
          value={text}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{charLen(text)} 字{seg.plan ? ` · 分镜${seg.plan.source === 'user' ? '（手改过）' : seg.plan.source === 'fallback' ? '（兜底）' : ''}：${seg.plan.notes || '—'}` : ''}</span>
          <span className="ml-auto flex gap-1">
            <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={locked || textChanged} title="在光标处切成两段"
              onClick={() => { const at = textRef.current?.selectionStart ?? 0; void edit([{ op: 'splitSegment', segment: seg.id, at }]) }}><Scissors size={12} />在光标处拆段</button>
            {textChanged && (
              <>
                <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => setText(seg.text)}>还原</button>
                <button type="button" className="btn btn-primary" style={{ height: 26 }} disabled={locked} data-testid="production-seg-save" title="改文案后这段会重新配音、重拆分镜"
                  onClick={() => void edit([{ op: 'setSegmentText', segment: seg.id, text }])}>保存文案</button>
              </>
            )}
          </span>
        </div>
      </section>

      {seg.boards.map((b, k) => <BoardCard key={b.id} ctx={ctx} seg={seg} board={b} k={k} />)}

      {seg.voice && seg.plan && ctx.doc.skillId !== 'builtin.dynamic-text' && <AddBoard ctx={ctx} seg={seg} starts={sentenceStarts} />}
      {!seg.plan && !locked && (
        <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>这段还没有分镜：点「只生成这段」或底部的「先出分镜」。</p>
      )}
    </>
  )
})

function AddBoard({ ctx, seg, starts }: { ctx: Ctx; seg: ProductionSegment; starts: { p: { text: string; start: number }; i: number }[] }) {
  const [start, setStart] = useState<number | null>(null)
  const [draw, setDraw] = useState('')
  if (!starts.length) return null
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: 'var(--text-secondary)' }}>
      <span>在</span>
      <select value={start ?? ''} disabled={ctx.locked} onChange={(e) => setStart(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">选一句…</option>
        {starts.map(({ p, i }) => <option key={i} value={i}>{fmt(p.start)} {p.text.slice(0, 16)}</option>)}
      </select>
      <span>换一块新黑板，先画</span>
      <input className="skill-element-label" style={{ width: 240, fontWeight: 400 }} placeholder="英文画面描述" value={draw} maxLength={240} onChange={(e) => setDraw(e.target.value)} />
      <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={ctx.locked || start == null || !draw.trim()}
        onClick={() => void ctx.edit([{ op: 'addBoard', segment: seg.id, start: start!, element: { label: '新元素', draw: draw.trim() } }]).then((ok) => { if (ok) { setDraw(''); setStart(null) } })}>
        <Plus size={12} />加镜头
      </button>
    </div>
  )
}

const BoardCard = memo(function BoardCard({ ctx, seg, board, k }: { ctx: Ctx; seg: ProductionSegment; board: ProductionBoard; k: number }) {
  const { locked, edit, run, maxElements } = ctx
  const [draw, setDraw] = useState('')
  const span = boardSpan(seg, k)
  const phrases = seg.voice?.phrases ?? []
  const end = seg.boards[k + 1]?.start ?? phrases.length
  const range = phrases.slice(board.start, end).map((p, j) => ({ ...p, i: board.start + j }))
  const dirty = board.dirty || board.elements.some((e) => e.dirty)
  if (ctx.doc.skillId === 'builtin.dynamic-text') return <section className={clsx('prod-board', dirty && 'is-dirty')} data-testid={`production-board-${board.id}`}>
    <div className="flex items-center gap-2"><strong>文字镜头 {k + 1}</strong><span className="prod-badge">{fmt(span.start)} – {fmt(span.end)}</span>
      {dirty && <span className="prod-badge is-dirty">待生成</span>}
      <button type="button" className="btn btn-ghost ml-auto" disabled={locked} onClick={() => void run({ boards: [board.id] })}>更新此镜头</button>
    </div>
    {board.elements.map(el => <textarea key={`${el.id}/${el.label}`} className="skill-textarea" aria-label="镜头文字" rows={2} defaultValue={el.label} maxLength={12} disabled={locked}
      onBlur={e => { const label = e.target.value.trim(); if (label && label !== el.label) void edit([{ op: 'setElement', element: el.id, patch: { label } }]) }} />)}
    <p className="editor-hint">自动按配音对时 · {board.render?.result?.layout || '待安排效果'} · 入轨后可在片段属性中编辑效果</p>
  </section>
  return (
    <section className={clsx('prod-board', dirty && 'is-dirty')} data-testid={`production-board-${board.id}`}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold">黑板 {k + 1}</span>
        <span className="prod-badge">{fmt(span.start)} – {fmt(span.end)}</span>
        {dirty && <span className="prod-badge is-dirty">待生成</span>}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="btn btn-ghost" style={{ height: 24 }} disabled={locked} title="只生成这块黑板（补图 + 重渲）" onClick={() => void run({ boards: [board.id] })}>
            <Sparkles size={12} />只生成这块
          </button>
          <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} disabled={locked || seg.boards.length <= 1} title="删掉这块黑板"
            onClick={() => void edit([{ op: 'removeBoard', board: board.id }])}><Trash2 size={12} /></button>
        </span>
      </div>
      <p className="prod-board-text m-0">{range.map((p) => p.text).join('')}</p>
      {board.elements.map((e, i) => <ElementRow key={e.id} ctx={ctx} board={board} el={e} i={i} range={range} />)}
      {board.elements.length < maxElements && (
        <div className="flex items-center gap-1.5">
          <input className="skill-element-label flex-1" style={{ fontWeight: 400, width: 'auto' }} placeholder="再加一个元素：英文画面描述" value={draw} maxLength={240} disabled={locked} onChange={(e) => setDraw(e.target.value)} />
          <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={locked || !draw.trim()}
            onClick={() => void edit([{ op: 'addElement', board: board.id, element: { label: '新元素', draw: draw.trim() } }]).then((ok) => { if (ok) setDraw('') })}>
            <Plus size={12} />加元素
          </button>
        </div>
      )}
    </section>
  )
})

const ElementRow = memo(function ElementRow({ ctx, board, el, i, range }: {
  ctx: Ctx; board: ProductionBoard; el: ProductionElement; i: number; range: { text: string; start: number; i: number }[]
}) {
  const { locked, edit, run, upload } = ctx
  const fileRef = useRef<HTMLInputElement>(null)
  const pick = pickedVariant(el)
  const patch = (p: Extract<ProductionOp, { op: 'setElement' }>['patch']) => edit([{ op: 'setElement', element: el.id, patch: p }])
  return (
    <div className="skill-element" data-testid={`production-el-${el.id}`}>
      <span className="skill-element-index" style={{ background: ELEMENT_COLORS[i % ELEMENT_COLORS.length] }}>{i + 1}</span>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <input key={el.label} className="skill-element-label" defaultValue={el.label} maxLength={12} disabled={locked}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== el.label) void patch({ label: v }) }} />
          <div className="skill-seg">
            {(Object.keys(ROLE_LABELS) as ProductionRole[]).map((r) => (
              <button key={r} type="button" disabled={locked} className={clsx(el.role === r && 'active')} onClick={() => { if (r !== el.role) void patch({ role: r }) }}>{ROLE_LABELS[r]}</button>
            ))}
          </div>
          <label className="skill-element-weight" title="讲到哪句时开始画">
            起笔
            <select value={el.at} disabled={locked} style={{ maxWidth: 150 }} onChange={(e) => void patch({ at: Number(e.target.value) })}>
              {range.map((p) => <option key={p.i} value={p.i}>{fmt(p.start)} {p.text.slice(0, 10)}</option>)}
            </select>
          </label>
          {el.dirty && <span className="prod-badge is-dirty">待生成</span>}
          <span className="ml-auto flex items-center">
            <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="先写" disabled={locked || i === 0} onClick={() => void edit([{ op: 'moveElement', element: el.id, delta: -1 }])}><ArrowUp size={12} /></button>
            <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="后写" disabled={locked || i === board.elements.length - 1} onClick={() => void edit([{ op: 'moveElement', element: el.id, delta: 1 }])}><ArrowDown size={12} /></button>
            <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} title="删除元素" disabled={locked} onClick={() => void edit([{ op: 'removeElement', element: el.id }])}><Trash2 size={12} /></button>
          </span>
        </div>
        <textarea key={el.draw} rows={2} className="skill-textarea" maxLength={240} defaultValue={el.draw} disabled={locked}
          title="英文画面描述；改了会新开一张候选图，旧图留着可以选回去"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== el.draw) void patch({ draw: v }) }} />
        <div className="prod-variants">
          {el.variants.map((v) => (
            <button key={v.id} type="button" className={clsx('prod-variant', v === pick && 'active', v.error && 'is-error')} disabled={locked}
              title={v.error ? `失败：${v.error}` : v === pick ? '当前用的这张' : '用这张'}
              onClick={() => { if (v !== pick) void edit([{ op: 'pickVariant', element: el.id, variant: v.id }]) }}>
              {v.url ? <img src={aiUrl(v.url)} alt="" loading="lazy" /> : <span>{v.error ? '失败' : '待生成'}</span>}
              {v.source === 'upload' && <span className="prod-variant-tag">上传</span>}
              {el.variants.length > 1 && !locked && (
                <span className="prod-variant-del" role="button" title="删掉这张" onClick={(e) => { e.stopPropagation(); void edit([{ op: 'removeVariant', element: el.id, variant: v.id }]) }}><X size={9} /></span>
              )}
            </button>
          ))}
          <button type="button" className="prod-variant-add" disabled={locked} title="同一描述再出一张，选中后重渲这块黑板"
            onClick={() => void edit([{ op: 'addVariant', element: el.id }]).then((ok) => { if (ok) void run({ elements: [el.id] }) })}>
            <Wand2 size={13} />再来一张
          </button>
          <button type="button" className="prod-variant-add" disabled={locked} title="用自己的图（黑底粉笔效果最好）" onClick={() => fileRef.current?.click()}>
            <Upload size={13} />上传
          </button>
          {el.dirty && (
            <button type="button" className="prod-variant-add" disabled={locked} title="只生成这个元素（补图 + 重渲所在黑板）" onClick={() => void run({ elements: [el.id] })}>
              <Sparkles size={13} />生成
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(el.id, f) }} />
        </div>
      </div>
    </div>
  )
})
