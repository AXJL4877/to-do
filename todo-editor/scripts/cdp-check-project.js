// 打开工程 → 看宿主如何绑定新成片：片段总数、每个片段属于哪条成片
const leaf = [...document.querySelectorAll('*')].filter((el) => !el.children.length && el.textContent.trim() === '通货膨胀40秒')[0]
if (leaf) { leaf.click(); await new Promise((r) => setTimeout(r, 8000)) }
else {
  const st0 = window.__TODO_CMD__?.store.getState()
  const ok = await st0?.openProjectFromFile?.('D:\\Desktop\\通货膨胀40秒\\通货膨胀40秒.todo.json')
  await new Promise((r) => setTimeout(r, 8000))
}
const st = window.__TODO_CMD__?.store.getState()
const clips = (st?.sequences || []).flatMap((s) => s.clips || [])
const byJob = {}
for (const c of clips) {
  const j = c.meta?.source?.jobId || '(无出处)'
  byJob[j] = (byJob[j] || 0) + 1
}
return JSON.stringify({
  title: document.title,
  projectPath: st?.projectPath,
  productions: Object.keys(st?.settings?.aiProductions || {}),
  tracks: (st?.sequences || []).reduce((n, s) => n + (s.tracks || []).length, 0),
  clips: clips.length,
  byJob,
  duration: Math.max(0, ...clips.map((c) => c.start + c.duration)),
}, null, 2)
