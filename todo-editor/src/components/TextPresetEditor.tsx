import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronLeft, Pause, Play, Plus, Shuffle } from 'lucide-react'
import { useApp } from '../store'
import { defaultText, type Clip, type DynamicText, type FancyText, type TextStyle } from '../types'
import { FANCY_CATEGORIES, FANCY_PRESETS, availableFonts, clonePresetFancy, drawFancyText, onFancyTextureLoaded, pickFont, presetCategory, type FancyCategory, type FancyPreset } from '../lib/fancyText'
import { DYNAMIC_TEXT_PACK, DYNAMIC_TEXT_PRESETS } from '../lib/dynamicTextPack'
import { JizuraCompositionControls } from './JizuraCompositionControls'
import { NumInput } from './NumInput'
import { PropSection } from './PropUI'
import { drawTextClip } from '../lib/monitorDraw'
import { dynamicTextWarning, invalidateDynamicTextFonts, normalizeDynamicText } from '../lib/dynamicText'

const DEFAULT_PRESET = FANCY_PRESETS[0]

function initialText(preset = DEFAULT_PRESET): TextStyle {
  const fancy = clonePresetFancy(preset)
  return { ...defaultText(), content: '把灵感写下来', fontFamily: pickFont(preset.fonts), fontSize: 96, fancy,
    ...(fancy.chalk || fancy.dynamic ? { animIn: 'none', animOut: 'none' } : {}) } as TextStyle
}

/** Plain text clips get an equivalent fancy style so the panel can edit them in place. */
function fancyOf(t: TextStyle): FancyText {
  if (t.fancy) return t.fancy
  return { fontWeight: 700, fill: [t.color || '#ffffff'], fillAngle: 90,
    strokes: t.strokeWidth > 0 ? [{ color: t.strokeColor, width: t.strokeWidth }] : [] }
}

function swatch(f: FancyText): CSSProperties {
  const outer = f.strokes[f.strokes.length - 1]
  const shadows = [
    f.extrude && `2px 3px 0 ${f.extrude.color}`,
    f.glow && `0 0 6px ${f.glow.color}`,
    f.shadow && `0 2px 3px ${f.shadow.color}`,
  ].filter(Boolean).join(',')
  return {
    color: f.fill[0], fontWeight: f.fontWeight,
    background: f.bg?.color ?? (f.chalk ? '#203532' : f.dynamic ? '#242b36' : undefined),
    WebkitTextStroke: outer ? `1px ${outer.color}` : undefined,
    textShadow: shadows || undefined,
  }
}

const hex = (c: string | undefined, fb: string) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : fb)

export function TextPresetEditor({ extension = false }: { extension?: boolean }) {
  const presets = extension ? DYNAMIC_TEXT_PRESETS : FANCY_PRESETS
  const categories = extension ? [{ id: 'dynamic', name: DYNAMIC_TEXT_PACK.name }] : FANCY_CATEGORIES
  const clip = useApp(s => s.sequences.find(q => q.id === s.activeSeqId)?.clips.find(c => c.id === s.selectedClipIds[0] && c.text && (extension ? !!c.text.fancy?.dynamic : !c.text.fancy?.dynamic)))
  const selectedCount = useApp(s => s.selectedClipIds.length)
  const settings = useApp(s => s.settings)
  const update = useApp(s => s.updateSelectedText)
  const [draft, setDraft] = useState(() => initialText(presets[0]))
  const text = clip?.text ?? draft
  const style = fancyOf(text)
  const chalk = style.chalk
  const dynamic = normalizeDynamicText(style.dynamic)
  const isDynamic = !!style.dynamic
  const [category, setCategory] = useState<FancyCategory | null>(() => clip?.text?.fancy ? (isDynamic ? 'dynamic' : presetCategory(style.preset)) : extension ? 'dynamic' : null)
  const [playing, setPlaying] = useState(false)
  const [playCycle, setPlayCycle] = useState(0)
  const [time, setTime] = useState(99)
  const [board, setBoard] = useState(true)
  const [texTick, setTexTick] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const fonts = useMemo(() => availableFonts(), [])
  const total = dynamic ? (clip?.duration ?? dynamic.duration) : chalk ? chalk.duration + 1 : 0
  const previewW = isDynamic ? (settings.height > settings.width ? 360 : 640) : 640
  const previewH = isDynamic ? Math.round(previewW * settings.height / settings.width) : 200
  const presetName = presets.find(p => p.id === style.preset)?.name ?? '文字'

  function patch(p: Partial<TextStyle>) {
    if (clip) update(p)
    else setDraft(t => ({ ...t, ...p }))
  }
  function setFancy(p: Partial<FancyText>) { patch({ fancy: { ...style, ...p } }) }
  function setChalk(p: Partial<NonNullable<FancyText['chalk']>>) { if (chalk) setFancy({ chalk: { ...chalk, ...p } }) }
  function setDynamic(p: Partial<DynamicText>) { if (dynamic) setFancy({ dynamic: { ...dynamic, ...p } }) }
  function applyPreset(p: FancyPreset) {
    const next = clonePresetFancy(p)
    const d = defaultText()
    const anim = next.chalk || next.dynamic ? { animIn: 'none', animOut: 'none' } : chalk || isDynamic ? { animIn: d.animIn, animOut: d.animOut } : {}
    patch({ fancy: next, fontFamily: pickFont(p.fonts), color: next.fill[0], ...anim } as Partial<TextStyle>)
    if (next.chalk || next.dynamic) { setTime(0); setPlaying(true); setPlayCycle(n => n + 1) }
  }
  function openCategory(id: FancyCategory) {
    setCategory(id)
    const first = presets.find(p => p.category === id)
    if (first && (!text.fancy || presetCategory(style.preset) !== id)) applyPreset(first)
  }

  useEffect(() => { setPlaying(false); setTime(isDynamic ? Math.min(1.2, total / 2) : 99); setCategory(clip?.text?.fancy ? (isDynamic ? 'dynamic' : presetCategory(style.preset)) : extension ? 'dynamic' : null) }, [clip?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onFancyTextureLoaded(() => setTexTick(n => n + 1)), [])
  useEffect(() => {
    if (!isDynamic) return
    let cancelled = false
    document.fonts.load(`${style.fontWeight || 700} 48px "${text.fontFamily}"`, text.content || '字Ab')
      .then(() => { if (!cancelled) { invalidateDynamicTextFonts(); setTexTick(n => n + 1) } }).catch(() => {})
    return () => { cancelled = true }
  }, [isDynamic, text.fontFamily, style.fontWeight])
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const start = performance.now()
    const from = time >= total ? 0 : time
    const tick = (now: number) => {
      const t = from + (now - start) / 1000
      setTime(Math.min(total, t))
      if (t < total) raf = requestAnimationFrame(tick)
      else setPlaying(false)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, total, style.preset, dynamic?.seed, playCycle])
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.save(); ctx.translate(cv.width / 2, cv.height / 2)
    if (isDynamic) {
      drawTextClip(ctx, { text: { ...text, fancy: style }, start: 0, duration: total || 3, keyframes: clip?.keyframes ?? {} } as Clip,
        cv.width, cv.height, Math.min(time, total || 3))
      ctx.restore()
      return
    }
    const lines = text.content.split('\n')
    const longest = Math.max(1, ...lines.map(l => Array.from(l).length))
    const px = Math.min(64, 520 / longest, 150 / (lines.length * text.lineHeight))
    drawFancyText(ctx, { lines, fontPx: px, family: text.fontFamily, align: 'center',
      lineHeight: text.lineHeight, letterSpacing: text.letterSpacing,
      fancy: style, k: px / text.fontSize, time: chalk ? time : undefined })
    ctx.restore()
  }, [text, time, texTick, category, previewW, previewH, total, clip?.keyframes]) // eslint-disable-line react-hooks/exhaustive-deps

  function add() {
    const name = `${presetName} · ${text.content.slice(0, 12)}`
    useApp.getState().addTextClip({ name, text: { ...text, fancy: style } })
    if (chalk || dynamic) {
      const duration = dynamic?.version === 2 ? dynamic.duration : Math.max(3, chalk ? total : dynamic!.duration)
      useApp.getState().updateSelectedClip({ duration, outPoint: duration })
    }
  }

  const outer = style.strokes[style.strokes.length - 1]
  const setOuter = (p: Partial<typeof outer>) => setFancy({ strokes: style.strokes.map((s, i) => i === style.strokes.length - 1 ? { ...s, ...p } : s) })

  if (!category) return <div className="chalk-title-editor" data-testid="fancy-text-panel">
    <div className="fancy-gallery">
      {categories.map(c => {
        const p = presets.find(x => x.category === c.id)
        return <button type="button" key={c.id} data-testid={`fancy-cat-${c.id}`} onClick={() => openCategory(c.id)}>
          <span className="fancy-swatch" style={p ? swatch(p.fancy) : undefined}>{c.name}</span>
          {c.desc && <small>{c.desc}</small>}
        </button>
      })}
    </div>
  </div>

  const catName = categories.find(c => c.id === category)?.name ?? '文字'
  return <div className="chalk-title-editor" data-testid="fancy-text-panel">
    <div className="fancy-editor-head">
      {!extension && <button type="button" onClick={() => setCategory(null)} aria-label="返回文字样式" data-testid="fancy-back"><ChevronLeft size={14} /></button>}
      <strong>{catName}</strong>
      {clip && <span className="fancy-editing">编辑中 · {clip.name}{selectedCount > 1 ? `（+${selectedCount - 1}）` : ''}</span>}
    </div>
    <div className="chalk-title-preview" style={{ background: board ? (chalk ? '#203532' : '#1c1f22') : undefined }}>
      <canvas ref={canvas} width={previewW} height={previewH} style={isDynamic ? { maxHeight: 320, objectFit: 'contain' } : undefined} data-testid="fancy-preview" />
      <div className="chalk-preview-controls">
        {(chalk || dynamic) && <>
          <button type="button" data-testid="fancy-play" onClick={() => { if (time >= total) setTime(0); setPlaying(v => !v) }} aria-label={playing ? '暂停动画预览' : '播放动画预览'}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <input aria-label="动画预览进度" data-testid="fancy-seek" type="range" min={0} max={total} step={0.01} value={Math.min(total, time)} onChange={e => { setPlaying(false); setTime(Number(e.target.value)) }} />
          <button type="button" aria-label="重新播放" onClick={() => { setTime(0); setPlaying(true); setPlayCycle(n => n + 1) }}>重播</button>
        </>}
        <button type="button" className="ml-auto" onClick={() => setBoard(v => !v)} title="仅切换预览底色；画面背景由编排参数决定">{board ? '透明底' : '深色底'}</button>
      </div>
    </div>
    {dynamic && <div className="flex flex-col gap-1" data-testid="dynamic-controls">
      <button type="button" className="btn" data-testid="dynamic-shuffle" onClick={() => {
        const seed = new Uint32Array(1); crypto.getRandomValues(seed)
        setDynamic({ seed: seed[0] }); setTime(0); setPlaying(true)
      }}><Shuffle size={13} />换一版</button>
      {dynamic.version === 1 && <NumInput label="动画时长" unit="s" value={dynamic.duration} min={0.5} max={12} step={0.1} defaultValue={3} testId="dynamic-duration" onChange={duration => setDynamic({ duration })} />}
      <NumInput label="运动强度" value={dynamic.motion} min={0} max={1} step={0.05} defaultValue={0.7} testId="dynamic-motion" onChange={motion => setDynamic({ motion })} />
      {dynamic.version === 2 && dynamic.composition && <JizuraCompositionControls value={dynamic.composition} onChange={composition => setDynamic({composition})} />}
      {dynamic.version === 1 && <label className="editor-inline">强调色 <input aria-label="强调色" type="color" value={dynamic.accent} onChange={e => setDynamic({ accent: e.target.value })} /></label>}
      {clip && dynamic.duration > clip.duration && <p className="editor-hint">动画时长超过片段长度，尾部动画会被截断。</p>}
    </div>}
    {isDynamic && dynamicTextWarning(text) && <p className="editor-hint" data-testid="dynamic-warning">{dynamicTextWarning(text)}</p>}
    <textarea className="input fancy-content" rows={2} maxLength={300} value={text.content} placeholder="输入文字…" aria-label="文字内容" data-testid="fancy-content" onChange={e => patch({ content: e.target.value })} />
    {extension && <button type="button" className="btn" data-testid="dynamic-full" onClick={() => {
      const duration = clip?.duration || 3
      setFancy({preset:'dynamic-full',dynamic:{version:2,engine:'jizura',presetId:'dynamic-full',seed:2026,duration,motion:.7,accent:'#ffb454',
        composition:{style:'noir',mood:'graphic',background:'style',unify:true,parts:{},fx:{decor:.6,chroma:.4,glitch:.25,texture:.5,bgSwitch:.5},offset:0,scenes:[{content:text.content,start:0,end:duration}]}}})
      setTime(0); setPlaying(true)
    }}>完整编排 · 风格、背景与转场</button>}
    <div className="fancy-preset-grid">
      {presets.filter(p => p.category === category).map(p => <button type="button" key={p.id} title={p.name} className={style.preset === p.id ? 'is-selected' : ''} data-testid={`fancy-preset-${p.id}`} onClick={() => applyPreset(p)}>
        <span className="fancy-swatch" style={swatch(p.fancy)}>字</span>{p.name}
      </button>)}
    </div>
    <PropSection title="调整" defaultOpen={false} dense>
      <div className="editor-inline">
        <select className="input flex-1 min-w-0" aria-label="字体" value={text.fontFamily} onChange={e => patch({ fontFamily: e.target.value })}>
          {!fonts.some(f => f.family === text.fontFamily) && <option value={text.fontFamily}>{text.fontFamily}</option>}
          {fonts.map(f => <option key={f.family} value={f.family}>{f.label}</option>)}
        </select>
        {dynamic?.version !== 2 && <input aria-label="文字颜色" title="文字颜色" type="color" value={hex(style.fill[0], '#ffffff')} onChange={e => patch({ fancy: { ...style, fill: [e.target.value] }, color: e.target.value })} />}
      </div>
      {dynamic?.version === 2 && <p className="editor-hint">配色由整体风格决定；衬线与等宽角色使用宋体和 Consolas，其余文字使用所选字体。</p>}
      <NumInput label="字号" value={text.fontSize} min={12} max={300} defaultValue={96} showSlider={false} onChange={fontSize => patch({ fontSize })} />
      {!isDynamic && <NumInput label="字距" value={text.letterSpacing} min={-10} max={40} defaultValue={0} showSlider={false} onChange={letterSpacing => patch({ letterSpacing })} />}
      {outer && <div className="editor-inline">
        <span>描边</span>
        <input aria-label="描边颜色" type="color" value={hex(outer.color, '#000000')} onChange={e => setOuter({ color: e.target.value })} />
        <div className="flex-1 min-w-0"><NumInput value={outer.width} min={0} max={30} defaultValue={6} showSlider={false} testId="fancy-stroke-width" onChange={width => setOuter({ width })} /></div>
      </div>}
      {style.glow && <NumInput label="发光" value={style.glow.blur} min={0} max={60} defaultValue={24} onChange={blur => setFancy({ glow: { ...style.glow!, blur } })} />}
      {style.extrude && <NumInput label="立体厚度" value={style.extrude.depth} min={0} max={30} defaultValue={10} onChange={depth => setFancy({ extrude: { ...style.extrude!, depth } })} />}
      {style.bg && <div className="editor-inline"><label>底色 <input aria-label="底色" type="color" value={hex(style.bg.color, '#000000')} onChange={e => setFancy({ bg: { ...style.bg!, color: e.target.value } })} /></label></div>}
      {!chalk && !isDynamic && <div className="editor-inline"><label><input type="checkbox" checked={!!style.shadow} onChange={e => setFancy({ shadow: e.target.checked ? { color: '#000000a0', blur: 10, x: 0, y: 4 } : undefined })} /> 投影</label></div>}
      {chalk && <>
        <NumInput label="书写时长" unit="s" value={chalk.duration} min={0.2} max={12} step={0.1} defaultValue={2} onChange={duration => setChalk({ duration })} />
        {clip && chalk.duration > clip.duration && <p className="editor-hint">书写时长超过片段长度，尾部笔迹会被截断。</p>}
        <NumInput label="粉笔颗粒" value={chalk.grain} min={0} max={1} step={0.05} defaultValue={0.55} onChange={grain => setChalk({ grain })} />
        <div className="editor-inline"><label><input type="checkbox" checked={chalk.hand} onChange={e => setChalk({ hand: e.target.checked })} /> 显示粉笔手</label></div>
        <p className="editor-hint">按字形中心线模拟书写，非标准汉字笔顺。</p>
      </>}
    </PropSection>
    <div className="editor-actions">
      <button type="button" className="btn btn-primary" disabled={!text.content.trim()} onClick={add} data-testid="fancy-add"><Plus size={14} />{clip ? '另存为新文字' : '加入时间线'}</button>
    </div>
  </div>
}
