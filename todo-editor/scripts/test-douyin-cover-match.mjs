/**
 * 抖音封面：按口播文案纯文生图；不得要求参考帧；空参考不得进 edits。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { buildDouyinCoverPrompt } = require('../server/douyinMetaAi.mjs')
const { buildImageRequest } = require('../server/huniuClient.mjs')

const prompt = buildDouyinCoverPrompt({
  title: '工资怎么存',
  styleHint: '',
  script: '先留生活费，再建立应急储备。不必一次完美。',
})
assert.match(prompt, /工资怎么存/, 'title painted into cover')
assert.match(prompt, /先留生活费/, 'spoken script drives subject')
assert.match(prompt, /text-to-image only/i, 'must forbid reference remix')
assert.doesNotMatch(prompt, /reference still/i, 'must not ask for video still')
assert.doesNotMatch(prompt, /Edit\/compose from the reference/i, 'must not be img2img')

const empty = buildImageRequest({ model: 'gpt-image-2', prompt: 'x', size: '3:4', quality: '1K', imageDataUrl: '' })
assert.equal(empty.path, '/v1/images/generations')

const STUB = `
export const useApp = { getState() { return { projectName: '', script: '', scriptMemo: null, publishSeed: null, scriptWorkspace: null, settings: {} } } }
export function aiFetch() { return Promise.resolve(new Response('{}')) }
export function aiUrl(x) { return x }
export function desktop() { return null }
export function getProduction() { return Promise.resolve({}) }
export function readSpokenBody(s) { return s || '' }
`

const outDir = resolve(root, '../native/test-output/douyin-cover')
mkdirSync(outDir, { recursive: true })
const bundle = await build({
  entryPoints: [resolve(root, '../src/lib/douyinPublishAi.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'stub-locals',
    setup(esbuild) {
      esbuild.onResolve({ filter: /^(?:\.\/aiFetch|\.\/desktop|\.\/production|\.\/scriptMemoDocument|\.\.\/store)$/ }, args => ({
        path: args.path,
        namespace: 'stub',
      }))
      esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
    },
  }],
})
const outFile = resolve(outDir, 'douyinPublishAi.mjs')
writeFileSync(outFile, bundle.outputFiles[0].text)
const { pickCoverStyleHint, STYLE_HINT, pickCoverHeadline } = await import(pathToFileURL(outFile).href)

assert.equal(pickCoverStyleHint({}), STYLE_HINT)
assert.equal(pickCoverHeadline({ formTitle: '封面标题', projectName: '工程名' }), '封面标题')

console.log('douyin cover match: script-driven text-to-image ok')
