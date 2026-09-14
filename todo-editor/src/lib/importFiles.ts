import type { MediaItem, MediaKind } from '../types'
import { desktop } from './desktop'

export type ParsedMedia = {
  name: string
  url: string
  /** 本机绝对路径（Electron）；有则重启后可恢复 */
  path?: string
  kind: MediaKind
  duration: number
  width?: number
  height?: number
}

type FileWithPath = File & { path?: string }

/** Windows/Unix 路径 → file:// URL（供 Electron 预览） */
export function pathToFileUrl(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(norm)) {
    return `file:///${encodeURI(norm).replace(/#/g, '%23')}`
  }
  if (norm.startsWith('/')) {
    return `file://${encodeURI(norm).replace(/#/g, '%23')}`
  }
  return `file:///${encodeURI(norm).replace(/#/g, '%23')}`
}

function durableFromFile(file: File): { url: string; path?: string } {
  const api = desktop()
  const fromBridge = api?.getPathForFile?.(file)?.trim()
  const p = fromBridge || (file as FileWithPath).path
  if (p) return { url: pathToFileUrl(p), path: p }
  return { url: URL.createObjectURL(file) }
}

/** 草稿恢复：blob 失效则用 path 重建；仍无 path 则标离线 */
export function reviveMediaList(media: MediaItem[]): MediaItem[] {
  return media.map((m) => {
    if (m.path && (!m.url || m.url.startsWith('blob:') || m.offline)) {
      return { ...m, url: pathToFileUrl(m.path), offline: false }
    }
    if (m.url.startsWith('blob:')) {
      return { ...m, offline: true }
    }
    return m
  })
}

export async function parseMediaFiles(files: File[]): Promise<ParsedMedia[]> {
  return Promise.all(files.map((file) => new Promise<ParsedMedia>((resolve) => {
    const { url, path } = durableFromFile(file)
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const base = { name: file.name, url, path }
    if (file.type.startsWith('audio/') || ['mp3', 'wav', 'aac', 'm4a', 'flac'].includes(ext)) {
      const a = new Audio(url)
      a.onloadedmetadata = () => resolve({ ...base, kind: 'audio', duration: a.duration || 5 })
      a.onerror = () => resolve({ ...base, kind: 'audio', duration: 5 })
    } else if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
      const img = new Image()
      img.onload = () => resolve({
        ...base,
        kind: file.name.includes('sticker') ? 'sticker' : 'image',
        duration: 5, width: img.width, height: img.height,
      })
      img.onerror = () => resolve({ ...base, kind: 'image', duration: 5 })
      img.src = url
    } else {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => resolve({
        ...base, kind: 'video',
        duration: v.duration || 5, width: v.videoWidth, height: v.videoHeight,
      })
      v.onerror = () => resolve({ ...base, kind: 'video', duration: 5 })
      v.src = url
    }
  })))
}

export function filesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = []
  if (dt.files?.length) {
    for (const f of dt.files) out.push(f)
  }
  return out
}
