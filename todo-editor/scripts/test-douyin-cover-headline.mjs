import assert from 'node:assert/strict'
import { build } from 'esbuild'

const STUB = `
export const useApp = { getState() { return { projectName: '', script: '', scriptMemo: null, publishSeed: null, scriptWorkspace: null, settings: {} } } }
export function aiFetch() { return Promise.resolve(new Response('{}')) }
export function aiUrl(x) { return x }
export function desktop() { return null }
export function getProduction() { return Promise.resolve({}) }
export function readSpokenBody(s) { return s || '' }
`

const bundle = await build({
  entryPoints: ['src/lib/douyinPublishAi.ts'],
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
const { pickCoverHeadline, pickCoverStyleHint, STYLE_HINT } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

assert.equal(
  pickCoverHeadline({ formTitle: '新封面标题', projectName: '原始工程名', briefTitle: '口播兜底' }),
  '新封面标题',
  'form title must win over original project name',
)
assert.equal(
  pickCoverHeadline({ seedTitle: '种子标题', projectName: '原始工程名' }),
  '种子标题',
  'cover seed must win when form is still empty',
)
assert.equal(
  pickCoverHeadline({ projectName: '原始工程名' }),
  '原始工程名',
)
assert.equal(
  pickCoverStyleHint({ formHint: '黑板大字', briefHint: STYLE_HINT }),
  '黑板大字',
)
assert.equal(pickCoverStyleHint({}), STYLE_HINT)
console.log('douyin cover headline: form/seed beat original project name')
