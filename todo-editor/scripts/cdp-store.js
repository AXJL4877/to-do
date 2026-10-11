// 通过 Vite 的模块 URL 拿到同一个 store 实例（dev 模式下 URL 稳定，模块单例）
const m = await import('/src/store.ts')
window.__TODO_STORE__ = m.useApp
const st = m.useApp.getState()
return JSON.stringify({
  ok: true,
  project: st.projectPath,
  active: st.activeSeqId,
  seqs: st.sequences.map((s) => ({ id: s.id, name: s.name, clips: s.clips.length, tracks: s.tracks.length })),
  media: st.media.length,
  aiProductions: Object.keys(st.settings?.aiProductions || {}),
  started: st.started,
}, null, 2)
