/** 内置浏览器外壳专用 preload */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('todoBrowser', {
  detectBoxes: () => ipcRenderer.invoke('desktop:browser-detect-boxes'),
  captureAndImport: (payload) => ipcRenderer.invoke('desktop:browser-capture-import', payload || {}),
  onToggleShot: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('todo-browser:toggle-shot', handler)
    return () => ipcRenderer.removeListener('todo-browser:toggle-shot', handler)
  },
})
