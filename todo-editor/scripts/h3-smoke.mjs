import path from 'node:path'
import { ensureH3, h3Download, h3Generate } from '../server/h3Client.mjs'

const t0 = Date.now()
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
await ensureH3(log)
const { url } = await h3Generate({
  prompt: 'A hand-drawn stick figure picks up a glass of water and drinks it, simple white background, marker lines.',
  seconds: 5,
  qualityMp: 0.4,
}, log)
const out = await h3Download(url, path.resolve(process.argv[2] || 'h3-smoke.mp4'))
log(`done ${out}`)
