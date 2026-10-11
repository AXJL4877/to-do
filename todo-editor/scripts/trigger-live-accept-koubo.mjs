/**
 * 在「当前已打开的 Electron TO DO」上触发实机验收。
 * 1) 起本机回报端口
 * 2) 写 public/koubo-live-trigger.json（Vite 立刻可取）
 * 3) 等待渲染层 POST 报告
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicTrigger = path.join(root, 'public', 'koubo-live-trigger.json')
const reportPath = path.join(root, 'native/test-output/spongebob-koubo/LIVE_ACCEPT_REPORT.json')
const id = process.argv[2] || 'p_mv1x27lf_pchr'
const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

mkdirSync(path.dirname(reportPath), { recursive: true })
if (existsSync(reportPath)) unlinkSync(reportPath)

const REPORT_PORT = 17973

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method === 'POST' && req.url === '/report') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      writeFileSync(reportPath, text)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
      console.log(text)
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
  res.end('not found')
})

await new Promise((resolve, reject) => {
  server.listen(REPORT_PORT, '127.0.0.1', resolve)
  server.on('error', reject)
})

writeFileSync(publicTrigger, JSON.stringify({
  id,
  nonce,
  reportUrl: `http://127.0.0.1:${REPORT_PORT}/report`,
  at: new Date().toISOString(),
}, null, 2))

console.log(JSON.stringify({ triggered: true, id, nonce, reportUrl: `http://127.0.0.1:${REPORT_PORT}/report` }))

// 把 TO DO 窗口置前，方便你看见操作
try {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$target = [IntPtr]::Zero
[W]::EnumWindows({
  param($h,$l)
  if ([W]::IsWindowVisible($h)) {
    $sb = New-Object Text.StringBuilder 256
    [void][W]::GetWindowText($h, $sb, 256)
    if ($sb.ToString() -match 'TO DO' -and $sb.ToString() -notmatch 'Cursor') {
      $script:target = $h
    }
  }
  return $true
}, [IntPtr]::Zero)
if ($target -ne [IntPtr]::Zero) {
  [W]::ShowWindow($target, 9) | Out-Null
  [W]::SetForegroundWindow($target) | Out-Null
  'foreground ok'
} else { 'window not found' }
`
  const { spawnSync } = await import('node:child_process')
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
} catch { /* */ }

setTimeout(() => {
  console.error('timeout: 60s 内未收到实机验收报告。请确认 electron:dev 主窗口已热更新（看是否出现 toast）。')
  try { unlinkSync(publicTrigger) } catch { /* */ }
  server.close(() => process.exit(1))
}, 60000)
