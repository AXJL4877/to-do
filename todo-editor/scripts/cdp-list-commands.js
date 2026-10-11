// commands 是函数：调用它拿命令表，并打印与"删除片段"相关命令的参数形状
const b = window.__TODO_CMD__
let list = []
try { list = b.commands() || [] } catch (e) { return JSON.stringify({ err: String(e) }) }
const ids = list.map((c) => (typeof c === 'string' ? c : c.id))
const wanted = ids.filter((i) => /delete|remove|clear|track/i.test(String(i)))
const detail = list.filter((c) => wanted.includes(typeof c === 'string' ? c : c.id))
  .map((c) => ({ id: c.id, params: c.params || c.schema || c.args || null, summary: c.summary || c.title || '' }))
return JSON.stringify({ total: ids.length, wanted, detail: detail.slice(0, 8) }, null, 2)
