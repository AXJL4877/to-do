// 在应用的渲染进程里直接用「无 UI 核心层」——证明它真的跨 Electron / Web 共享。
const store = window.__TODO_STORE__ || (await import('/src/store.ts')).useApp
window.__TODO_STORE__ = store
const st = store.getState()
if (!st.started) return JSON.stringify({ ok: false, note: '工程没打开（先打开一个工程再跑）', title: document.title })

// 同一份模块：Node 侧的 CLI/MCP 用的是这些文件，浏览器里 import 到的也是它
const spec = await import('/server/spec/projectSpec.mjs')
const core = await import('/server/core/commands.mjs')
const caps = await import('/server/spec/capabilities.mjs')
const mig = await import('/server/spec/migrations.mjs')

const doc = {
  version: 2,
  projectName: st.projectName,
  settings: st.settings,
  media: st.media,
  folders: st.folders,
  sequences: st.sequences,
  activeSeqId: st.activeSeqId,
}

const report = spec.validateProject(doc)
const summary = spec.summarizeProject(doc)
const preview = core.applyCommand(doc, 'marker.add', { t: 1.5, label: '浏览器内试跑' })
const cap = caps.capabilities({ view: 'catalog' })

return JSON.stringify({
  ok: true,
  note: '渲染进程（浏览器上下文）直接 import 了共享核心',
  spec: report.spec,
  projectOk: report.ok,
  errors: report.errors.length,
  warnings: report.warnings.length,
  stats: report.stats,
  summary: { clips: summary.sequences[0]?.clips, duration: summary.sequences[0]?.duration, tracks: summary.sequences[0]?.trackCount },
  commandPreview: { ok: preview.ok, summary: preview.summary, created: preview.created },
  commandCount: core.COMMAND_IDS.length,
  capabilities: { spec: cap.spec, ops: cap.operations.length },
  migrationVersion: mig.PROJECT_CURRENT_VERSION,
  documentUntouched: doc.sequences[0].clips.length === st.sequences[0].clips.length,
}, null, 2)
