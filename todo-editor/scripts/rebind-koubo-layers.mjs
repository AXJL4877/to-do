/** @deprecated 请用 koubo_edit_bind.mjs（见 EDIT_WORKFLOW.md） */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const id = process.argv[2] || 'p_mv1x27lf_pchr'
console.error('[deprecated] rebind-koubo-layers.mjs → koubo_edit_bind.mjs')
const r = spawnSync(process.execPath, [path.join(here, 'koubo_edit_bind.mjs'), id], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})
process.exit(r.status ?? 1)
