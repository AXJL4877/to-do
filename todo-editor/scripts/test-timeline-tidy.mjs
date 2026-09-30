import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'todo-timeline-test-'))
try {
  const outfile = join(dir, 'tests.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../tests/timeline-tidy.test.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
