/** Electron 桌面桥接；浏览器环境返回 null */
export type DesktopApi = {
  isDesktop: true
  platform: string
  getPaths: () => Promise<{ root: string; projects: string; cache: string; exports: string }>
  /** 独立 AI HTTP 服务根地址，如 http://127.0.0.1:PORT */
  getAiBaseUrl: () => string
  aiBaseUrl: () => string
  saveProjectFile: (defaultName: string, json: unknown) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  openProjectFile: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; json?: unknown }>
  pickMediaFiles: () => Promise<{
    ok: boolean
    canceled?: boolean
    files: { name: string; path: string; url: string; kind: 'image' | 'video' | 'audio' }[]
  }>
  probeMedia: (filePath: string, timeoutMs?: number) => Promise<{
    ok: boolean
    backend: 'todo-cpp-ffmpeg' | 'native-libavformat' | 'ffprobe-transition'
    duration?: number
    width?: number
    height?: number
    frameRate?: number
    format?: string
    hasVideo?: boolean
    hasAudio?: boolean
    error?: { code: string; message: string }
  }>
  /** C++ 引擎精确取帧 → PNG dataUrl（桌面路径媒体） */
  decodeMediaFrame?: (filePath: string, timeSec: number, timeoutMs?: number) => Promise<{
    ok: boolean
    dataUrl?: string
    width?: number
    height?: number
    error?: string
  }>
  /** 测试用：顺序解码 smoke（无音频时钟） */
  playSmoke?: (filePath: string, seconds?: number, timeoutMs?: number) => Promise<{
    ok: boolean
    frames?: number
    fps?: number
    duration?: number
    engine?: string
    error?: string
  }>
  /** C++ play-session：连续解码；视频跟 PCM/waveOut AUDIO_CLOCK */
  nativePlayOpen?: (filePath: string, timeoutMs?: number) => Promise<{ ok: boolean; error?: string }>
  nativePlaySeek?: (timeSec: number, timeoutMs?: number) => Promise<{ ok: boolean; error?: string }>
  nativePlayRead?: (timeoutMs?: number) => Promise<{
    ok: boolean
    w?: number
    h?: number
    pts?: number
    dataUrl?: string
    eof?: boolean
    error?: string
  }>
  /** PCM/waveOut 媒体时钟（秒）；无音轨则 sec=null */
  nativePlayAudioClock?: (timeoutMs?: number) => Promise<{ ok: boolean; sec?: number | null; error?: string }>
  nativePlayClose?: () => Promise<{ ok: boolean }>
  /** EditGraph 时间点合成（与 export 同层序 letterbox + D3D11） */
  composeFrame?: (graph: unknown, timeSec: number, timeoutMs?: number) => Promise<{
    ok: boolean
    backend?: string
    width?: number
    height?: number
    layers?: number
    time?: number
    dataUrl?: string
    error?: string
  }>
  /** ffmpeg 低分辨率代理 → userData/cache/proxies */
  makeProxy?: (filePath: string, height?: 480 | 720) => Promise<{
    ok: boolean
    proxyPath?: string
    cached?: boolean
    height?: number
    error?: string
  }>
  exportFramePng: (defaultName: string, dataUrl: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  /** 离线序列导出（主进程 ffmpeg；将来 native todo-media-export） */
  exportSequence?: (payload: {
    jobId: string
    defaultName?: string
    audioOnly?: boolean
    /** 跳过另存为对话框，写到 userData/exports */
    skipDialog?: boolean
    /** 显式输出路径（测试/自动化） */
    outPath?: string
    sequence: {
      clips: Array<{
        mediaPath?: string
        start: number
        duration: number
        inPoint: number
        trackId: string
        enabled?: boolean
        kind?: string
      }>
      tracks: Array<{ id: string; kind: string; muted?: boolean }>
      settings: { width: number; height: number; fps: number }
      workIn?: number
      workOut?: number
      rangeOnly?: boolean
      audioOnly?: boolean
    }
  }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string; backend?: string }>
  onExportProgress?: (cb: (msg: {
    jobId: string
    progress: number
    status: 'running' | 'done' | 'error'
    error?: string
    path?: string
  }) => void) => () => void
  revealPath: (filePath: string) => Promise<{ ok: boolean }>
  /** Electron：从 File 取本机路径 */
  getPathForFile?: (file: File) => string
  openTimelineWindow?: () => Promise<{ ok: boolean; reused?: boolean }>
  closeTimelineWindow?: () => Promise<{ ok: boolean; alreadyClosed?: boolean }>
  resizeTimelineWindow?: (size: { width?: number; height: number }) => Promise<{ ok: boolean }>
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
  /** 本机路径媒体 → 音量峰值（ffmpeg PCM，整段） */
  waveformPeaks?: (filePath: string, bins?: number) => Promise<{
    ok: boolean
    peaks?: number[]
    duration?: number
    error?: string
  }>
  /** blob / 无 path：把文件字节交给主进程抽峰值 */
  waveformPeaksBuffer?: (
    data: ArrayBuffer,
    opts?: { bins?: number; ext?: string },
  ) => Promise<{
    ok: boolean
    peaks?: number[]
    duration?: number
    error?: string
  }>
  /** B2 native program preview */
  previewInit?: (opts?: { fps?: number; budgetMB?: number; adapterLuid?: string | null }) => Promise<{ ok: boolean; error?: string; pid?: number }>
  previewStop?: () => Promise<{ ok: boolean }>
  previewRect?: (css: { x: number; y: number; w: number; h: number }) => Promise<{ ok: boolean }>
  previewVisible?: (on: boolean) => Promise<{ ok: boolean }>
  previewSuspend?: (reason?: 'menu' | 'dialog' | 'drag') => Promise<{ ok: boolean }>
  previewResume?: () => Promise<{ ok: boolean }>
  previewTimeline?: (json: string | unknown) => Promise<{ ok: boolean }>
  previewSeek?: (frame: number) => Promise<{ ok: boolean }>
  previewPlay?: () => Promise<{ ok: boolean }>
  previewPause?: () => Promise<{ ok: boolean }>
  previewStats?: () => Promise<{ ok: boolean }>
  onPreviewEvent?: (cb: (ev: Record<string, unknown>) => void) => () => void
  onPreviewCrashed?: (cb: (msg: { code?: number | null; signal?: string | null }) => void) => () => void
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
