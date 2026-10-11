/**
 * 渲染进程侧的**命令桥**：让应用里的写操作走无 UI 核心层的命令表。
 *
 * 为什么需要它：现在 `src/store.ts` 里的编辑动作是直接改 zustand 状态，命令层只在 CLI/MCP 里成立。
 * 于是「一次编辑 = 一条命令 = 一次撤销」（不变量 I3）在产品里不成立，而且**人和智能体走的是两套入口**。
 *
 * 这层的做法很轻：把当前 store 组装成一份工程文档 → 交给核心层的 applyCommand（纯函数、带写入闸门）
 * → 把结果文档写回 store → 用 store 自己的历史栈兜住撤销。
 * 好处是**同一份实现**同时服务于 UI 按钮、命令行、MCP 与 HTTP 端点。
 *
 * 只在开发模式挂 `window.__TODO_CMD__`，打包版不暴露这个入口。
 */
import { applyCommand, describeCommands, COMMAND_IDS } from '../../server/core/commands.mjs'
import { summarizeProject, validateProject } from '../../server/spec/projectSpec.mjs'
import { useApp } from '../store'

type Doc = Record<string, unknown>

/** 从 store 组装工程文档（只取"文档"字段，不含 playhead 等会话态）。 */
export function documentFromState(s = useApp.getState()): Doc {
  return {
    version: 2,
    projectName: s.projectName,
    settings: s.settings,
    media: s.media,
    folders: s.folders,
    sequences: s.sequences,
    activeSeqId: s.activeSeqId,
  }
}

/** 把命令返回的文档写回 store（只写命令层会碰的字段，会话态保持不动）。 */
function applyDocumentToState(doc: Doc): void {
  const cur = useApp.getState()
  const next = doc as { sequences?: unknown; media?: unknown; folders?: unknown; settings?: { aiProductions?: unknown } }
  useApp.setState({
    ...(next.sequences ? { sequences: next.sequences as typeof cur.sequences } : {}),
    ...(next.media ? { media: next.media as typeof cur.media } : {}),
    ...(next.folders ? { folders: next.folders as typeof cur.folders } : {}),
    ...(next.settings?.aiProductions
      ? { settings: { ...cur.settings, aiProductions: next.settings.aiProductions as typeof cur.settings.aiProductions } }
      : {}),
    dirty: true,
  })
}

export interface BridgeResult {
  ok: boolean
  command: string
  summary?: string
  changed?: string[]
  created?: string[]
  error?: { code: string; message: string; hint?: string }
}

/**
 * 在**当前工程**上执行一条命令。
 * @param opts.commit true=写回 store 并入 undo 栈（UI 用）；false=只预演不入栈（agent 试算用）
 */
export function runCommand(id: string, args: Record<string, unknown> = {}, opts: { commit?: boolean } = {}): BridgeResult {
  const commit = opts.commit !== false
  const s = useApp.getState()
  if (!s.started) return { ok: false, command: id, error: { code: 'conflict', message: '没有打开工程' } }
  const doc = documentFromState(s)
  const r = applyCommand(doc, id, args)
  if (!r.ok) return { ok: false, command: id, error: r.error }
  if (!commit) return { ok: true, command: id, summary: r.summary, changed: r.changed, created: r.created }
  // 借 store 自己的历史栈兜撤销：先拍快照，再写回
  s.pushHistory()
  applyDocumentToState(r.doc)
  return { ok: true, command: id, summary: r.summary, changed: r.changed, created: r.created }
}

/** 只读诊断：规范校验 + 摘要（给 UI 与 agent 用同一份结果）。 */
export function inspect(): { validate: ReturnType<typeof validateProject>; summary: ReturnType<typeof summarizeProject> } {
  const doc = documentFromState()
  return { validate: validateProject(doc), summary: summarizeProject(doc) }
}

/** 命令表（给 UI 生成菜单/按钮、给 agent 发现能力）。 */
export function listCommands(withParams = false) {
  return describeCommands({ withParams })
}

// 开发模式下暴露给外部（CLI/MCP/CDP 驱动应用内的同一套命令）——打包版不挂
//
// 注意这里必须**延迟**安装：store.ts → commandBridge.ts → store.ts 是循环导入，
// 如果在模块顶层直接读 useApp，会撞上 TDZ（暂时性死区）→ 渲染进程白屏。
// 这个坑真踩过一次：表现是"应用起不来"，很容易被误判成环境抖动。
if (import.meta.env?.DEV) {
  queueMicrotask(() => {
    ;(window as unknown as Record<string, unknown>).__TODO_CMD__ = {
      run: (id: string, args?: Record<string, unknown>) => runCommand(id, args ?? {}, { commit: true }),
      preview: (id: string, args?: Record<string, unknown>) => runCommand(id, args ?? {}, { commit: false }),
      inspect,
      commands: () => listCommands(false),
      commandIds: COMMAND_IDS,
      document: () => documentFromState(),
      // 应用**自己**的 store 实例。外部脚本若自己 import('/src/store.ts') 会拿到另一个模块实例
      // （Vite 的 HMR 版本查询 ?t=... 会新建实例），状态是干净的初始值——用它才能测到真实状态。
      store: useApp,
    }
  })
}

/**
 * 进程内桥的处理端：主进程的控制端口收到命令 → IPC 发到这里 → 用本文件同一套 runCommand 执行。
 *
 * 与 window.__TODO_CMD__ 的区别：那个是**开发模式**给外部脚本用的调试入口（打包版不挂）；
 * 这条是**正式通道**，打包版也生效 —— 于是"稳定本地 API"不再是开发机上的调试口。
 *
 * 注意：这里访问的是应用自己的 store 实例（本模块就跑在应用里），不存在 CDP 那种"导入到另一个实例"的问题。
 */
const ipcBridge = (window as unknown as {
  todoDesktop?: {
    onCommandRequest?: (cb: (p: { reqId: string; id?: string; args?: Record<string, unknown>; commit?: boolean; action?: string }) => void) => (() => void) | void
    replyCommand?: (reqId: string, result: unknown) => void
  }
}).todoDesktop

if (ipcBridge?.onCommandRequest && ipcBridge?.replyCommand) {
  ipcBridge.onCommandRequest(({ reqId, id, args, commit, action }) => {
    let result: unknown
    try {
      if (action === 'inspect') {
        // 返回形状刻意与 CDP 路径（scripts/app-command.mjs）一致，两条通路可互换
        const i = inspect()
        const st = useApp.getState()
        result = {
          ok: i.validate.ok,
          validate: { spec: i.validate.spec, ok: i.validate.ok, errors: i.validate.errors, warnings: i.validate.warnings.length, stats: i.validate.stats },
          summary: i.summary,
          live: { title: document.title, started: st.started, dirty: st.dirty },
        }
      } else if (action === 'undo' || action === 'redo') {
        const before = useApp.getState()
        if (!before.started) {
          result = { ok: false, error: { code: 'conflict', message: '没有打开工程' } }
        } else {
          if (action === 'undo') before.undo(); else before.redo()
          const after = useApp.getState()
          result = { ok: true, action, summaryAfter: inspect().summary, live: { title: document.title, started: after.started, dirty: after.dirty } }
        }
      } else if (action === 'commands') {
        result = { ok: true, commands: listCommands(false) }
      } else if (action === 'document') {
        result = { ok: true, document: documentFromState() }
      } else {
        // id 是可选字段（只读 action 不带它）：这里必须显式守卫，
        // 否则 TS 会把 string | undefined 带进 runCommand —— 而"忘了带命令 id"应当回一条明确的错误，
        // 不是靠类型断言糊过去。
        result = !id
          ? { ok: false, error: { code: 'bad_request', message: '缺少 id：写操作必须给出命令 id（见 todo_commands_list）' } }
          : {
              ...(commit === false ? runCommand(id, args ?? {}, { commit: false }) : runCommand(id, args ?? {}, { commit: true })),
              // 形状对齐 CDP 路径（scripts/app-command.mjs）：两条通路必须可互换，否则调用方要写两套解析
              live: { title: document.title, started: useApp.getState().started, dirty: useApp.getState().dirty },
            }
      }
    } catch (e) {
      result = { ok: false, command: id ?? action, error: { code: 'internal', message: String((e as Error)?.message ?? e) } }
    }
    ipcBridge.replyCommand?.(reqId, result)
  })
}
