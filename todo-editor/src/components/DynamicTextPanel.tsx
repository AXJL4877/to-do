import { ChevronLeft } from 'lucide-react'
import { TextPresetEditor } from './TextPresetEditor'

export function DynamicTextPanel({ onBack }: { onBack: () => void }) {
  return <div data-testid="dynamic-text-extension">
    <div className="skill-head">
      <button type="button" className="icon-btn" aria-label="返回拓展列表" data-testid="dynamic-pack-back" onClick={onBack}><ChevronLeft size={14} /></button>
      <span className="text-[12px] font-semibold">动态文字拓展</span>
    </div>
    <p className="editor-hint">选择排版与运动模板，编辑后加入时间线。背景始终透明。</p>
    <TextPresetEditor extension />
  </div>
}
