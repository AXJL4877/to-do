const { contextBridge, ipcRenderer, webUtils } = require('electron')

// sandbox:true 下 preload 不能 require('fs')；得意黑路径由主进程解析
const smileyFontUrl = (() => {
  try { return ipcRenderer.sendSync('desktop:smiley-font-url') || '' } catch { return '' }
})()

/** 最小桌面 API：文件读写与路径，不暴露 Node */
contextBridge.exposeInMainWorld('todoDesktop', {
  isDesktop: true,
  platform: process.platform,
  smileyFontUrl: () => smileyFontUrl,
  systemMemoryMb: () => {
    try { return Math.round(process.getSystemMemoryInfo().total / 1024) }
    catch { return 0 }
  },
  getPaths: () => ipcRenderer.invoke('desktop:get-paths'),
  getAiBaseUrl: () => ipcRenderer.sendSync('desktop:ai-base-url') || '',
  aiBaseUrl: () => ipcRenderer.sendSync('desktop:ai-base-url') || '',
  saveProjectFile: (defaultName, json, filePath) => ipcRenderer.invoke('desktop:save-project', { defaultName, json, filePath }),
  openProjectFile: (filePath) => ipcRenderer.invoke('desktop:open-project', { filePath }),
  recentProjects: () => ipcRenderer.invoke('desktop:recent-projects'),
  removeRecentProject: (filePath) => ipcRenderer.invoke('desktop:remove-recent-project', filePath),
  discoverProjects: () => ipcRenderer.invoke('desktop:discover-projects'),
  createProjectFolder: (parentDir, name) => ipcRenderer.invoke('desktop:create-project', { parentDir, name }),
  pickDirectory: (opts) => ipcRenderer.invoke('desktop:pick-directory', opts || {}),
  setProject: (filePath) => ipcRenderer.invoke('desktop:set-project', filePath ?? null),
  collectAiFile: (name) => ipcRenderer.invoke('desktop:collect-ai-file', { name }),
  revealProject: () => ipcRenderer.invoke('desktop:reveal-project'),
  onRequestClose: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('desktop:request-close', handler)
    return () => ipcRenderer.removeListener('desktop:request-close', handler)
  },
  closeReady: () => ipcRenderer.send('desktop:close-ready'),
  pickMediaFiles: () => ipcRenderer.invoke('desktop:pick-media'),
  probeMedia: (filePath, timeoutMs) => ipcRenderer.invoke('desktop:probe-media', { filePath, timeoutMs }),
  decodeMediaFrame: (filePath, timeSec, timeoutMs) => ipcRenderer.invoke('desktop:decode-media-frame', { filePath, timeSec, timeoutMs }),
  /** 测试用：连续播放 smoke */
  playSmoke: (filePath, seconds, timeoutMs) => ipcRenderer.invoke('desktop:play-smoke', { filePath, seconds, timeoutMs }),
  nativePlayOpen: (filePath, timeoutMs) => ipcRenderer.invoke('desktop:native-play-open', { filePath, timeoutMs }),
  nativePlaySeek: (timeSec, timeoutMs) => ipcRenderer.invoke('desktop:native-play-seek', { timeSec, timeoutMs }),
  nativePlayRead: (timeoutMs) => ipcRenderer.invoke('desktop:native-play-read', { timeoutMs }),
  nativePlayAudioClock: (timeoutMs) => ipcRenderer.invoke('desktop:native-play-audio-clock', { timeoutMs }),
  nativePlayClose: () => ipcRenderer.invoke('desktop:native-play-close'),
  composeFrame: (graph, timeSec, timeoutMs) => ipcRenderer.invoke('desktop:compose-frame', { graph, timeSec, timeoutMs }),
  makeProxy: (filePath, height) => ipcRenderer.invoke('desktop:make-proxy', { filePath, height }),
  exportFramePng: (defaultName, dataUrl) => ipcRenderer.invoke('desktop:export-frame', { defaultName, dataUrl }),
  exportSequence: (payload) => ipcRenderer.invoke('desktop:export-sequence', payload),
  onExportProgress: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('desktop:export-progress', handler)
    return () => ipcRenderer.removeListener('desktop:export-progress', handler)
  },
  revealPath: (filePath) => ipcRenderer.invoke('desktop:reveal', filePath),
  /** 拖入/选择的 File → 本机路径（sandbox 下勿依赖 file.path） */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || '' }
    catch { return '' }
  },
  openTimelineWindow: () => ipcRenderer.invoke('desktop:open-timeline-window'),
  closeTimelineWindow: () => ipcRenderer.invoke('desktop:close-timeline-window'),
  resizeTimelineWindow: (size) => ipcRenderer.invoke('desktop:resize-timeline-window', size),
  timelineWindowAlive: () => ipcRenderer.invoke('desktop:timeline-window-alive'),
  onTimelineWindowOpened: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('desktop:timeline-window-opened', handler)
    return () => ipcRenderer.removeListener('desktop:timeline-window-opened', handler)
  },
  onTimelineWindowClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('desktop:timeline-window-closed', handler)
    return () => ipcRenderer.removeListener('desktop:timeline-window-closed', handler)
  },
  openAiWindow: () => ipcRenderer.invoke('desktop:open-ai-window'),
  closeAiWindow: () => ipcRenderer.invoke('desktop:close-ai-window'),
  onAiWindowClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('desktop:ai-window-closed', handler)
    return () => ipcRenderer.removeListener('desktop:ai-window-closed', handler)
  },
  openBrowserWindow: (url) => ipcRenderer.invoke('desktop:open-browser-window', { url }),
  closeBrowserWindow: () => ipcRenderer.invoke('desktop:close-browser-window'),
  onBrowserShot: (cb) => {
    const handler = (_e, shot) => cb(shot)
    ipcRenderer.on('desktop:browser-shot', handler)
    return () => ipcRenderer.removeListener('desktop:browser-shot', handler)
  },
  postStoreSync: (msg) => ipcRenderer.send('desktop:store-sync', msg),
  onStoreSync: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('desktop:store-sync', handler)
    return () => ipcRenderer.removeListener('desktop:store-sync', handler)
  },
  endMediaDrag: (mediaId) => ipcRenderer.send('desktop:media-drag-end', mediaId),
  onMediaDrop: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('desktop:media-drop', handler)
    return () => ipcRenderer.removeListener('desktop:media-drop', handler)
  },
  waveformPeaks: (filePath, bins) => ipcRenderer.invoke('desktop:waveform-peaks', { filePath, bins }),
  waveformPeaksBuffer: (data, opts) => ipcRenderer.invoke('desktop:waveform-peaks-buffer', {
    data,
    bins: opts?.bins,
    ext: opts?.ext,
  }),
  analyzeLoudness: (filePath, opts) => ipcRenderer.invoke('desktop:analyze-loudness', {
    filePath,
    inPoint: opts?.inPoint,
    duration: opts?.duration,
  }),
  saveMediaAsset: (name, dataUrl) => ipcRenderer.invoke('desktop:save-media-asset', { name, dataUrl }),
  pickImageFile: () => ipcRenderer.invoke('desktop:pick-image'),
  pickVideoFile: () => ipcRenderer.invoke('desktop:pick-video'),
  douyinStatus: (root) => ipcRenderer.invoke('desktop:douyin-status', { root }),
  douyinOpenDesk: (root) => ipcRenderer.invoke('desktop:douyin-open-desk', { root }),
  douyinRevealInbox: (root) => ipcRenderer.invoke('desktop:douyin-reveal-inbox', { root }),
  douyinListAssets: (root) => ipcRenderer.invoke('desktop:douyin-list-assets', { root }),
  douyinUseAsset: (slug, root) => ipcRenderer.invoke('desktop:douyin-use-asset', { slug, root }),
  douyinStageAsset: (payload) => ipcRenderer.invoke('desktop:douyin-stage-asset', payload || {}),
  douyinAttachCover: (payload) => ipcRenderer.invoke('desktop:douyin-attach-cover', payload || {}),
  douyinSaveMeta: (payload) => ipcRenderer.invoke('desktop:douyin-save-meta', payload || {}),
  douyinPublish: (payload) => ipcRenderer.invoke('desktop:douyin-publish', payload || {}),
  /** B2 native program preview (popup overlay) */
  previewInit: (opts) => ipcRenderer.invoke('preview:init', opts),
  previewStop: () => ipcRenderer.invoke('preview:stop'),
  previewRect: (css) => ipcRenderer.invoke('preview:rect', css),
  previewVisible: (on) => ipcRenderer.invoke('preview:visible', on),
  previewSuspend: (reason) => ipcRenderer.invoke('preview:suspend', reason),
  previewResume: () => ipcRenderer.invoke('preview:resume'),
  previewTimeline: (json) => ipcRenderer.invoke('preview:timeline', json),
  previewSeek: (frame) => ipcRenderer.invoke('preview:seek', frame),
  previewPlay: () => ipcRenderer.invoke('preview:play'),
  previewPause: () => ipcRenderer.invoke('preview:pause'),
  previewStats: () => ipcRenderer.invoke('preview:stats'),
  onPreviewEvent: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('preview:event', handler)
    return () => ipcRenderer.removeListener('preview:event', handler)
  },
  onPreviewCrashed: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('preview:crashed', handler)
    return () => ipcRenderer.removeListener('preview:crashed', handler)
  },
})

if (smileyFontUrl) {
  contextBridge.exposeInMainWorld('__TODO_SMILEY_FONT_URL__', smileyFontUrl)
}