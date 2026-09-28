/**
 * B2：HTML 菜单/对话框遮挡时 suspend 原生预览窗（引用计数）。
 */
import { useEffect, useRef } from 'react'
import { desktop } from '../lib/desktop'

let depth = 0

export function previewSuspend(reason: 'menu' | 'dialog' | 'drag' = 'menu') {
  const api = desktop()
  if (!api?.previewSuspend) return
  depth += 1
  if (depth === 1) void api.previewSuspend(reason)
}

export function previewResume() {
  const api = desktop()
  if (!api?.previewResume) return
  depth = Math.max(0, depth - 1)
  if (depth === 0) void api.previewResume()
}

/** 组件挂载期间保持 suspend；卸载 resume */
export function usePreviewSuspend(active: boolean, reason: 'menu' | 'dialog' | 'drag' = 'menu') {
  const reasonRef = useRef(reason)
  reasonRef.current = reason
  useEffect(() => {
    if (!active) return
    previewSuspend(reasonRef.current)
    return () => previewResume()
  }, [active])
}
