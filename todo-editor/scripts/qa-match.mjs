const fs = require('fs')
const src = fs.readFileSync('src/lib/capabilityManifest.ts', 'utf8')
const items = []
const re = /\{\s*module:\s*(\d+),\s*moduleName:\s*'([^']+)',\s*feature:\s*'([^']+)',\s*selector:\s*'\[data-testid="([^"]+)"\]'(?:,\s*kind:\s*'([^']+)')?\s*\}/g
let m
while ((m = re.exec(src))) {
  items.push({ module: +m[1], moduleName: m[2], feature: m[3], id: m[4], kind: m[5] || 'click' })
}
const seen = new Set(JSON.parse(fs.readFileSync('qa-all-testids.json', 'utf8')))
const pass = items.filter((i) => seen.has(i.id))
const fail = items.filter((i) => !seen.has(i.id))
const byMod = {}
for (const i of items) {
  byMod[i.module] ??= { name: i.moduleName, pass: 0, total: 0, fail: [] }
  byMod[i.module].total++
  if (seen.has(i.id)) byMod[i.module].pass++
  else byMod[i.module].fail.push(i.feature + ':' + i.id)
}
console.log(JSON.stringify({ total: items.length, pass: pass.length, fail: fail.map((f) => f.id), byMod }, null, 2))
