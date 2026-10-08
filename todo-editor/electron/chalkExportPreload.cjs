'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/** 导出窗 → 主进程：每帧 RGBA，走 invoke 做背压，避免 PNG/base64 往返 */
contextBridge.exposeInMainWorld('todoChalkExport', {
  pushFrame: (sessionId, buffer) => ipcRenderer.invoke('chalk-export-frame', sessionId, buffer),
})
