/**
 * 参数 schema：作者侧 DSL → 标准 JSON Schema，以及入参校验。
 *
 * 为什么单独一个文件：HTTP 操作（capabilities）与命令注册表（core/commands）共用同一套参数 DSL——
 * 智能体看到的 schema 与执行时的校验必须是**同一份**，否则描述会与实际行为漂移。
 *
 * 作者写法：
 *   { 名字: 'string' | 'string?' | { type, required?, description?, enum?, minimum?, maximum?, items? } }
 * 编译规则（照 DSH 的 parameterSchemaSpecToJsonSchema）：
 *   - 逐属性的 required 收拢成根级 required 数组；
 *   - type 必须落在闭集里；
 *   - object 节点必须显式声明 additionalProperties（否则视为作者错误）。
 */
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'json'])

export const PARAM_TYPE_LIST = [...PARAM_TYPES]

export function compileParams(params) {
  if (params && params.type === 'object') {
    if (typeof params.additionalProperties !== 'boolean') {
      throw new Error('参数 schema 是 object 时必须显式声明 additionalProperties')
    }
    return params
  }
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(params ?? {})) {
    const informal = typeof spec === 'string' ? { type: spec } : { ...(spec ?? {}) }
    let type = String(informal.type ?? 'string')
    let isRequired = informal.required === true
    if (type.endsWith('?')) { type = type.slice(0, -1); isRequired = false }
    if (!PARAM_TYPES.has(type)) throw new Error(`参数 ${name} 的类型 ${type} 不在闭集里（${PARAM_TYPE_LIST.join('/')}）`)
    const node = { type }
    if (informal.description) node.description = informal.description
    if (informal.unit) node['x-unit'] = informal.unit
    if (informal.enum) node.enum = informal.enum
    if (informal.minimum != null) node.minimum = informal.minimum
    if (informal.maximum != null) node.maximum = informal.maximum
    if (type === 'array') node.items = informal.items ?? { type: 'string' }
    properties[name] = node
    if (isRequired) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

/**
 * 按编译后的 schema 校验入参。
 * @returns {{ok:true} | {ok:false, errors:Array<{path:string, message:string}>}}
 */
export function validateParams(schema, args, { at = 'params' } = {}) {
  const errors = []
  const s = schema ?? { type: 'object', properties: {}, additionalProperties: true }
  if (typeOf(args) !== 'object') return { ok: false, errors: [{ path: at, message: `参数必须是对象（得到 ${typeOf(args)}）` }] }

  for (const name of s.required ?? []) {
    if (args[name] === undefined) errors.push({ path: `${at}.${name}`, message: `缺少必填参数 ${name}` })
  }
  for (const [name, value] of Object.entries(args)) {
    const node = (s.properties ?? {})[name]
    if (!node) {
      if (s.additionalProperties === false) {
        errors.push({ path: `${at}.${name}`, message: `未知参数 ${name}；可接受：${Object.keys(s.properties ?? {}).join(', ') || '（无）'}` })
      }
      continue
    }
    if (value === undefined || value === null) continue
    const t = typeOf(value)
    const wantNumber = node.type === 'number' || node.type === 'integer'
    if (wantNumber && t !== 'number') { errors.push({ path: `${at}.${name}`, message: `${name} 必须是数字（得到 ${t}）` }); continue }
    if (!wantNumber && node.type !== 'json' && t !== node.type) {
      errors.push({ path: `${at}.${name}`, message: `${name} 必须是 ${node.type}（得到 ${t}）` })
      continue
    }
    if (node.type === 'integer' && !Number.isInteger(value)) errors.push({ path: `${at}.${name}`, message: `${name} 必须是整数` })
    if (node.enum && !node.enum.includes(value)) errors.push({ path: `${at}.${name}`, message: `${name} 只能是 ${node.enum.join(' / ')}` })
    if (node.minimum != null && typeof value === 'number' && value < node.minimum) errors.push({ path: `${at}.${name}`, message: `${name} 不能小于 ${node.minimum}` })
    if (node.maximum != null && typeof value === 'number' && value > node.maximum) errors.push({ path: `${at}.${name}`, message: `${name} 不能大于 ${node.maximum}` })
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}
