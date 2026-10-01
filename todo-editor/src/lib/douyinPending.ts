/** 从导出队列「投放到抖音」时暂存成片路径，发布台打开后消费一次 */
const KEY = 'todo-douyin-pending-video'

export function setDouyinPendingVideo(filePath: string | null | undefined) {
  try {
    if (filePath) sessionStorage.setItem(KEY, filePath)
    else sessionStorage.removeItem(KEY)
  } catch { /* */ }
}

export function takeDouyinPendingVideo(): string | null {
  try {
    const v = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return v || null
  } catch {
    return null
  }
}

export function peekDouyinPendingVideo(): string | null {
  try {
    return sessionStorage.getItem(KEY) || null
  } catch {
    return null
  }
}
