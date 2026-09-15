import { desktop } from './desktop'

/** 桌面端 AI 服务根地址；纯浏览器为空（相对路径走 Vite） */
export function getAiBaseUrl(): string {
  const d = desktop()
  if (!d) return ''
  return (d.getAiBaseUrl?.() ?? d.aiBaseUrl?.() ?? '') || ''
}

export function aiUrl(path: string): string {
  const base = getAiBaseUrl().replace(/\/$/, '')
  if (!base) return path
  if (/^https?:\/\//i.test(path)) return path
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function aiFetch(input: string, init?: RequestInit) {
  return fetch(aiUrl(input), init)
}
