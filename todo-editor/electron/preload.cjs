const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 最小桌面 API：文件读写与路径，不暴露 Node */
contextBridge.exposeInMainWorld('todoDesktop', {
  isDesktop: true,
  platform: process.platform,
  getPaths: () => ipcRenderer.invoke('desktop:get-paths'),
  saveProjectFile: (defaultName, json) => ipcRenderer.invoke('desktop:save-project', { defaultName, json }),
  openProjectFile: () => ipcRenderer.invoke('desktop:open-project'),
  pickMediaFiles: () => ipcRenderer.invoke('desktop:pick-media'),
  exportFramePng: (defaultName, dataUrl) => ipcRenderer.invoke('desktop:export-frame', { defaultName, dataUrl }),
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
})
