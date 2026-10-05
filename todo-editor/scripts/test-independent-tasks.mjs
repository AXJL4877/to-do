import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['src/lib/independentTasks.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { runIndependentTasks } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
let finishCover
const cover = new Promise(resolve => { finishCover = resolve })
const events = []
const task = (name, run) => ({ run, onSuccess: value => events.push(`${name}:${value}`), onError: () => events.push(`${name}:error`), onFinally: () => events.push(`${name}:idle`) })
const done = runIndependentTasks([task('meta', () => Promise.resolve('ready')), task('cover', () => cover)])
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(events, ['meta:ready', 'meta:idle'], 'fast result should be available before cover finishes')
finishCover('ready')
await done
assert.deepEqual(events, ['meta:ready', 'meta:idle', 'cover:ready', 'cover:idle'])
events.length = 0
await runIndependentTasks([task('meta', () => Promise.reject(new Error('offline'))), task('cover', () => Promise.resolve('ready'))])
assert.ok(events.includes('meta:error') && events.includes('cover:ready'), 'one failure must not discard sibling result')
console.log('independent tasks: immediate completion and partial failure passed')
