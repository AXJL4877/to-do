import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Captions, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { usePreviewSuspend } from '../hooks/usePreviewSuspend'
import { SUBTITLE_FONT, subtitleFontPx, subtitleMarginPx, type SkillPack, type SkillParams, type SubtitleSourceMedia } from '../lib/aiSkills'
import { burnSubtitles, initialSubtitleParams, narrationText, subtitlePack, subtitleTargets } from '../lib/subtitleBurn'
import { SkillParamControl } from './SkillStudio'

const CSS_FONT: Record<string, string> = {
  smiley: '"Smiley Sans Oblique", "Smiley Sans"',
  yahei: '"Microsoft YaHei"',
  heiti: 'SimHei, "黑体"',
  kaiti: 'KaiTi, "楷体"',
  xingkai: 'STXingkai, "华文行楷"',
  lishu: 'LiSu, "隶书"',
  hupo: 'STHupo, "华文琥珀"',
}
const cssFont = (v: unknown) => `${CSS_FONT[String(v)] ?? `"${SUBTITLE_FONT[String(v)] ?? 'Microsoft YaHei'}"`}, sans-serif`

const POSITION_PRESETS = [
  { label: '底部', pct: 6 },
  { label: '偏下', pct: 16 },
  { label: '居中', pct: 45 },
  { label: '顶部', pct: 82 },
]

type ReadyTarget = { clipId: string; jobId?: string; media?: SubtitleSourceMedia }

/** 预览句：取文案第一句，按「每条字数」截断 */
function sampleLine(text: string, maxChars: number) {
  const first = text.trim().split(/[。！？!?\n]/)[0]?.replace(/[，,、；;：:]/g, ' ').trim() || '字幕会按识别出的语音逐句显示'
  return first.length > maxChars ? first.slice(0, maxChars) : first
}

/** 节目画面当前帧；拿不到（原生预览 / 画布被污染）时返回 null */
function grabProgramFrame(): string | null {
  const canvas =
    document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas-3d"]')
    ?? document.querySelector<HTMLCanvasElement>('[data-testid="program-canvas"]')
    ?? document.getElementById('program-canvas') as HTMLCanvasElement | null
  if (!canvas || !canvas.width || !canvas.height) return null
  try {
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return null
  }
}

function Preview({ params, script, frame }: { params: SkillParams; script: string; frame: string | null }) {
  const [W, H] = String(params.size).split('x').map(Number)
  const px = subtitleFontPx(params, W, H)
  const stroke = Math.max(2, Math.round(px / 18))
  const style: CSSProperties = {
    fontFamily: cssFont(params.font),
    fontSize: `${(px / H) * 100}cqh`,
    bottom: `${(subtitleMarginPx(params, H) / H) * 100}%`,
    WebkitTextStroke: `${(stroke * 2 / H) * 100}cqh #000`,
    paintOrder: 'stroke fill',
  }
  return (
    <div className="subburn-preview" style={{ aspectRatio: `${W} / ${H}` }} data-testid="subburn-preview">
      {frame && <img src={frame} alt="" />}
      <span style={style}>{sampleLine(script, Number(params.maxChars) || 18)}</span>
    </div>
  )
}

/** 右键「烧录字幕」弹窗：选字体 / 字号 / 位置，所见即所得预览，确认后给每段选中的配音各烧一份 */
export function SubtitleBurnDialog({ clipIds, onClose }: { clipIds: string[]; onClose: () => void }) {
  usePreviewSuspend(true, 'dialog')
  const [pack, setPack] = useState<SkillPack | null>(null)
  const [params, setParams] = useState<SkillParams>({})
  const [script, setScript] = useState('')
  const [frame] = useState(grabProgramFrame)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const targets = useMemo(() => subtitleTargets(clipIds), [clipIds])
  /** 能烧的片段：有配音文案的带 jobId，其余带 media 走语音识别；null = 还在查 */
  const [ready, setReady] = useState<ReadyTarget[] | null>(null)
  const count = ready?.length ?? 0
  const asrCount = ready?.filter((r) => !r.jobId).length ?? 0
  const skipped = targets.audio.length - count

  useEffect(() => {
    subtitlePack()
      .then((p) => { setPack(p); setParams(initialSubtitleParams(p)) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    const jobIds = [...new Set(targets.burnable.flatMap((b) => b.jobId ? [b.jobId] : []))]
    void Promise.all(jobIds.map(async (id) => [id, await narrationText(id)] as const)).then((pairs) => {
      const texts = new Map(pairs)
      const list = targets.burnable.flatMap((b): ReadyTarget[] => {
        if (b.jobId && texts.get(b.jobId) != null) return [{ clipId: b.clip.id, jobId: b.jobId, media: b.media ?? undefined }]
        return b.media ? [{ clipId: b.clip.id, media: b.media }] : []
      })
      setReady(list)
      const first = list.find((r) => r.jobId)
      setScript(first?.jobId ? texts.get(first.jobId) ?? '' : '')
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [targets])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const param = (id: string) => pack?.params.find((p) => p.id === id)
  const set = (id: string, v: string | number) => setParams((cur) => ({ ...cur, [id]: v }))
  const fontParam = param('font')

  async function submit() {
    if (!pack || !count || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await burnSubtitles(ready ?? [], params)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop" data-testid="subburn-dialog" onClick={onClose}>
      <div className="modal" style={{ width: 'min(960px, 100%)', maxHeight: '92vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <Captions size={14} style={{ color: 'var(--accent)' }} />
          <span className="eyebrow">烧录字幕</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {ready == null ? '正在检查配音…' : `${count} 段音频${count > asrCount ? ` · ${count - asrCount} 段复用 TTS 时间戳` : ''}${asrCount > 0 ? ` · ${asrCount} 段无 TTS 时间戳，使用语音识别` : ''}${skipped > 0 ? ` · 跳过 ${skipped} 段（读不到本地文件）` : ''}`}
          </span>
          <button className="icon-btn ml-auto" data-testid="subburn-close" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        {!pack ? (
          <div className="py-16 text-center text-[12px]" style={{ color: error ? 'var(--error)' : 'var(--text-muted)' }}>
            {error || <Loader2 size={16} className="animate-spin inline" />}
          </div>
        ) : (
          <div className="flex flex-col md:flex-row min-h-0 overflow-y-auto">
            <div className="flex-1 min-w-0 p-4 flex items-center justify-center" style={{ background: 'var(--surface-0)' }}>
              <Preview params={params} script={script} frame={frame} />
            </div>

            <div className="md:w-[320px] shrink-0 p-4 flex flex-col gap-4 border-t md:border-t-0 md:border-l overflow-y-auto" style={{ borderColor: 'var(--border)' }}>
              {fontParam?.type === 'select' && (
                <div className="field" data-testid="subburn-font">
                  <label>{fontParam.label}</label>
                  <div className="subburn-fonts">
                    {fontParam.options.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={clsx('subburn-font', params.font === o.value && 'active')}
                        style={{ fontFamily: cssFont(o.value) }}
                        data-testid={`subburn-font-${o.value}`}
                        onClick={() => set('font', o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {param('fontPx') && <SkillParamControl p={param('fontPx')!} values={params} onChange={set} />}
              {param('bottomPct') && (
                <div className="flex flex-col gap-1.5">
                  <SkillParamControl p={param('bottomPct')!} values={params} onChange={set} />
                  <div className="skill-seg" data-testid="subburn-position">
                    {POSITION_PRESETS.map((q) => (
                      <button key={q.label} type="button" className={clsx(params.bottomPct === q.pct && 'active')} onClick={() => set('bottomPct', q.pct)}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {param('maxChars') && <SkillParamControl p={param('maxChars')!} values={params} onChange={set} />}
              {param('keywords') && <SkillParamControl p={param('keywords')!} values={params} onChange={set} />}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <span className="text-[11px] min-w-0 flex-1 truncate" style={{ color: error ? 'var(--error)' : 'var(--text-muted)' }}>
            {error || '字幕进字幕轨并链接到音频；语音识别可能认错字，烧完可在字幕轨里改；关键词变色只在烧录的 WebM 里生效'}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" data-testid="subburn-submit" disabled={!pack || !count || submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Captions size={13} />}
            烧录{count > 1 ? ` ${count} 段` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
