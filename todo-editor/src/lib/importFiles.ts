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
  hasAudio?: boolean
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

let transitionNoticeShown = false

export async function parseDesktopMedia(file: { name: string; path: string; url: string }, stillDuration = 5): Promise<ParsedMedia> {
  const api = desktop()
  if (!api) throw new Error('桌面桥接不可用')
  const r = await api.probeMedia(file.path)
  if (!r.ok) throw new Error(`${file.name}: ${r.error?.message || '媒体探测失败'} (${r.backend}/${r.error?.code || 'UNKNOWN'})`)
  if (r.backend === 'ffprobe-transition' && !transitionNoticeShown) {
    transitionNoticeShown = true
    window.alert('当前媒体探测使用 ffprobe-transition 过渡后端。C 原生引擎尚未构建；导入可继续，播放方式保持不变。')
  }
  const image = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)
  if (!image && (!r.duration || !Number.isFinite(r.duration))) throw new Error(`${file.name}: 无法确定媒体时长，暂不导入`)
  return {
    ...file,
    kind: image ? 'image' : r.hasVideo ? 'video' : 'audio',
    duration: image ? stillDuration : r.duration!,
    width: r.width,
    height: r.height,
    hasAudio: !!r.hasAudio,
  }
}

export async function parseMediaFiles(files: File[]): Promise<ParsedMedia[]> {
  const parsed: ParsedMedia[] = []
  for (const file of files) {
    const source = durableFromFile(file)
    if (desktop() && source.path && !/\.svg$/i.test(file.name)) {
      try { parsed.push(await parseDesktopMedia({ name: file.name, path: source.path, url: source.url })) }
      catch (error) { window.alert(String(error)) }
    } else {
      if (source.url.startsWith('blob:')) URL.revokeObjectURL(source.url)
      parsed.push(...await parseBrowserFiles([file]))
    }
  }
  return parsed
}

async function parseBrowserFiles(files: File[]): Promise<ParsedMedia[]> {
  return Promise.all(files.map((file) => new Promise<ParsedMedia>((resolve) => {
    const { url, path } = durableFromFile(file)
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const base = { name: file.name, url, path }
    if (file.type.startsWith('audio/') || ['mp3', 'wav', 'aac', 'm4a', 'flac'].includes(ext)) {
      const a = new Audio(url)
      a.onloadedmetadata = () => resolve({ ...base, kind: 'audio', duration: a.duration || 5, hasAudio: true })
      a.onerror = () => resolve({ ...base, kind: 'audio', duration: 5, hasAudio: true })
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
        hasAudio: true, // 浏览器难可靠探测；有声按有声入轨
      })
      v.onerror = () => resolve({ ...base, kind: 'video', duration: 5, hasAudio: true })
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
