import { useState } from 'react'
import { ChevronDown, ChevronRight, SlidersHorizontal, X } from 'lucide-react'
import { useApp } from '../store'
import { resolveClipTransform, sampleKeyframes } from '../lib/keyframeEval'
import { NumInput } from './NumInput'
import { PropSection } from './PropUI'

export function Inspector({ onClose }: { onClose: () => void }) {
  const clip = useApp(s => s.sequences.find(q => q.id === s.activeSeqId)?.clips.find(c => s.selectedClipIds.includes(c.id)))
  const count = useApp(s => s.selectedClipIds.length)
  const updateTransform = useApp(s => s.updateSelectedTransform)
  const updateText = useApp(s => s.updateSelectedText)
  const updateColor = useApp(s => s.updateSelectedColor)
  const updateAudio = useApp(s => s.updateSelectedAudio)
  const keyed = useApp(s => s.autoKeyframe)
  const playhead = useApp(s => keyed && clip ? s.playhead : 0)
  const [advanced, setAdvanced] = useState(false)
  const tf = clip && (keyed ? resolveClipTransform(clip, playhead) : clip.transform)
  function transform(prop: 'x' | 'y' | 'scale' | 'rotation' | 'opacity', value: number) {
    if (keyed) useApp.getState().setDynamicAtPlayhead(prop, value)
    else updateTransform(prop === 'scale' ? { scaleX: value, scaleY: value } : { [prop]: value })
  }
  return <aside className="inspector-panel panel" data-testid="inspector-panel">
    <header className="inspector-header"><SlidersHorizontal size={14} /><strong>属性</strong><span>{count > 1 ? `已选 ${count} 项` : '快速编辑'}</span><button className="icon-btn" aria-label="收起属性栏" onClick={onClose}><X size={14} /></button></header>
    {!clip || !tf ? <div className="inspector-empty"><SlidersHorizontal size={28} /><h3>选中片段，直接编辑</h3><p>点击时间线或编辑画面中的内容，常用属性会显示在这里。</p></div> : <div className="inspector-body">
      <div className="inspector-selection"><strong title={clip.name}>{clip.name}</strong><button className="btn btn-ghost" onClick={() => { if (useApp.getState().playing) useApp.getState().togglePlay(); useApp.getState().setPlayhead(clip.start + Math.min(clip.duration / 2, 1)) }} title="跳到片段内查看效果">定位预览</button></div>
      <label className="editor-inline"><input type="checkbox" checked={keyed} onChange={() => useApp.getState().toggleAutoKeyframe()} />在播放头处记录关键帧</label>
      <PropSection title="画面变换">
        {!keyed && Object.values(clip.keyframes).some(v => v?.length) && <p className="editor-hint">正在编辑基础值；已有关键帧优先。勾选上方选项可修改当前帧。</p>}
        <NumInput label="水平位置" value={tf.x} min={-2} max={2} step={0.01} defaultValue={0} testId="inspector-x" onChange={v => transform('x', v)} />
        <NumInput label="垂直位置" value={tf.y} min={-2} max={2} step={0.01} defaultValue={0} onChange={v => transform('y', v)} />
        <NumInput label="缩放" value={Math.round(tf.scaleX * 100)} min={1} max={400} unit="%" defaultValue={100} onChange={v => transform('scale', v / 100)} />
        <NumInput label="旋转" value={tf.rotation} min={-180} max={180} unit="°" defaultValue={0} onChange={v => transform('rotation', v)} />
        <NumInput label="不透明度" value={Math.round(tf.opacity * 100)} min={0} max={100} unit="%" defaultValue={100} onChange={v => transform('opacity', v / 100)} />
      </PropSection>
      {clip.text && <PropSection title="文字">
        <textarea aria-label="属性栏文字内容" className="input" rows={3} value={clip.text.content} onChange={e => updateText({ content: e.target.value })} />
        <NumInput label="字号" value={keyed ? sampleKeyframes(clip.keyframes.fontSize, Math.max(0, playhead - clip.start), clip.text.fontSize) : clip.text.fontSize} min={12} max={300} defaultValue={48} onChange={fontSize => keyed ? useApp.getState().setDynamicAtPlayhead('fontSize', fontSize) : updateText({ fontSize })} />
        <div className="editor-actions">{(['left', 'center', 'right'] as const).map((align, i) => <button key={align} type="button" className={`btn ${clip.text!.align === align ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateText({ align })}>{['左对齐', '居中', '右对齐'][i]}</button>)}</div>
        <button type="button" className="btn btn-ghost" onClick={() => useApp.getState().setLibraryTab(clip.text?.fancy?.dynamic ? 'dynamic-text' : 'text')}>{clip.text.fancy?.dynamic ? '编辑动态文字片段 →' : '编辑粉笔花字 →'}</button>
      </PropSection>}
      <button type="button" className="inspector-more" onClick={() => setAdvanced(v => !v)}>{advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}调色与音频</button>
      {advanced && <><PropSection title="调色">
        <NumInput label="曝光" value={clip.color.exposure} min={-2} max={2} step={0.05} defaultValue={0} onChange={exposure => updateColor({ exposure })} />
        <NumInput label="对比度" value={clip.color.contrast} min={-1} max={1} step={0.01} defaultValue={0} onChange={contrast => updateColor({ contrast })} />
        <NumInput label="饱和度" value={clip.color.saturation} min={-1} max={1} step={0.01} defaultValue={0} onChange={saturation => updateColor({ saturation })} />
      </PropSection><PropSection title="音频">
        <NumInput label="增益" value={clip.audio.gainDb} min={-60} max={18} unit="dB" defaultValue={0} testId="audio-gain" onChange={gainDb => updateAudio({ gainDb })} />
        <button type="button" className="btn btn-ghost" data-testid="btn-loudness-inspector" onClick={() => { void useApp.getState().levelAudioLoudness() }}>一键调音</button>
      </PropSection></>}
      <p className="editor-hint">拖动属性名称快速调整 · Shift 精调<br />双击数值恢复默认 · Ctrl+Z 撤销</p>
    </div>}
  </aside>
}
