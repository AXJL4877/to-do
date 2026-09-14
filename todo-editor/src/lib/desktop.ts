/** Electron 桌面桥接；浏览器环境返回 null */
export type DesktopApi = {
  isDesktop: true
  platform: string
  getPaths: () => Promise<{ root: string; projects: string; cache: string; exports: string }>
  saveProjectFile: (defaultName: string, json: unknown) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  openProjectFile: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; json?: unknown }>
  pickMediaFiles: () => Promise<{
    ok: boolean
    canceled?: boolean
    files: { name: string; path: string; url: string; kind: 'image' | 'video' | 'audio' }[]
  }>
  exportFramePng: (defaultName: string, dataUrl: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  revealPath: (filePath: string) => Promise<{ ok: boolean }>
  /** Electron：从 File 取本机路径 */
  getPathForFile?: (file: File) => string
  openTimelineWindow?: () => Promise<{ ok: boolean; reused?: boolean }>
  closeTimelineWindow?: () => Promise<{ ok: boolean; alreadyClosed?: boolean }>
  timelineWindowAlive?: () => Promise<{ ok: boolean }>
  onTimelineWindowOpened?: (cb: () => void) => () => void
  onTimelineWindowClosed?: (cb: () => void) => () => void
  openAiWindow?: () => Promise<{ ok: boolean; reused?: boolean }>
  closeAiWindow?: () => Promise<{ ok: boolean; alreadyClosed?: boolean }>
  onAiWindowClosed?: (cb: () => void) => () => void
  postStoreSync?: (msg: unknown) => void
  onStoreSync?: (cb: (msg: unknown) => void) => () => void
  /** 跨窗拖素材：源窗 dragend 时问主进程光标是否在时间轴窗上 */
  endMediaDrag?: (mediaId: string) => void
  onMediaDrop?: (cb: (p: { mediaId: string; x: number; y: number }) => void) => () => void
}

declare global {
  interface Window {
    todoDesktop?: DesktopApi
  }
}

export function desktop(): DesktopApi | null {
  return typeof window !== 'undefined' && window.todoDesktop?.isDesktop ? window.todoDesktop : null
}

export function isDesktopApp() {
  return !!desktop()
}
