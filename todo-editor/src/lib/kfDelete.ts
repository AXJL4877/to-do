/** 关键帧键盘上下文（Delete / F3）：渲染期同步写入，避免 effect 时序导致 App 误删片段 */

type Ctx = {
  picked: string[]
  selectedId: string | null
  remove: ((ids: string[]) => void) | null
  /** 当前轨全部关键帧 id；F3 无选中时作用于整轨 */
  allIds?: string[]
  autoBezier?: ((ids: string[]) => void) | null
  selectAll?: (() => void) | null
}

let ctx: Ctx = { picked: [], selectedId: null, remove: null }
let graphHovered = false

export function setKfGraphHovered(v: boolean) {
  graphHovered = v
}

/** 指针在关键帧图上时 Ctrl+A 全选关键帧（否则交给片段全选） */
export function trySelectAllKeyframes(): boolean {
  if (!graphHovered || !ctx.selectAll) return false
  ctx.selectAll()
  return true
}

export function setKfDeleteContext(next: Ctx) {
  ctx = next
}

export function clearKfDeleteContext() {
  ctx = { picked: [], selectedId: null, remove: null }
}

/** @returns true 已删除关键帧（调用方勿再删片段） */
export function tryDeletePickedKeyframes(): boolean {
  const { picked, selectedId, remove } = ctx
  if (!remove) return false
  const ids = picked.length ? picked : (selectedId ? [selectedId] : [])
  if (!ids.length) return false
  remove(ids)
  ctx = { ...ctx, picked: [], selectedId: null }
  return true
}

/** F3：图上框选/多选了关键帧时只处理这些；返回 false 由调用方对所有属性一键贝塞尔 */
export function tryAutoBezierPickedKeyframes(): boolean {
  const { picked, autoBezier } = ctx
  if (!autoBezier || picked.length < 2) return false
  autoBezier(picked)
  return true
}
