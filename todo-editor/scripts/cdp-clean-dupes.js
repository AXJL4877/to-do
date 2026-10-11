// 删掉旧成片留下的 82 个片段，并清掉多出来的空轨道
const b = window.__TODO_CMD__
const st = b.store.getState()
const stale = []
for (const s of st.sequences || []) {
  for (const c of s.clips || []) {
    if (c.meta?.source?.jobId === 'p_mv3j26nl_ntm8') stale.push(c.id)
  }
}
if (!stale.length) return JSON.stringify({ note: '没有旧片段了' })
const r = await b.run('timeline.delete_clips', { clipIds: stale })
await new Promise((x) => setTimeout(x, 1500))

// 清理没有任何片段的轨道（只保留有内容的）
const s2 = b.store.getState()
const seq = (s2.sequences || [])[0]
const used = new Set((seq?.clips || []).map((c) => c.track))
const empty = (seq?.tracks || []).filter((t) => !used.has(t.id)).map((t) => t.id)
let removedTracks = 0
for (const id of empty) {
  try { await b.run('track.remove', { trackId: id }); removedTracks++ } catch (e) { /* 至少留一条 */ }
}
await new Promise((x) => setTimeout(x, 1200))

const s3 = b.store.getState()
const clips = (s3.sequences || []).flatMap((s) => s.clips || [])
const byJob = {}
for (const c of clips) { const j = c.meta?.source?.jobId || '(无)'; byJob[j] = (byJob[j] || 0) + 1 }
return JSON.stringify({
  deleted: stale.length,
  runOk: r?.ok !== false,
  removedTracks,
  clips: clips.length,
  tracks: (s3.sequences || []).reduce((n, s) => n + (s.tracks || []).length, 0),
  byJob,
}, null, 2)
