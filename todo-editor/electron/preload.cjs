const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 最小桌面 API：文件读写与路径，不暴露 Node */
contextBridge.exposeInMainWorld('todoDesktop', {
  isDesktop: true,
  platform: process.platform,
  getPaths: () => ipcRenderer.invoke('desktop:get-paths'),
  getAiBaseUrl: () => ipcRenderer.sendSync('desktop:ai-base-url') || '',
  aiBaseUrl: () => ipcRenderer.sendSync('desktop:ai-base-url') || '',
  saveProjectFile: (defaultName, json) => ipcRenderer.invoke('desktop:save-project', { defaultName, json }),
  openProjectFile: () => ipcRenderer.invoke('desktop:open-project'),
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
})
