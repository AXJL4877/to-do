/**
 * 能力清单（todo-capabilities/1）：智能体读的**第一个**文件。
 *
 * 目的：不用读源码就知道这个应用能做什么、怎么调、参数什么样、失败长什么样。
 * 规则：只登记**真实存在**的能力；尚未实现的写 status:'planned'，并说明缺口——
 *      给智能体一个诚实的边界，比给它一堆幻觉接口强。
 */
import { SPEC_PROJECT_V2 } from './projectSpec.mjs'
import { PARAM_TYPE_LIST, compileParams } from './params.mjs'

export { compileParams }

export const CAPABILITIES_SPEC = 'todo-capabilities/1'

/** 错误码用导出常量，消费方 import 而不是硬编码字符串（照 DSH：route on code, never by parsing message）。 */
export const ERROR_CODES = {
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  BUSY: 'busy',
  PERMISSION: 'permission',
  NEEDS_CONFIG: 'needs_config',
  UPSTREAM: 'upstream',
  TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported',
  INTERNAL: 'internal',
}

/** 可重试性用**集合**表达，而不是每个错误带一个布尔：谁可重试由这份名单决定。 */
export const DEFAULT_RETRYABLE_CODES = [ERROR_CODES.BUSY, ERROR_CODES.UPSTREAM, ERROR_CODES.TIMEOUT]

const ERROR_HINTS = {
  [ERROR_CODES.BAD_REQUEST]: '参数不合法；details.path 指出出错字段',
  [ERROR_CODES.NOT_FOUND]: '目标不存在（工程/序列/片段/媒体 id）',
  [ERROR_CODES.CONFLICT]: '状态冲突（版本不一致、已锁定、已有同名产物）',
  [ERROR_CODES.BUSY]: '有任务在跑；稍后重试或先取消',
  [ERROR_CODES.PERMISSION]: '文件/端口权限；检查路径与进程归属',
  [ERROR_CODES.NEEDS_CONFIG]: '缺 API Key / 供应商配置；先配置再重试',
  [ERROR_CODES.UPSTREAM]: '外部服务（模型/图像/TTS）失败',
  [ERROR_CODES.TIMEOUT]: '超时',
  [ERROR_CODES.UNSUPPORTED]: '当前版本不支持；见 operations[].status',
  [ERROR_CODES.INTERNAL]: '内部错误，属缺陷',
}

/** 统一错误契约：所有端点失败时返回这个形状（新端点必须遵守；旧端点逐步迁移）。 */
export const ERROR_CONTRACT = {
  shape: { ok: false, error: { code: 'string', message: 'string', hint: 'string?', retryable: 'boolean?', details: 'object?' } },
  legacy: '部分旧端点仍返回 { ok:false, error:"字符串" }；客户端应兼容两种（error 既可能是字符串也可能是对象）。',
  codes: Object.values(ERROR_CODES).map((code) => ({
    code,
    retryable: DEFAULT_RETRYABLE_CODES.includes(code),
    hint: ERROR_HINTS[code] ?? '',
  })),
  retryableCodes: DEFAULT_RETRYABLE_CODES,
}

const op = (o) => ({
  status: 'stable', sideEffects: false, idempotent: true, longRunning: false, ...o,
})

/**
 * 现有 HTTP 面（已核实存在）。base 由宿主注入，形如 http://127.0.0.1:<port>。
 * 详见 server/aiHttp.mjs。
 */
export const HTTP_OPERATIONS = [
  // ---- 生成类 ----
  op({ id: 'ai.image', method: 'POST', path: '/api/ai-image', summary: '按提示词生成图片（Huniu/蜜匙）', sideEffects: true, idempotent: false, longRunning: true,
    params: { prompt: { type: 'string', required: true, description: '画面描述' }, size: { type: 'string', description: '如 1024x1024' }, styleId: 'string?', referenceImage: { type: 'string', description: '参考图 data URL' } }, returns: { ok: true, asset: 'AiAsset' } }),
  op({ id: 'ai.video', method: 'POST', path: '/api/ai-video', summary: '文/图生视频', sideEffects: true, idempotent: false, longRunning: true }),
  op({ id: 'ai.anims', method: 'GET', path: '/api/ai-anims', summary: '动画包列表' }),
  op({ id: 'ai.animDirect', method: 'POST', path: '/api/ai-anim-direct', summary: '直接驱动动画（粉笔手等）', sideEffects: true, idempotent: false, longRunning: true }),
  op({ id: 'ai.fancyText', method: 'POST', path: '/api/ai-fancy-text', summary: '花字/特效文字生成', sideEffects: true, idempotent: false }),
  op({ id: 'ai.fancyTexture', method: 'POST', path: '/api/ai-fancy-texture', summary: '文字纹理生成', sideEffects: true, idempotent: false }),
  op({ id: 'ai.script', method: 'POST', path: '/api/ai-script', summary: '口播稿生成/分段', sideEffects: false, idempotent: false, longRunning: true }),
  op({ id: 'ai.scriptStage', method: 'POST', path: '/api/ai-script-stage', summary: '分段/改写等单步脚本操作', sideEffects: false }),
  op({ id: 'ai.skills', method: 'GET', path: '/api/ai-skills', summary: '技能包（扩展）列表' }),
  op({ id: 'ai.skillPlan', method: 'POST', path: '/api/ai-skill-plan', summary: '按技能包规划元素', sideEffects: false, longRunning: true }),
  op({ id: 'ai.styles', method: 'GET', path: '/api/ai-styles', summary: '风格包列表' }),
  op({ id: 'ai.models', method: 'GET', path: '/api/ai-models', summary: '可用模型/供应商' }),
  op({ id: 'ai.config', method: 'GET', path: '/api/ai-config', summary: '读取 AI 配置（密钥脱敏）' }),
  op({ id: 'ai.configImportMishi', method: 'POST', path: '/api/ai-config/import-mishi', summary: '从 蜜匙 导入密钥配置', sideEffects: true }),
  op({ id: 'ai.assets', method: 'GET', path: '/api/ai-assets', summary: 'AI 产物库（列表/单个）' }),
  op({ id: 'ai.jobs', method: 'GET', path: '/api/ai-jobs', summary: '任务队列状态（含进度）' }),
  op({ id: 'ai.jobSubmit', method: 'POST', path: '/api/ai-jobs', summary: '提交任务', sideEffects: true, idempotent: false, longRunning: true }),
  op({ id: 'ai.productions', method: 'GET', path: '/api/ai-productions', summary: '成片列表/详情（todo-production/1）' }),
  op({ id: 'ai.extensions.import', method: 'POST', path: '/api/ai-extensions/import', summary: '安装扩展包（application/octet-stream，仅本机 + 需 token 前置检查）', sideEffects: true, idempotent: false }),
  op({ id: 'ai.extensions.uninstall', method: 'POST', path: '/api/ai-extensions/uninstall', summary: '卸载扩展包', sideEffects: true }),
  op({ id: 'ai.h3', method: 'POST', path: '/api/ai-h3', summary: 'H3 工作流调用（外部 studio）' }),
  op({ id: 'ai.h3Start', method: 'POST', path: '/api/ai-h3/start', summary: '启动 H3 studio', sideEffects: true }),
  op({ id: 'ai.douyinMeta', method: 'POST', path: '/api/ai-douyin-meta', summary: '抖音发布元信息' }),
  op({ id: 'ai.douyinCover', method: 'POST', path: '/api/ai-douyin-cover', summary: '抖音封面生成', sideEffects: true }),
  op({ id: 'media.serve', method: 'GET', path: '/ai-generated/<name>', summary: '读取 AI 产物原文件（mp4/webm/png/wav/mp3/json）' }),

  // ---- 编辑器类：尚未实现，是这一轮要补的契约 ----
  op({ id: 'project.summary', method: 'GET', path: '/api/project/summary', status: 'planned', summary: '当前工程的结构化摘要（画布/序列/轨道/时长/成片/素材）', note: '规划编辑前先读它' }),
  op({ id: 'project.open', method: 'POST', path: '/api/project/open', status: 'beta', summary: '打开工程（写锁 + 迁移读入 + 报告崩溃残留）', sideEffects: true, note: 'CLI/MCP 已可用；HTTP 端点待接线' }),
  op({ id: 'project.save', method: 'POST', path: '/api/project/save', status: 'beta', summary: '保存工程（原子写 tmp→rename + .bak + 环形备份 + 清恢复日志）', sideEffects: true, note: 'CLI(exec --write) 已走这条路径；HTTP 端点待接线' }),
  op({ id: 'project.snapshot', method: 'POST', path: '/api/project/snapshot', status: 'beta', summary: '原子快照/回滚（环形自动保存 + 崩溃恢复日志）', sideEffects: true, note: 'CLI(snapshots/recover) 与 MCP(project_snapshots/recovery_plan) 已可用；HTTP 端点待接线' }),
  op({ id: 'project.validate', method: 'POST', path: '/api/project/validate', status: 'planned', summary: '按 todo-project 规范校验并返回 errors[].code/path/hint' }),
  op({ id: 'timeline.read', method: 'GET', path: '/api/timeline', status: 'planned', summary: '读时间轴（可按轨道/时间窗过滤，返回片段数组）' }),
  op({ id: 'timeline.command', method: 'POST', path: '/api/timeline/command', status: 'beta', summary: '**唯一写入口**：执行一条命令（见 commands），走同一套校验 + undo', sideEffects: true, idempotent: false, note: '三条面均已可用：CLI(exec / app)、MCP(todo_app_command)、HTTP(POST /api/timeline/command，支持 dryRun)。**打包版**走主进程控制端口（进程内桥，见 control 字段）；开发模式 HTTP 首选同一条桥，调试协议只作兜底' }),
  op({ id: 'timeline.undo', method: 'POST', path: '/api/timeline/undo', status: 'beta', summary: '撤销/重做（返回撤销后的摘要，便于机读确认真的回退了）', sideEffects: true, note: '走应用自身的撤销栈（一次编辑 = 一条命令 = 一次撤销）；CLI(app undo)、MCP(action:"undo")、HTTP(POST /api/timeline/undo) 三面可用' }),
  op({ id: 'render.frame', method: 'POST', path: '/api/render/frame', status: 'beta', summary: '渲染单帧为 PNG（走监视器同一条渲染路径；同输入同字节）', longRunning: true, note: 'CLI(frame) 与 MCP(todo_render_frame，直接把画面回给智能体) 已可用；HTTP 端点待接线' }),
  op({ id: 'render.preview', method: 'POST', path: '/api/render/preview', status: 'planned', summary: '渲染一段低码率预览', longRunning: true }),
  op({ id: 'render.export', method: 'POST', path: '/api/render/export', status: 'planned', summary: '导出成片；带 progress/cancel/etaSeconds', sideEffects: true, longRunning: true }),
  op({ id: 'verify.run', method: 'POST', path: '/api/verify', status: 'planned', summary: '跑硬验收门并返回机器可读结果（复用 accept_gates）' }),
  op({ id: 'interchange.otio', method: 'POST', path: '/api/interchange/otio', status: 'beta', summary: '导出/导入 OpenTimelineIO（行业交换格式）', sideEffects: true, note: 'CLI: todo otio export/import。**有损**：OTIO 轨道是顺序模型（重叠会被压平），且标记/转场不映射；两个方向都返回 lossy 清单' }),
]

/**
 * 写入口的**部署形态**：开发模式与打包版各是什么。
 * 智能体必须知道这件事——否则它会在打包版里去找不存在的调试端口。
 */
export const CONTROL_INTERFACE = {
  spec: 'todo-control/1',
  packaged: {
    how: '主进程本地控制端口（进程内桥）',
    bind: '127.0.0.1:<随机端口>',
    discovery: 'userData/ai-control.json → { port, token, pid }',
    auth: 'Authorization: Bearer <token>（无 token 一律 401）',
    routes: {
      'GET /status': '应用与工程基本信息',
      'POST /command': '{ id, args?, commit? } → 执行一条命令（同一套命令层与写入闸门）',
      'POST /renderer': '{ action: "inspect" | "commands" | "document" | "undo" | "redo" } → 查询与撤销',
    },
  },
  dev: {
    how: 'Vite 插件上的 /api/*（首选同样走进程内桥，连不上才退回调试协议）',
    cdpFallback: 'scripts/app-command.mjs 经 --debug-port 访问运行中的应用（仅开发模式存在）',
  },
  why: '工程的真身是渲染进程内存中的文档，磁盘文件只是快照——外部改文件会被下次保存覆盖。控制端口只绑本地且强制 token（照 DSH 的教训：控制面绝不裸奔）。',
}

/** 命令注册表：写操作的**唯一**入口。真实清单在 server/core/commands.mjs（这里只指路，避免 spec↔core 循环依赖）。 */
export const COMMAND_CONTRACT = {
  status: 'stable',
  implementedIn: 'server/core/commands.mjs',
  discover: {
    cli: 'npm run todo -- commands [--catalog]',
    mcp: 'todo_commands_list / todo_command_preview（预演，不落盘）',
    http: '/api/timeline/command（planned）',
  },
  shape: {
    id: 'timeline.razor',
    label: '切片',
    params: { at: { type: 'number', unit: 'second', required: true } },
    enabled: '返回 null 表示可用；返回字符串表示不可用原因（直接展示给人与智能体）',
    run: '返回结构化结果（含新建/修改的 id 列表），并进入 undo 历史',
    undoable: true,
  },
  guarantees: [
    'I3 一次编辑 = 一条命令 = 一次撤销（DocumentSession 负责历史）',
    'I5 写入闸门：命令不得引入新的规范错误，引入即拒绝且文档不变',
    'I6 已发布的命令 id 永不改名（工程里存的是 id）',
    '命令是纯函数：失败时文档不变、不进历史、不落盘；批量执行全成功或全回滚',
  ],
  why: '前端直接改 store 时，智能体拿不到「能做什么 / 为什么不能做 / 改了什么」；命令表补齐这三件事。',
}

/** 时间基准（planned）：当前工程用浮点秒，商用标准应换成整数 tick + 有理帧率。 */
export const TIME_MODEL = {
  current: { unit: 'float seconds', risk: '23.976/29.97 等非整数帧率下累计漂移；duration 实测出现 7.8025 这类值' },
  target: {
    status: 'planned',
    unit: 'integer tick',
    ticksPerSecond: 254016000000,
    why: '可被 23.976/24/25/29.97/30/48/50/59.94/60/120 与 8k–192k 采样率整除（参考 filmcraft）',
    frameRate: { num: 'integer', den: 'integer' },
    invariant: '片段起点用序列 tick；关键帧与 source_in 用素材 tick —— trim/split 永不移动关键帧',
  },
}

/**
 * 清单自校验（作者期就该炸，而不是等智能体踩）。
 * 检查：spec 串、操作 id 唯一、method/path/status 合法、参数能编译成规范 schema、
 *       错误码闭集且 retryableCodes ⊆ codes、接入面声明完整。
 * @returns {{ok:boolean, errors:Array<{code:string, at:string, message:string}>}}
 */
export function validateCapabilities(cap = capabilities()) {
  const errors = []
  const push = (code, at, message) => errors.push({ code, at, message })

  if (cap.spec !== CAPABILITIES_SPEC) push('bad_spec', '$.spec', `spec 必须是 ${CAPABILITIES_SPEC}`)
  if (cap.projectSpec !== SPEC_PROJECT_V2) push('bad_spec', '$.projectSpec', `projectSpec 必须是 ${SPEC_PROJECT_V2}`)

  const ids = new Set()
  for (const [i, o] of (cap.operations ?? []).entries()) {
    const at = `$.operations[${i}]`
    if (!o.id) push('missing_id', at, '操作缺少 id')
    else if (ids.has(o.id)) push('duplicate_id', `${at}.id`, `操作 id 重复：${o.id}`)
    else ids.add(o.id)
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(o.method)) push('bad_method', `${at}.method`, `未知 method ${o.method}`)
    if (!String(o.path ?? '').startsWith('/')) push('bad_path', `${at}.path`, 'path 必须以 / 开头')
    if (!['stable', 'beta', 'planned', 'deprecated'].includes(o.status)) push('bad_status', `${at}.status`, `未知 status ${o.status}`)
    if (!o.summary) push('missing_summary', `${at}.summary`, '操作缺少 summary（智能体靠它选择）')
    if (o.params != null) {
      try {
        const schema = compileParams(o.params)
        for (const [name, node] of Object.entries(schema.properties ?? {})) {
          if (!PARAM_TYPE_LIST.includes(node.type)) push('bad_param_type', `${at}.params.${name}`, `类型 ${node.type} 不在闭集里`)
        }
        if (typeof schema.additionalProperties !== 'boolean') push('missing_additional_properties', `${at}.params`, 'object schema 必须显式声明 additionalProperties')
      } catch (e) {
        push('bad_params', `${at}.params`, e.message)
      }
    }
  }

  const codes = new Set((cap.errorContract?.codes ?? []).map((c) => c.code))
  if (codes.size !== Object.keys(ERROR_CODES).length) push('error_code_gap', '$.errorContract.codes', '错误码集合与 ERROR_CODES 不一致')
  for (const r of cap.errorContract?.retryableCodes ?? []) {
    if (!codes.has(r)) push('retryable_unknown_code', '$.errorContract.retryableCodes', `可重试码 ${r} 不在错误码集合里`)
  }
  if (!(cap.transports ?? []).some((t) => t.kind === 'http')) push('missing_transport', '$.transports', '必须声明 http 接入面')
  for (const [i, t] of (cap.transports ?? []).entries()) {
    if (!t.kind) push('bad_transport', `$.transports[${i}]`, '接入面缺少 kind')
  }
  if (!cap.timeModel?.current || !cap.timeModel?.target) push('missing_time_model', '$.timeModel', '必须声明当前与目标时间基准')
  return { ok: errors.length === 0, errors }
}

/**
 * 组装清单。两级披露（照 DSH 的 catalog/service）：
 *   view:'catalog' → 只有 id/method/path/status/summary（省 token，先扫一遍再选）
 *   view:'full'    → 附编译后的参数 JSON Schema + 返回形状（默认）
 */
export function capabilities({ version = null, aiBaseUrl = null, view = 'full' } = {}) {
  const operations = HTTP_OPERATIONS.map((o) => {
    if (view === 'catalog') {
      return { id: o.id, method: o.method, path: o.path, status: o.status, summary: o.summary }
    }
    const { params, ...rest } = o
    return { ...rest, params: params == null ? null : compileParams(params) }
  })
  return {
    spec: CAPABILITIES_SPEC,
    view,
    app: { name: 'TO DO', kind: 'video-editor', version },
    projectSpec: SPEC_PROJECT_V2,
    specs: ['todo-project/2', 'todo-production/1', 'todo-extension-pack/1', 'todo-skill-pack/1', 'todo-style-pack/1', 'todo-anim-pack/2'],
    baseUrl: aiBaseUrl,
    transports: [
      { kind: 'http', base: aiBaseUrl, note: '本地回环；生成类已可用，编辑器类见 operations[].status=planned' },
      { kind: 'cli', status: 'stable', note: 'node server/cli.mjs <capabilities|validate|summary|clips|verify|mcp>；只输出 JSON，退出码 0/1/2；只读子集可离线跑' },
      { kind: 'mcp', status: 'stable', note: 'node server/cli.mjs mcp（stdio, protocol 2024-11-05）；只读工具 5 个：todo_capabilities / todo_project_validate / todo_project_summary / todo_project_clips / todo_verify；资源 3 个（capabilities、工程 schema、规范 README）；写操作待命令层落地后按同一批 id 加入' },
      { kind: 'cdp', status: 'stable', note: '调试用：node scripts/open-todo-app.mjs --debug-port 9222 + scripts/todo-cdp.mjs' },
    ],
    commands: COMMAND_CONTRACT,
  control: CONTROL_INTERFACE,
    timeModel: TIME_MODEL,
    errorContract: ERROR_CONTRACT,
    operations,
    conventions: {
      ids: '工程内 id 形如 seq_/track_/clip_/media_/p_mv…；已被工程存储的 id **永不改名**',
      units: 'JSON Schema 里每个数值字段的 description 都写了单位；未标注的按秒处理',
      authority: '时间以片段自身字段为准，meta.* 是派生镜像；素材长期引用以 relPath 为准',
      validation: '写入前用 node server/spec/projectSpec.mjs <file> 校验；错误带 code/path/hint',
    },
    docs: [
      { path: 'shared/spec/README.md', what: '规范索引 + 权威字段表 + 规范债' },
      { path: 'shared/spec/project-v2.schema.json', what: '工程文件 JSON Schema' },
      { path: 'server/spec/projectSpec.mjs', what: '校验器/摘要器/CLI' },
    ],
  }
}
