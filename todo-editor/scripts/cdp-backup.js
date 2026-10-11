// 清理前的完整备份（片段 / 轨道 / 媒体 / 成片登记），可直接用于回滚
const st = window.__TODO_STORE__.getState()
return JSON.stringify({
  at: new Date().toISOString(),
  projectPath: st.projectPath,
  activeSeqId: st.activeSeqId,
  sequences: st.sequences,
  media: st.media,
  aiProductions: st.settings?.aiProductions || {},
}, null, 2)
