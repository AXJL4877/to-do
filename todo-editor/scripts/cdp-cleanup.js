// 清理演示草稿：只留新成片；收空轨道；修悬空 activeSeqId；清掉未被时间轴引用的媒体；存盘
const store = window.__TODO_STORE__
const S = () => store.getState()
const KEEP = 'p_mv377uud_75mz'
const seq0 = S().sequences.find((s) => s.id === S().activeSeqId) || S().sequences[0]

// ① 删掉不属于保留成片的片段 —— 走应用自己的 deleteSelected（带历史，可撤销）
const dropIds = seq0.clips.filter((c) => (c.meta?.source?.jobId || '') !== KEEP).map((c) => c.id)
let deleted = 0
if (dropIds.length) {
  store.setState({ selectedClipIds: dropIds })
  S().deleteSelected(false)
  deleted = dropIds.length
}

// ② 修悬空的 activeSeqId（原来指向一个不存在的序列，这是"乱"的根源）
store.setState({ activeSeqId: seq0.id })

// ③ 收掉已经空掉的轨道（应用没有删轨道 API，直接改状态）
let seq = S().sequences.find((s) => s.id === seq0.id)
const usedTracks = new Set(seq.clips.map((c) => c.trackId))
const emptyTracks = seq.tracks.filter((t) => !usedTracks.has(t.id))
if (emptyTracks.length) {
  store.setState({
    sequences: S().sequences.map((s) => (s.id === seq0.id ? { ...s, tracks: s.tracks.filter((t) => usedTracks.has(t.id)) } : s)),
  })
}

// ④ 关掉其它成片的自动绑定，免得它们又自己长回时间轴
const aps = { ...S().settings.aiProductions }
for (const k of Object.keys(aps)) if (k !== KEEP) aps[k] = { ...aps[k], auto: false }
store.setState({ settings: { ...S().settings, aiProductions: aps } })

// ⑤ 清掉没被任何片段引用的媒体（只移出工程，不动磁盘文件；成片文件保留）
const usedMedia = new Set(S().sequences.flatMap((s) => s.clips.map((c) => c.mediaId)))
const protect = (m) => /source_film|成片|film/i.test(String(m.name || '') + ' ' + String(m.url || ''))
const unused = S().media.filter((m) => !usedMedia.has(m.id) && !protect(m)).map((m) => m.id)
const removedMediaNames = S().media.filter((m) => unused.includes(m.id)).map((m) => m.name).slice(0, 400)
if (unused.length) S().removeMediaBatch(unused)

// ⑥ 存盘（应用现在有权限写工程目录了）
let saved = null
try { await S().flushProject(); saved = 'ok' } catch (e) { saved = 'failed: ' + String(e && e.message ? e.message : e) }

const after = S().sequences.find((s) => s.id === seq0.id)
return JSON.stringify({
  deletedClips: deleted,
  emptyTracksRemoved: emptyTracks.map((t) => `${t.name}(${t.kind})`),
  removedMedia: unused.length,
  mediaNow: S().media.length,
  clips: after.clips.length,
  tracks: after.tracks.length,
  activeSeqId: S().activeSeqId,
  jobIds: [...new Set(after.clips.map((c) => c.meta?.source?.jobId))],
  save: saved,
  removedMediaNames: removedMediaNames.slice(0, 40),
}, null, 2)
