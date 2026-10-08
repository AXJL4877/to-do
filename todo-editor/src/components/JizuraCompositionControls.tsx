import type { DynamicText } from '../types'
import { JIZURA_CATALOG, JIZURA_GROUP_NAMES, type JizuraGroup } from '../lib/jizura/catalog'
import { NumInput } from './NumInput'
type Composition = NonNullable<DynamicText['composition']>
export function JizuraCompositionControls({ value, onChange }: { value: Composition; onChange: (p: Composition) => void }) {
  const patch = (p: Partial<Composition>) => onChange({ ...value, ...p })
  return <details data-testid="jizura-composition-controls" open>
    <summary>完整编排 · 27 套风格 / 860 个效果部件</summary>
    <label className="editor-inline">风格<select className="input flex-1 min-w-0" aria-label="整体风格" value={value.style} onChange={e => patch({style:e.target.value})}>
      {JIZURA_CATALOG.styles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label className="editor-inline">情绪<select className="input flex-1 min-w-0" aria-label="编排情绪" value={value.mood} onChange={e => patch({mood:e.target.value})}>
      {Object.entries({graphic:'图形',chaos:'混沌',glitch:'故障',calm:'平静',pop:'活泼',editorial:'杂志',emotional:'抒情',horror:'惊悚'}).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label className="editor-inline">背景<select className="input flex-1 min-w-0" aria-label="画面背景" value={value.background} onChange={e => patch({background:e.target.value as Composition['background']})}><option value="style">风格背景</option><option value="transparent">透明叠加</option></select></label>
    <label><input type="checkbox" checked={value.unify} onChange={e => patch({unify:e.target.checked})} />段内风格统一</label>
    <details><summary>指定效果部件（留空自动搭配）</summary>
    {(Object.keys(JIZURA_CATALOG.groups) as JizuraGroup[]).map(g => <label className="editor-inline" key={g}>{JIZURA_GROUP_NAMES[g]}<select className="input flex-1 min-w-0" aria-label={JIZURA_GROUP_NAMES[g]} value={value.parts[g] || 'auto'} onChange={e => {
      const parts = {...value.parts}; if(e.target.value === 'auto') delete parts[g]; else parts[g] = e.target.value; patch({parts})
    }}><option value="auto">自动搭配</option>
      {['decor','treat','bg','cam','fx','trans'].includes(g) && !JIZURA_CATALOG.groups[g].some(x => x.id === 'none') && <option value="none">关闭</option>}
      {JIZURA_CATALOG.groups[g].map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>)}
    </details>
    {(Object.entries({decor:'装饰密度',chroma:'色差强度',glitch:'故障强度',texture:'纹理强度',bgSwitch:'背景变化'}) as [keyof Composition['fx'],string][]).map(([key,label]) => <NumInput key={key} label={label} value={value.fx[key]} min={0} max={1} step={.05} defaultValue={.5} onChange={v => patch({fx:{...value.fx,[key]:v}})} />)}
  </details>
}
