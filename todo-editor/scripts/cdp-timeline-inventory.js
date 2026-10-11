const st = window.__TODO_STORE__.getState()
const seq = st.sequences.find((s) => s.id === st.activeSeqId) || st.sequences[0]
const media = new Map(st.media.map((m) => [m.id, m]))
const by = {}
const trackKinds = new Map(seq.tracks.map((t) => [t.id, t.kind]))
for (const c of seq.clips) {
  const jid = c.meta?.source?.jobId || '(无 jobId)'
  const g = String(c.meta?.source?.key || '').split('/')[0] || '(无 key)'
  const b = by[jid] = by[jid] || { clips: 0, groups: new Set(), tracks: new Set(), min: 1e9, max: -1e9, kinds: {} }
  b.clips++
  b.groups.add(g)
  b.tracks.add(c.trackId)
  b.min = Math.min(b.min, c.start)
  b.max = Math.max(b.max, c.start + (c.duration || 0))
  const k = media.get(c.mediaId)?.kind || 'none'
  b.kinds[k] = (b.kinds[k] || 0) + 1
}
const rows = Object.entries(by).map(([jid, b]) => ({
  jobId: jid, clips: b.clips, groups: [...b.groups].sort(), tracks: b.tracks.size,
  span: `${b.min.toFixed(1)}~${b.max.toFixed(1)}s`, kinds: b.kinds,
}))
const tracks = seq.tracks.map((t, i) => ({
  i, id: t.id, kind: t.kind, name: t.name,
  clips: seq.clips.filter((c) => c.trackId === t.id).length,
  used: seq.clips.some((c) => c.trackId === t.id),
  group: (seq.clips.find((c) => c.trackId === t.id)?.meta?.source?.key || '').split('/')[0] || '',
}))
return JSON.stringify({ activeSeqId: st.activeSeqId, seqId: seq.id, clips: seq.clips.length, tracks: seq.tracks.length, rows, trackList: tracks }, null, 2)
