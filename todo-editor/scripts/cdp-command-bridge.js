// 真机验证：应用里的命令桥（I3 在产品里成立）
const store = window.__TODO_STORE__ || (await import('/src/store.ts')).useApp
window.__TODO_STORE__ = store
const b = window.__TODO_CMD__
if (!b) return JSON.stringify({ ok: false, note: '命令桥未挂载（页面需要重载以加载新模块）' })

const st = () => store.getState()
const before = b.inspect()
const seq0 = st().seq()
const markersBefore = (seq0.markers ?? []).length
const clipsBefore = seq0.clips.length

// 1) 命令：通过共享核心执行并写回 store
const r = b.run('marker.add', { t: 3.25, label: '命令桥验证' })
const markersAfter = (st().seq().markers ?? []).length
const lastMarker = (st().seq().markers ?? []).slice(-1)[0]
const dirtyAfter = st().dirty

// 2) 预演（不写回、不入历史）
const p = b.preview('timeline.delete_clips', { clipIds: [seq0.clips[0].id] })
const clipsAfterPreview = st().seq().clips.length

// 3) 撤销：走 store 自己的历史栈
st().undo()
const markersUndone = (st().seq().markers ?? []).length

// 4) 失败路径：命令被写入闸门/校验挡住时，store 不能变
const bad = b.run('timeline.split_clip', { clipId: seq0.clips[0].id, at: 99999 })
const clipsAfterBad = st().seq().clips.length

// 5) 只读诊断
const after = b.inspect()

return JSON.stringify({
  ok: true,
  bridge: { commands: b.commandIds.length, ids: b.commandIds.slice(0, 4), documentKeys: Object.keys(b.document()).sort() },
  validateBefore: { ok: before.validate.ok, errors: before.validate.errors.length, clips: before.validate.stats.clipCount },
  command: { ok: r.ok, summary: r.summary, created: r.created, changed: r.changed },
  store: { clipsBefore, markersBefore, markersAfter, lastMarker: lastMarker?.label ?? null, dirtyAfter },
  previewNoCommit: { ok: p.ok, summary: p.summary, clipsUnchanged: clipsAfterPreview === clipsBefore },
  undo: { markersUndone, restored: markersUndone === markersBefore },
  blocking: { ok: bad.ok, code: bad.error?.code, message: bad.error?.message?.slice(0, 60), clipsUnchanged: clipsAfterBad === clipsBefore },
  validateAfter: { ok: after.validate.ok, errors: after.validate.errors.length },
}, null, 2)
