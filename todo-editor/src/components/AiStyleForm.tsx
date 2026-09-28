import clsx from 'clsx'
import { Image as ImageIcon, Scissors } from 'lucide-react'

export type StyleInput =
  | { id: string; type: 'text'; label: string; required: boolean; maxLength: number; placeholder: string }
  | { id: string; type: 'select'; label: string; default: string; options: { value: string; label: string }[] }

export type StylePack = {
  id: string
  name: string
  version: string
  author: string
  description: string
  tags: string[]
  previews: string[]
  outputs: string[]
  inputs: StyleInput[]
  image: {
    models: string[]
    aspectRatios: string[]
    defaultAspectRatio: string
    resolutions: string[]
    defaultResolution: string
  }
  cutout: { default: boolean; lockInputs: Record<string, string> } | null
  hasReference: boolean
}

export type StyleValues = {
  inputs: Record<string, string>
  aspectRatio: string
  resolution: string
  model: string
  cutout: boolean
}

export function defaultStyleValues(pack: StylePack): StyleValues {
  const inputs: Record<string, string> = {}
  for (const inp of pack.inputs) inputs[inp.id] = inp.type === 'select' ? inp.default : ''
  return {
    inputs,
    aspectRatio: pack.image.defaultAspectRatio,
    resolution: pack.image.defaultResolution,
    model: pack.image.models[0],
    cutout: pack.cutout?.default ?? false,
  }
}

export function styleValuesReady(pack: StylePack, v: StyleValues) {
  return pack.inputs.every((inp) => inp.type !== 'text' || !inp.required || !!v.inputs[inp.id]?.trim())
}

/** 按风格包声明渲染表单；只能填声明过的字段 */
export function AiStyleForm({ pack, value, onChange }: {
  pack: StylePack
  value: StyleValues
  onChange: (v: StyleValues) => void
}) {
  const setInput = (id: string, v: string) => onChange({ ...value, inputs: { ...value.inputs, [id]: v } })
  const locked = value.cutout && pack.cutout ? pack.cutout.lockInputs : {}

  return (
    <div className="flex flex-col gap-2.5" data-testid={`ai-style-form-${pack.id}`}>
      <p className="text-[11px] m-0 px-0.5" style={{ color: 'var(--text-muted)' }}>
        {pack.description}
      </p>
      {pack.cutout && (
        <div className="field">
          <label>输出</label>
          <div className="tab-row" data-testid="ai-style-output">
            <button
              type="button"
              className={clsx('tab flex-1', value.cutout && 'active')}
              data-testid="ai-style-output-cutout"
              onClick={() => onChange({ ...value, cutout: true })}
            >
              <Scissors size={11} className="inline mr-1" />透明底 PNG
            </button>
            <button
              type="button"
              className={clsx('tab flex-1', !value.cutout && 'active')}
              data-testid="ai-style-output-full"
              onClick={() => onChange({ ...value, cutout: false })}
            >
              <ImageIcon size={11} className="inline mr-1" />保留背景
            </button>
          </div>
          <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>
            {value.cutout ? '生成后自动抠像并裁掉空白，得到可直接叠加的元素' : '输出完整画面，含背景'}
          </span>
        </div>
      )}
      {pack.inputs.map((inp) => (
        <div className="field" key={inp.id}>
          <label>{inp.label}{inp.type === 'text' && inp.required ? ' *' : ''}</label>
          {inp.type === 'text' ? (
            <>
              <textarea
                rows={3}
                data-testid={`ai-style-input-${inp.id}`}
                maxLength={inp.maxLength}
                placeholder={inp.placeholder}
                value={value.inputs[inp.id] ?? ''}
                onChange={(e) => setInput(inp.id, e.target.value)}
              />
              <span className="text-[10px] px-0.5 text-right" style={{ color: 'var(--text-muted)' }}>
                {(value.inputs[inp.id] ?? '').length}/{inp.maxLength}
              </span>
            </>
          ) : (
            <>
              <select
                data-testid={`ai-style-input-${inp.id}`}
                value={locked[inp.id] ?? value.inputs[inp.id] ?? inp.default}
                disabled={inp.id in locked}
                onChange={(e) => setInput(inp.id, e.target.value)}
              >
                {inp.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {inp.id in locked && (
                <span className="text-[10px] px-0.5" style={{ color: 'var(--text-muted)' }}>透明底模式下固定，保证抠像干净</span>
              )}
            </>
          )}
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2">
        <div className="field">
          <label>画幅</label>
          <select data-testid="ai-style-aspect" value={value.aspectRatio} onChange={(e) => onChange({ ...value, aspectRatio: e.target.value })}>
            {pack.image.aspectRatios.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="field">
          <label>分辨率</label>
          <select data-testid="ai-style-resolution" value={value.resolution} onChange={(e) => onChange({ ...value, resolution: e.target.value })}>
            {pack.image.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      {pack.image.models.length > 1 && (
        <div className="field">
          <label>模型</label>
          <select data-testid="ai-style-model" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {pack.image.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
