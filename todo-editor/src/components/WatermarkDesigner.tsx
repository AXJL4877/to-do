import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store'
import {
  DEFAULT_WATERMARK_DESIGN,
  loadWatermarkDesign,
  renderWatermarkPng,
  saveWatermarkDesign,
  type WatermarkAlign,
  type WatermarkDesign,
  type WatermarkPlacement,
} from '../lib/watermarkDesign'
import { ensureSmileyFont, watermarkFontChoices } from '../lib/textFonts'

const PLACEMENTS: { id: WatermarkPlacement; label: string }[] = [
  { id: 'bottom', label: '底部通栏' },
  { id: 'top', label: '顶部通栏' },
  { id: 'bottom-left', label: '左下角' },
  { id: 'bottom-right', label: '右下角' },
  { id: 'top-left', label: '左上角' },
  { id: 'top-right', label: '右上角' },
]

const ALIGNS: { id: WatermarkAlign; label: string }[] = [
  { id: 'left', label: '左对齐' },
  { id: 'center', label: '居中' },
  { id: 'right', label: '右对齐' },
]

/** 水印设计器：改文案 / 字号 / 排版，预览后应用到时间线或只进媒体库 */
export function WatermarkDesigner() {
  const settings = useApp((s) => s.settings)
  const setModal = useApp((s) => s.setModal)
  const applyWatermark = useApp((s) => s.applyWatermarkDesign)
  const composeSelection = useApp((s) => s.saveSelectionAsWatermark)
  const [design, setDesign] = useState<WatermarkDesign>(() => loadWatermarkDesign())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fontReady, setFontReady] = useState(0)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const fonts = useMemo(() => watermarkFontChoices(), [fontReady])

  useEffect(() => {
    void ensureSmileyFont().then(() => setFontReady((n) => n + 1))
  }, [])

  const preview = useMemo(() => {
    try {
      return renderWatermarkPng(design, settings.width, settings.height)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [design, settings.width, settings.height, fontReady])

  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !('dataUrl' in preview)) return
    const img = new Image()
    img.onload = () => {
      const maxW = 420
      const scale = Math.min(1, maxW / img.width)
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // 棋盘格表示透明
      const cell = 8
      for (let y = 0; y < canvas.height; y += cell) {
        for (let x = 0; x < canvas.width; x += cell) {
          ctx.fillStyle = ((x / cell + y / cell) & 1) ? '#3a3a3a' : '#2a2a2a'
          ctx.fillRect(x, y, cell, cell)
        }
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    }
    img.src = preview.dataUrl
  }, [preview])

  const patch = (p: Partial<WatermarkDesign>) => {
    setDesign((d) => ({ ...d, ...p }))
    setError(null)
  }

  const linesText = design.lines.join('\n')

  const run = async (placeOnTimeline: boolean) => {
    setBusy(true)
    setError(null)
    try {
      saveWatermarkDesign(design)
      await applyWatermark(design, { placeOnTimeline })
      setModal(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3" data-testid="watermark-designer" style={{ minWidth: 'min(520px, 100%)' }}>
      <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        自定义水印文案、字号和排版，生成透明底素材。默认是「小薇说交易」免责文案，可随意改。
      </p>

      <div className="field">
        <label>名称</label>
        <input
          data-testid="wm-name"
          value={design.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="水印名称"
        />
      </div>

      <div className="field">
        <label>文字（每行一条；第一行当标题）</label>
        <textarea
          data-testid="wm-lines"
          className="input"
          rows={4}
          value={linesText}
          onChange={(e) => patch({ lines: e.target.value.split(/\r?\n/) })}
        />
      </div>

      <div className="field">
        <label>字体</label>
        <select
          className="input"
          data-testid="wm-font"
          value={design.fontFamily}
          onChange={(e) => patch({ fontFamily: e.target.value })}
          style={{ fontFamily: design.fontFamily }}
        >
          {!fonts.some((f) => f.family === design.fontFamily) && (
            <option value={design.fontFamily}>{design.fontFamily}</option>
          )}
          {fonts.map((f) => (
            <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>{f.label}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="field">
          <label>标题字号 {design.titleSize}</label>
          <input
            type="range"
            min={14}
            max={64}
            value={design.titleSize}
            data-testid="wm-title-size"
            onChange={(e) => patch({ titleSize: +e.target.value })}
          />
        </div>
        <div className="field">
          <label>正文字号 {design.bodySize}</label>
          <input
            type="range"
            min={12}
            max={48}
            value={design.bodySize}
            data-testid="wm-body-size"
            onChange={(e) => patch({ bodySize: +e.target.value })}
          />
        </div>
        <div className="field">
          <label>不透明度 {Math.round(design.opacity * 100)}%</label>
          <input
            type="range"
            min={20}
            max={100}
            value={Math.round(design.opacity * 100)}
            data-testid="wm-opacity"
            onChange={(e) => patch({ opacity: +e.target.value / 100 })}
          />
        </div>
        <div className="field">
          <label>颜色</label>
          <input
            type="color"
            value={design.color}
            data-testid="wm-color"
            onChange={(e) => patch({ color: e.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label>位置</label>
        <div className="flex flex-wrap gap-1">
          {PLACEMENTS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn ${design.placement === p.id ? 'btn-primary' : 'btn-ghost'}`}
              data-testid={`wm-place-${p.id}`}
              onClick={() => patch({ placement: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {(design.placement === 'bottom' || design.placement === 'top') && (
        <div className="field">
          <label>文字对齐</label>
          <div className="flex flex-wrap gap-1">
            {ALIGNS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`btn ${design.align === a.id ? 'btn-primary' : 'btn-ghost'}`}
                data-testid={`wm-align-${a.id}`}
                onClick={() => patch({ align: a.id })}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={design.band}
          data-testid="wm-band"
          onChange={(e) => patch({ band: e.target.checked })}
        />
        半透明底带（黑白画面上都更清晰）
      </label>

      <div className="field">
        <label>预览</label>
        <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
          {'error' in preview ? (
            <div className="p-3 text-[12px]" style={{ color: 'var(--accent)' }}>{preview.error}</div>
          ) : (
            <canvas ref={previewRef} data-testid="wm-preview" style={{ display: 'block', width: '100%', height: 'auto' }} />
          )}
        </div>
      </div>

      {error && <div className="text-[12px]" style={{ color: 'var(--accent)' }}>{error}</div>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="wm-apply"
          disabled={busy || 'error' in preview}
          onClick={() => { void run(true) }}
        >
          {busy ? '处理中…' : '应用到时间线'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="wm-library"
          disabled={busy || 'error' in preview}
          onClick={() => { void run(false) }}
        >
          只存媒体库
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="wm-reset"
          disabled={busy}
          onClick={() => {
            const d = { ...DEFAULT_WATERMARK_DESIGN, lines: [...DEFAULT_WATERMARK_DESIGN.lines] }
            setDesign(d)
            saveWatermarkDesign(d)
          }}
        >
          恢复默认文案
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="wm-from-selection"
          disabled={busy}
          title="把当前选中的图/字合成一张透明水印（不经文字设计器）"
          onClick={() => {
            void composeSelection().then(() => setModal(null))
          }}
        >
          从选中层合成
        </button>
      </div>
    </div>
  )
}
