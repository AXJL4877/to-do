// 列出页面加载过的 /src/ 模块，找到 store 的确切 URL
const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/src/'))
const store = urls.filter((n) => /store\.(ts|tsx|js)/.test(n))
return JSON.stringify({ storeUrls: store, sample: urls.slice(0, 12), total: urls.length }, null, 2)
