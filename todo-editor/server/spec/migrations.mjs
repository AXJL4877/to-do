/**
 * 工程格式迁移框架（相邻单步边 + 静态目录 + 缺口校验）。
 *
 * 设计取自两处实践：
 *   - filmcraft：`SCHEMA_VERSION` + `MIGRATIONS` 单步函数链，第 i 项把 v(i+1) → v(i+2)，
 *     每步必须配「旧形状」fixture 与加载测试，**已发布的迁移永不修改**；
 *   - DSH：迁移由**静态目录**拥有（运行时禁止增删边），构造时校验「重复边 / 缺口 / 超出当前版本」，
 *     文件名内含格式版本，读取未来版本要**明确拒绝**而不是半读半写。
 *
 * 现状：当前格式是 v2（裸整数 `version`），`OLDEST_SUPPORTED = 2`，所以边列表为空——
 * 框架先立起来并有测试，v3 落地时只需往 EDGES 里加一条 + 一个旧形状 fixture。
 */

export const PROJECT_CURRENT_VERSION = 2
/** 本版本承诺能读的最老格式。比它更老的一律拒绝（而不是猜）。 */
export const PROJECT_OLDEST_SUPPORTED = 2

/**
 * 已发布迁移边（相邻单步）。**已发布的条目永不修改**，只允许追加。
 * 每条：{ from, to, summary, run(doc) => doc, fixture? }
 */
export const EDGES = []


/** 取文档声明的格式版本（兼容裸整数 `version` 与 v3 起的 `spec: "todo-project/N"`）。 */
export function versionOf(doc) {
  if (!doc || typeof doc !== 'object') return null
  if (typeof doc.spec === 'string') {
    const m = /^todo-project\/(\d+)$/.exec(doc.spec)
    if (m) return Number(m[1])
  }
  if (Number.isInteger(doc.version)) return doc.version
  return null
}

/**
 * 校验迁移目录本身（构造期不变量）。
 * 规则：边必须相邻（to === from + 1）；无重复 from；从 oldest 到 current 无缺口；不得超出 current。
 */
export function validateCatalog({
  currentVersion = PROJECT_CURRENT_VERSION,
  oldestSupported = PROJECT_OLDEST_SUPPORTED,
  edges = EDGES,
} = {}) {
  const errors = []
  const seen = new Map()
  for (const [i, e] of edges.entries()) {
    const at = `edges[${i}]`
    if (!Number.isInteger(e?.from) || !Number.isInteger(e?.to)) { errors.push({ code: 'bad_edge', at, message: '边必须声明整数 from/to' }); continue }
    if (e.to !== e.from + 1) errors.push({ code: 'non_adjacent_edge', at, message: `边必须相邻（得到 ${e.from}→${e.to}）` })
    if (seen.has(e.from)) errors.push({ code: 'duplicate_edge', at, message: `from=${e.from} 的边重复` })
    seen.set(e.from, e)
    if (e.to > currentVersion) errors.push({ code: 'edge_beyond_current', at, message: `边指向 v${e.to}，超出当前版本 v${currentVersion}` })
    if (typeof e.run !== 'function') errors.push({ code: 'bad_edge', at, message: '边缺少 run(doc)' })
  }
  for (let v = oldestSupported; v < currentVersion; v += 1) {
    if (!seen.has(v)) errors.push({ code: 'gap_in_catalog', at: `v${v}`, message: `缺 v${v} → v${v + 1} 的迁移边` })
  }
  return { ok: errors.length === 0, errors, currentVersion, oldestSupported, edgeCount: edges.length }
}

/**
 * 把文档迁到目标版本。
 * @returns {{ok:boolean, doc?:object, from?:number, to?:number, applied?:string[], error?:object}}
 */
export function migrate(doc, {
  target = PROJECT_CURRENT_VERSION,
  oldestSupported = PROJECT_OLDEST_SUPPORTED,
  currentVersion = PROJECT_CURRENT_VERSION,
  edges = EDGES,
} = {}) {
  const cat = validateCatalog({ currentVersion, oldestSupported, edges })
  if (!cat.ok) return { ok: false, error: { code: 'internal', message: '迁移目录非法', details: cat.errors } }

  const from = versionOf(doc)
  if (from == null) return { ok: false, error: { code: 'bad_request', message: '工程没有可识别的格式版本', hint: '缺 version 或 spec 字段' } }
  if (from > currentVersion) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: `这份工程由更新的版本保存（格式 v${from}），本版本最高读到 v${currentVersion}`,
        hint: '用保存它的那个版本打开，或升级应用；不要用旧版覆盖保存',
        retryable: false,
      },
    }
  }
  if (from < oldestSupported) {
    return {
      ok: false,
      error: { code: 'unsupported', message: `格式 v${from} 太旧，本版本最低支持 v${oldestSupported}`, hint: '先用中间版本升一次' },
    }
  }
  if (target > currentVersion) {
    return { ok: false, error: { code: 'bad_request', message: `目标版本 v${target} 超出本版本支持的 v${currentVersion}` } }
  }

  let cur = doc
  let v = from
  const applied = []
  while (v < target) {
    const edge = edges.find((e) => e.from === v)
    if (!edge) return { ok: false, error: { code: 'internal', message: `缺 v${v} → v${v + 1} 的迁移边` } }
    try {
      cur = edge.run(cur)
    } catch (e) {
      return { ok: false, error: { code: 'internal', message: `迁移 v${v}→v${v + 1} 失败：${e.message}` } }
    }
    applied.push(`v${v}→v${v + 1}${edge.summary ? ` (${edge.summary})` : ''}`)
    v += 1
  }
  return { ok: true, doc: cur, from, to: v, applied }
}

/** 读取并迁移一份工程文件（CLI/服务端入口）。 */