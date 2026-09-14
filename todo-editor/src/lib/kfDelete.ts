/** 关键帧 Delete 上下文：渲染期同步写入，避免 effect 时序导致 App 误删片段 */

type Ctx = {
  picked: string[]
  selectedId: string | null
  remove: ((ids: string[]) => void) | null
}

let ctx: Ctx = { picked: [], selectedId: null, remove: null }

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
