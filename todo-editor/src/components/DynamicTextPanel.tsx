import { ChevronLeft } from 'lucide-react'
import { TextPresetEditor } from './TextPresetEditor'

export function DynamicTextPanel({ onBack }: { onBack: () => void }) {
  return <div data-testid="dynamic-text-extension">
    <div className="skill-head">
      <button type="button" className="icon-btn" aria-label="返回拓展列表" data-testid="dynamic-pack-back" onClick={onBack}><ChevronLeft size={14} /></button>
      <span className="text-[12px] font-semibold">动态文字拓展</span>
    </div>
    <p className="editor-hint">完整编排支持 27 套风格与 860 个效果部件，可选风格背景或透明叠加。口播一键成片请返回拓展列表。</p>
    <TextPresetEditor extension />
  </div>
}
