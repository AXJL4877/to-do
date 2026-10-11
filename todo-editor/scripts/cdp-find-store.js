// 从 React fiber 里找出 zustand store，挂到 window.__TODO_STORE__
if (window.__TODO_STORE__) return 'already: clips=' + window.__TODO_STORE__.getState().sequences.reduce((n, s) => n + s.clips.length, 0)
const root = document.querySelector('#root') || document.body
const key = Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'))
if (!key) return 'no react key on root: ' + Object.keys(root).slice(0, 8).join(',')
const start = root[key]
const seen = new Set()
const q = [start]
let visited = 0
while (q.length) {
  const f = q.shift()
  if (!f || seen.has(f)) continue
  seen.add(f)
  visited++
  let h = f.memoizedState
  let guard = 0
  while (h && guard++ < 60) {
    const s = h.memoizedState
    if (s && typeof s === 'object' && typeof s.getState === 'function' && typeof s.setState === 'function' && Array.isArray(s.sequences)) {
      window.__TODO_STORE__ = s
      const st = s.getState()
      return JSON.stringify({
        ok: true, visited,
        sequences: st.sequences.map((x) => ({ id: x.id, clips: x.clips.length })),
        activeSeqId: st.activeSeqId,
        media: st.media.length,
        projectPath: st.projectPath,
        aiProductions: Object.keys(st.settings?.aiProductions || {}),
      })
    }
    h = h.next
  }
  if (f.child) q.push(f.child)
  if (f.sibling) q.push(f.sibling)
}
return 'store not found (visited ' + visited + ' fibers)'
