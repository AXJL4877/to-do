/**
 * node scripts/todo-live-ctl.mjs dump|clean|accept|seek|shot [id|seconds]
 */
import { createServer } from "node:http"
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const publicTrigger = path.join(root, "public", "koubo-live-trigger.json")
const outDir = path.join(root, "native/test-output/spongebob-koubo")
const reportPath = path.join(outDir, "LIVE_CTL_REPORT.json")
const snapPath = path.join(outDir, "PROJECT_SNAPSHOT.json")
const shotsDir = path.join(outDir, "shots")

const action = (process.argv[2] || "dump").toLowerCase()
const arg3 = process.argv[3]
const seekT = action === "seek" || action === "shot" ? Number(arg3 || 0) : 0
const id = action === "seek" || action === "shot" ? "p_mvmin_wipe1" : (arg3 || "p_mvmin_wipe1")
if (!["dump", "clean", "accept", "seek", "shot"].includes(action)) {
  console.error("usage: node scripts/todo-live-ctl.mjs dump|clean|accept|seek|shot [id|seconds]")
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(shotsDir, { recursive: true })
if (existsSync(reportPath)) unlinkSync(reportPath)
const REPORT_PORT = 17973
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return }
  if (req.method === "POST" && req.url === "/report") {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      writeFileSync(reportPath, text)
      try {
        const j = JSON.parse(text)
        if (j.project || action === "dump") {
          writeFileSync(snapPath, JSON.stringify({
            at: j.at, action: j.action, project: j.project, clips: j.clips, checks: j.checks,
          }, null, 2))
        }
        if (j.shotDataUrl && String(j.shotDataUrl).startsWith("data:image")) {
          const b64 = String(j.shotDataUrl).replace(/^data:image\/\w+;base64,/, "")
          const tag = String(j.checks?.find((c) => c.detail?.includes("t="))?.detail || `t_${seekT}`).replace(/[^\d.]+/g, "_")
          const shotFile = path.join(shotsDir, `preview_${String(seekT).replace(".", "_")}.png`)
          writeFileSync(shotFile, Buffer.from(b64, "base64"))
          console.log(JSON.stringify({ shotSaved: shotFile, bytes: Buffer.from(b64, "base64").length, tag }))
          // strip huge dataUrl from console dump
          j.shotDataUrl = `[saved ${shotFile}]`
          writeFileSync(reportPath, JSON.stringify(j, null, 2))
          console.log(JSON.stringify(j))
        } else {
          console.log(text.length > 4000 ? text.slice(0, 4000) + "…" : text)
        }
      } catch {
        console.log(text.slice(0, 2000))
      }
      res.statusCode = 200
      res.setHeader("Content-Type", "application/json")
      res.end('{"ok":true}')
      try {
        const j = JSON.parse(text)
        server.close(() => process.exit(j.ok ? 0 : 1))
      } catch {
        server.close(() => process.exit(1))
      }
    })
    return
  }
  res.statusCode = 404
  res.end("not found")
})

await new Promise((resolve, reject) => {
  server.listen(REPORT_PORT, "127.0.0.1", resolve)
  server.on("error", reject)
})

writeFileSync(publicTrigger, JSON.stringify({
  action, id, t: seekT, nonce,
  reportUrl: `http://127.0.0.1:${REPORT_PORT}/report`,
  at: new Date().toISOString(),
}, null, 2))
console.log(JSON.stringify({ triggered: true, action, id, t: seekT, nonce }))

setTimeout(() => {
  console.error("timeout")
  try { unlinkSync(publicTrigger) } catch {}
  server.close(() => process.exit(1))
}, 60000)
