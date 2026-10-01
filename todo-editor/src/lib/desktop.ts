/** Electron 桌面桥接；浏览器环境返回 null */
export type DesktopApi = {
  isDesktop: true
  platform: string
  /** 得意黑本机字体 file:// URL（preload 注入） */
  smileyFontUrl?: () => string
  /** 本机物理内存（MB），用于定预览 RAM 缓存预算 */
  systemMemoryMb?: () => number
  getPaths: () => Promise<{
    root: string; projects: string; cache: string; exports: string
    /** 新建项目的默认保存位置（文档/TO DO 项目） */
    projectsRoot?: string
    /** 当前项目文件夹；没开项目时为 null */
    projectDir?: string | null
  }>
  /** 独立 AI HTTP 服务根地址，如 http://127.0.0.1:PORT */
  getAiBaseUrl: () => string
  aiBaseUrl: () => string
  /** 传 filePath 直接覆盖写入；不传弹另存为 */
  saveProjectFile: (defaultName: string, json: unknown, filePath?: string | null) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  /** 传 filePath 直接读取；不传弹打开对话框 */
  openProjectFile: (filePath?: string) => Promise<{
    ok: boolean
    canceled?: boolean
    notFound?: boolean
    path?: string
    json?: unknown
    error?: string
    /** 绝对路径失效、按 relPath 找回的素材数 */
    relinked?: number
    /** 两种路径都找不到的素材数 */
    missing?: number
  }>
  recentProjects?: () => Promise<{ path: string; exists: boolean }[]>
  removeRecentProject?: (filePath: string) => Promise<string[]>
  /** 扫描本机项目目录，合并进最近列表 */
  discoverProjects?: () => Promise<{
    ok: boolean
    projects?: { path: string; exists: boolean }[]
    roots?: string[]
    error?: string
  }>
  /** 在 parentDir 下建 <name>/ 项目文件夹（含 ai-generated / exports / cache），返回工程文件路径 */
  createProjectFolder?: (parentDir: string, name: string) => Promise<{ ok: boolean; dir?: string; path?: string; error?: string }>
  pickDirectory?: (opts?: { title?: string; defaultPath?: string }) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  /** 告知主进程当前工程文件（导出 / 代理 / AI 收集按它的文件夹）；null = 没开项目 */
  setProject?: (filePath: string | null) => Promise<{ ok: boolean; dir: string | null }>
  /** AI 服务产物复制进当前项目的 ai-generated/ */
  collectAiFile?: (name: string) => Promise<{ ok: boolean; path?: string; url?: string; error?: string }>
  revealProject?: () => Promise<{ ok: boolean }>
  /** 主窗关闭前：渲染层落盘后须调用 closeReady */
  onRequestClose?: (cb: () => void) => () => void
  closeReady?: () => void
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
    stage?: string
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
  /** 打开内置浏览器；url 可选 */
  openBrowserWindow?: (url?: string) => Promise<{ ok: boolean; reused?: boolean }>
  closeBrowserWindow?: () => Promise<{ ok: boolean; alreadyClosed?: boolean }>
  /** 浏览器截图已落盘，主窗应 importMedia */
  onBrowserShot?: (cb: (shot: {
    name: string
    path: string
    url: string
    width: number
    height: number
    title?: string
    pageUrl?: string
  }) => void) => () => void
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
  /** 量一段媒体的综合响度（LUFS），给一键调音用 */
  analyzeLoudness?: (
    filePath: string,
    opts?: { inPoint?: number; duration?: number },
  ) => Promise<{ ok: boolean; lufs?: number; error?: string }>
  /** 把 PNG dataURL 落到项目素材目录，返回本机 path/url */
  saveMediaAsset?: (name: string, dataUrl: string) => Promise<{
    ok: boolean
    path?: string
    url?: string
    name?: string
    error?: string
  }>
  pickImageFile?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; url?: string }>
  pickVideoFile?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; url?: string }>
  douyinStatus?: (root?: string) => Promise<{
    ok: boolean
    root?: string
    inbox?: string
    publishOk?: boolean
    selectedSlug?: string
    draft?: Record<string, unknown>
    assetCount?: number
    desk?: { ok: boolean; error?: string }
    archive?: { ok: boolean; error?: string }
    deskUrl?: string
    error?: string
  }>
  douyinOpenDesk?: (root?: string) => Promise<{ ok: boolean; deskUrl?: string; inbox?: string; error?: string }>
  douyinRevealInbox?: (root?: string) => Promise<{ ok: boolean; inbox?: string }>
  douyinListAssets?: (root?: string) => Promise<{
    ok: boolean
    assets?: Array<{
      id: string
      slug: string
      title: string
      caption?: string
      tags?: string[]
      kind?: string
      video_path?: string
      cover_path?: string
      cover_url?: string
      folder?: string
      updated_at?: number
    }>
    drop?: string
    builtin?: boolean
    error?: string
  }>
  douyinUseAsset?: (slug: string, root?: string) => Promise<{
    ok: boolean
    slug?: string
    draft?: Record<string, unknown>
    asset?: Record<string, unknown>
    error?: string
  }>
  douyinStageAsset?: (payload: {
    videoPath?: string
    coverPath?: string
    coverLandscapePath?: string
    slug?: string
    meta?: {
      title?: string
      caption?: string
      tags?: string[]
      board?: string
      trade_date?: string
    }
    root?: string
    openDesk?: boolean
    useAsset?: boolean
  }) => Promise<{
    ok: boolean
    slug?: string
    dir?: string
    wrote?: string[]
    meta?: unknown
    deskUrl?: string
    note?: string
    error?: string
  }>
  douyinAttachCover?: (payload: { slug: string; coverPath: string; root?: string }) => Promise<{
    ok: boolean
    path?: string
    error?: string
  }>
  douyinSaveMeta?: (payload: {
    slug: string
    meta?: { title?: string; caption?: string; tags?: string[]; board?: string; trade_date?: string }
    root?: string
  }) => Promise<{ ok: boolean; slug?: string; meta?: unknown; error?: string }>
  douyinPublish?: (payload: {
    action: 'phones' | 'status' | 'stage' | 'fill' | 'push' | 'restart-adb'
    serial?: string
    root?: string
    restartAdb?: boolean
  }) => Promise<{ ok: boolean; error?: string; phones?: Array<{ serial?: string; state?: string; model?: string; product?: string; douyin?: boolean }>; [k: string]: unknown }>
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
