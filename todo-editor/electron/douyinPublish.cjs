/**
 * 内置抖音发布台：inbox 扫描 + 投放 + ADB 填稿（publish.py）。
 * 不依赖外部「数据系列板报」；可选 DOUYIN_PUBLISH_ROOT 覆盖根目录。
 * 硬锁：永不点「发作品」。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { app, shell } = require('electron')

const VIDEO_NAMES = ['video.mp4', 'video.webm', 'video.mov']
const COVER_V = ['cover-3x4.png', 'cover-3x4.jpg', 'cover-3x4.webp']
const COVER_H = ['cover-4x3.png', 'cover-4x3.jpg', 'cover-4x3.webp']
const AVATAR_NAMES = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp']
const BACKGROUND_NAMES = ['background.png', 'background.jpg', 'background.jpeg', 'background.webp', 'profile-bg.png', 'profile-bg.jpg']
const FIXED = new Set([...VIDEO_NAMES, ...COVER_V, ...COVER_H, ...AVATAR_NAMES, ...BACKGROUND_NAMES, 'meta.json', 'readme.txt', 'cover.png'])
const OTHER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'])
const SLUG_PARTS = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)-(.+)$/

function bundledRoot() {
  // 打包：extraResources/douyin-publish；开发：仓库旁
  if (app?.isPackaged) {
    const res = path.join(process.resourcesPath, 'douyin-publish')
    if (fs.existsSync(path.join(res, 'publish.py'))) return res
  }
  const beside = path.join(__dirname, '..', 'douyin-publish')
  if (fs.existsSync(path.join(beside, 'publish.py'))) return beside
  return beside
}

function resolveRoot(override) {
  const fromEnv = process.env.DOUYIN_PUBLISH_ROOT || process.env.TODO_DOUYIN_ROOT
  for (const c of [override, fromEnv].filter(Boolean)) {
    const root = path.resolve(String(c))
    if (fs.existsSync(path.join(root, 'publish.py'))) return root
    if (fs.existsSync(path.join(root, 'douyin-publish', 'publish.py'))) {
      return path.join(root, 'douyin-publish')
    }
  }
  return bundledRoot()
}

function paths(rootOverride) {
  const root = resolveRoot(rootOverride)
  const inbox = path.join(root, 'archive', 'inbox')
  return {
    root,
    inbox,
    publishPy: path.join(root, 'publish.py'),
    config: path.join(root, 'config.json'),
    selectors: path.join(root, 'selectors.json'),
  }
}

function ensureInbox(p) {
  fs.mkdirSync(p.inbox, { recursive: true })
  const readme = path.join(p.inbox, 'README.txt')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '一条资产 = 一个子文件夹（不要用 _ 或 . 开头）。',
      '  video.mp4 / cover-3x4.png / meta.json …',
      '封面大标题须生图画进画面，禁止后期贴字。',
      '详见 ARCHIVE.md。',
      '',
    ].join('\n'), 'utf8')
  }
}

function sanitizeSlug(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return s.slice(0, 80) || `manual-${Date.now()}`
}

function posix(p) {
  return String(p).replace(/\\/g, '/')
}

function named(folder, names) {
  for (const n of names) {
    const p = path.join(folder, n)
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

function pickVideo(folder) {
  const hit = named(folder, VIDEO_NAMES)
  if (hit) return hit
  const vids = fs.readdirSync(folder)
    .map((n) => path.join(folder, n))
    .filter((p) => fs.statSync(p).isFile() && /\.(mp4|webm|mov)$/i.test(p))
  return vids[0] || null
}

function listOther(folder) {
  const rows = []
  const seen = new Set()
  const add = (p, urlName) => {
    const key = urlName.toLowerCase()
    if (seen.has(key) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return
    if (!OTHER_EXTS.has(path.extname(p).toLowerCase())) return
    seen.add(key)
    rows.push({
      name: path.basename(p),
      rel: `other/${urlName}`,
      path: posix(p),
      bytes: fs.statSync(p).size,
    })
  }
  const otherDir = path.join(folder, 'other')
  if (fs.existsSync(otherDir) && fs.statSync(otherDir).isDirectory()) {
    for (const n of fs.readdirSync(otherDir).sort()) {
      if (n.startsWith('.') || n.startsWith('_')) continue
      add(path.join(otherDir, n), n)
    }
  }
  for (const n of fs.readdirSync(folder).sort()) {
    if (n.startsWith('.') || n.startsWith('_')) continue
    if (FIXED.has(n.toLowerCase()) || FIXED.has(n)) continue
    const p = path.join(folder, n)
    if (!fs.statSync(p).isFile()) continue
    if (FIXED.has(n.toLowerCase())) continue
    add(p, n)
  }
  return rows
}

function folderAsset(folder) {
  const slug = path.basename(folder)
  let meta = {}
  const mp = path.join(folder, 'meta.json')
  if (fs.existsSync(mp)) {
    try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')) } catch { meta = {} }
  }
  const video = pickVideo(folder)
  const cover = named(folder, COVER_V)
  const land = named(folder, COVER_H)
  const avatar = named(folder, AVATAR_NAMES)
  const background = named(folder, BACKGROUND_NAMES)
  const others = listOther(folder)
  let date = '', session = '', board = ''
  const m = SLUG_PARTS.exec(slug)
  if (m) {
    date = m[1]
    session = m[2] === 'na' ? '' : m[2]
    board = m[3]
  }
  let tags = meta.tags || []
  if (typeof tags === 'string') tags = tags.split(/[\s,#]+/).filter(Boolean)
  const fileUrl = (p) => (p ? pathToFileURL(p).href : '')
  return {
    id: slug,
    slug,
    folder: posix(folder),
    kind: video ? 'video' : 'images',
    board: meta.board || board,
    trade_date: meta.trade_date || date,
    session: meta.session || session,
    title: meta.title || slug,
    caption: meta.caption || '',
    tags,
    video_path: video ? posix(video) : '',
    cover_path: cover ? posix(cover) : '',
    cover_url: fileUrl(cover),
    cover_landscape_path: land ? posix(land) : '',
    avatar_path: avatar ? posix(avatar) : '',
    background_path: background ? posix(background) : '',
    others,
    other_paths: others.map((o) => o.path),
    video_bytes: video ? fs.statSync(video).size : 0,
    updated_at: fs.statSync(folder).mtimeMs,
  }
}

function readDraft(rootOverride) {
  const p = paths(rootOverride)
  if (!fs.existsSync(p.config)) return null
  try {
    return JSON.parse(fs.readFileSync(p.config, 'utf8'))
  } catch {
    return null
  }
}

function matchSlugFromDraft(draft, assets) {
  if (!draft || !assets?.length) return null
  if (draft.slug) {
    const hit = assets.find((a) => a.slug === draft.slug)
    if (hit) return hit.slug
  }
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase()
  const video = norm(draft.video)
  const cover = norm(draft.cover)
  if (video) {
    const hit = assets.find((a) => norm(a.video_path) === video)
    if (hit) return hit.slug
  }
  if (cover) {
    const hit = assets.find((a) => norm(a.cover_path) === cover)
    if (hit) return hit.slug
  }
  return null
}

function listAssets(rootOverride) {
  const p = paths(rootOverride)
  ensureInbox(p)
  const assets = []
  for (const name of fs.readdirSync(p.inbox)) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const folder = path.join(p.inbox, name)
    if (!fs.statSync(folder).isDirectory()) continue
    const a = folderAsset(folder)
    if (!a.video_path && !a.cover_path && !a.cover_landscape_path && !a.avatar_path && !a.background_path && !a.others.length) continue
    assets.push(a)
  }
  assets.sort((a, b) => b.updated_at - a.updated_at)
  return { ok: true, drop: posix(p.inbox), assets, builtin: true }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function coverName(src, base) {
  const ext = path.extname(src).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.png') {
    return `${base}${ext === '.jpeg' ? '.jpg' : ext}`
  }
  return `${base}.png`
}

function todayYmd() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function writeConfig(p, draft) {
  let cur = {}
  if (fs.existsSync(p.config)) {
    try { cur = JSON.parse(fs.readFileSync(p.config, 'utf8')) } catch { cur = {} }
  }
  const next = { ...cur, ...draft }
  fs.writeFileSync(p.config, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function useAsset(slug, rootOverride) {
  const p = paths(rootOverride)
  const folder = path.join(p.inbox, sanitizeSlug(slug))
  if (!fs.existsSync(folder)) return { ok: false, error: `资产不存在：${slug}` }
  const a = folderAsset(folder)
  const draft = {
    slug: a.slug,
    title: a.title,
    caption: a.caption,
    tags: a.tags,
    video: a.video_path.replace(/\//g, path.sep),
    cover: a.cover_path.replace(/\//g, path.sep),
    coverLandscape: a.cover_landscape_path.replace(/\//g, path.sep),
    avatar: a.avatar_path.replace(/\//g, path.sep),
    background: a.background_path.replace(/\//g, path.sep),
    others: a.other_paths.map((x) => x.replace(/\//g, path.sep)),
  }
  writeConfig(p, draft)
  return { ok: true, slug: a.slug, draft, asset: a }
}

async function stageAsset(opts = {}) {
  const p = paths(opts.root)
  if (!fs.existsSync(p.publishPy)) {
    return { ok: false, error: `内置发布脚本缺失：${p.publishPy}` }
  }
  ensureInbox(p)
  const metaIn = opts.meta && typeof opts.meta === 'object' ? opts.meta : {}
  const tradeDate = String(metaIn.trade_date || todayYmd())
  const board = String(metaIn.board || 'manual')
  const titlePart = sanitizeSlug(metaIn.title || board).slice(0, 40)
  const slug = sanitizeSlug(opts.slug || `${tradeDate}-${titlePart || board}`)
  const destDir = path.join(p.inbox, slug)
  fs.mkdirSync(destDir, { recursive: true })

  const wrote = []
  if (opts.videoPath) {
    if (!fs.existsSync(opts.videoPath)) return { ok: false, error: `找不到成片：${opts.videoPath}` }
    const ext = path.extname(opts.videoPath).toLowerCase() || '.mp4'
    const finalVideo = path.join(destDir, ext === '.webm' || ext === '.mov' ? `video${ext}` : 'video.mp4')
    copyFile(opts.videoPath, finalVideo)
    wrote.push(path.basename(finalVideo))
  }
  if (opts.coverPath) {
    if (!fs.existsSync(opts.coverPath)) return { ok: false, error: `找不到封面：${opts.coverPath}` }
    const dest = path.join(destDir, coverName(opts.coverPath, 'cover-3x4'))
    copyFile(opts.coverPath, dest)
    wrote.push(path.basename(dest))
  }
  if (opts.coverLandscapePath) {
    if (!fs.existsSync(opts.coverLandscapePath)) return { ok: false, error: `找不到横封面` }
    copyFile(opts.coverLandscapePath, path.join(destDir, coverName(opts.coverLandscapePath, 'cover-4x3')))
    wrote.push('cover-4x3')
  }
  if (opts.avatarPath && fs.existsSync(opts.avatarPath)) {
    copyFile(opts.avatarPath, path.join(destDir, `avatar${path.extname(opts.avatarPath) || '.png'}`))
    wrote.push('avatar')
  }
  if (opts.backgroundPath && fs.existsSync(opts.backgroundPath)) {
    copyFile(opts.backgroundPath, path.join(destDir, `background${path.extname(opts.backgroundPath) || '.png'}`))
    wrote.push('background')
  }
  if (!wrote.length) return { ok: false, error: '至少需要成片或封面之一' }

  const meta = {
    title: String(metaIn.title || slug),
    caption: String(metaIn.caption || `${metaIn.title || slug}。仅供参考，不构成投资建议。`),
    tags: Array.isArray(metaIn.tags) ? metaIn.tags.map(String) : ['财经'],
    board,
    trade_date: tradeDate,
  }
  fs.writeFileSync(path.join(destDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  wrote.push('meta.json')

  let selected = null
  if (opts.useAsset !== false) selected = useAsset(slug, opts.root)

  return {
    ok: true,
    slug,
    dir: destDir,
    wrote,
    meta,
    draft: selected?.draft,
    builtin: true,
    note: '已投放到本机发布台资产库。「发作品」请你自己点。',
  }
}

async function attachCover(opts) {
  const p = paths(opts.root)
  const slug = sanitizeSlug(opts.slug)
  const destDir = path.join(p.inbox, slug)
  if (!fs.existsSync(destDir)) return { ok: false, error: `资产不存在：${slug}` }
  if (!opts.coverPath || !fs.existsSync(opts.coverPath)) return { ok: false, error: '找不到封面文件' }
  const dest = path.join(destDir, coverName(opts.coverPath, 'cover-3x4'))
  copyFile(opts.coverPath, dest)
  if (opts.useAsset !== false) useAsset(slug, opts.root)
  return { ok: true, slug, path: dest }
}

function saveAssetMeta(opts = {}) {
  const p = paths(opts.root)
  const slug = sanitizeSlug(opts.slug)
  const destDir = path.join(p.inbox, slug)
  if (!fs.existsSync(destDir)) return { ok: false, error: `资产不存在：${slug}` }
  const mp = path.join(destDir, 'meta.json')
  let cur = {}
  if (fs.existsSync(mp)) {
    try { cur = JSON.parse(fs.readFileSync(mp, 'utf8')) } catch { cur = {} }
  }
  const metaIn = opts.meta && typeof opts.meta === 'object' ? opts.meta : {}
  const tagsRaw = metaIn.tags != null ? metaIn.tags : cur.tags
  let tags = tagsRaw
  if (typeof tags === 'string') tags = tags.split(/[\s,#，,]+/).filter(Boolean)
  if (!Array.isArray(tags)) tags = []
  const meta = {
    ...cur,
    title: String(metaIn.title != null ? metaIn.title : (cur.title || slug)),
    caption: String(metaIn.caption != null ? metaIn.caption : (cur.caption || '')),
    tags: tags.map(String).filter(Boolean),
    board: String(metaIn.board != null ? metaIn.board : (cur.board || 'manual')),
    trade_date: String(metaIn.trade_date != null ? metaIn.trade_date : (cur.trade_date || todayYmd())),
  }
  delete meta.session
  fs.writeFileSync(mp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  const selected = useAsset(slug, opts.root)
  return { ok: true, slug, meta, draft: selected.draft, asset: selected.asset }
}

function revealInbox(rootOverride) {
  const p = paths(rootOverride)
  ensureInbox(p)
  shell.openPath(p.inbox)
  return { ok: true, inbox: p.inbox, builtin: true }
}

function status(rootOverride) {
  const p = paths(rootOverride)
  ensureInbox(p)
  const listed = listAssets(rootOverride)
  const draft = readDraft(rootOverride)
  const selectedSlug = matchSlugFromDraft(draft, listed.assets)
  return {
    ok: true,
    builtin: true,
    root: p.root,
    inbox: p.inbox,
    publishOk: fs.existsSync(p.publishPy),
    draft: draft || undefined,
    selectedSlug: selectedSlug || undefined,
    assetCount: listed.assets.length,
    desk: { ok: true, note: '内置面板，无需外部 desk' },
    archive: { ok: true, note: '内置扫描' },
  }
}

function pythonBin() {
  const local = process.env.USERPROFILE
    && path.join(process.env.USERPROFILE, 'AppData/Local/Programs/Python/Python314/python.exe')
  if (local && fs.existsSync(local)) return local
  return 'python'
}

function runPublish(opts) {
  const p = paths(opts.root)
  if (!fs.existsSync(p.publishPy)) {
    return Promise.resolve({ ok: false, error: '找不到内置 publish.py' })
  }
  // publish.py：-s 必须在子命令前；json 子命令 phones|push|fill|stage|…
  let action = String(opts.action || 'phones')
  if (action === 'status') action = 'phones'
  const args = ['-X', 'utf8', p.publishPy]
  const serial = opts.serial ? String(opts.serial).trim() : ''
  if (serial && serial !== '-s') args.push('-s', serial)
  args.push('json', action)
  const extraPath = [
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData/Local/Microsoft/WinGet/Links'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData/Local/Android/Sdk/platform-tools'),
  ].filter(Boolean).join(path.delimiter)

  return new Promise((resolve) => {
    const child = spawn(pythonBin(), args, {
      cwd: p.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: extraPath + path.delimiter + (process.env.PATH || ''),
      },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, error: 'publish.py 超时' })
    }, 120000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message || String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      const briefErr = () => {
        const t = (err || out).trim()
        const m = t.match(/CalledProcessError:[^\n]+/)
          || t.match(/error:\s*.+$/im)
          || t.match(/找不到[^\n]+/)
        return (m ? m[0] : t).slice(-400) || `publish.py 退出码 ${code}`
      }
      try {
        const j = JSON.parse(line || '{}')
        if (code !== 0 || j.ok === false) {
          resolve({
            ok: false,
            ...j,
            code,
            error: String(j.error || briefErr()),
            stderr: err.slice(-500),
          })
          return
        }
        resolve({ ok: true, ...j, code, stderr: err.slice(-500) })
      } catch {
        resolve({
          ok: false,
          code,
          raw: out.slice(-2000),
          error: briefErr(),
          stderr: err.slice(-500),
        })
      }
    })
  })
}

/** 兼容旧 API：不再开外部 desk */
async function openDesk(rootOverride) {
  const p = paths(rootOverride)
  ensureInbox(p)
  return {
    ok: true,
    builtin: true,
    inbox: p.inbox,
    note: '已内置到编辑器「抖音」面板，无需外部发布台网页',
  }
}

module.exports = {
  stageAsset,
  openDesk,
  status,
  listAssets,
  useAsset,
  attachCover,
  saveAssetMeta,
  revealInbox,
  runPublish,
  readDraft,
  paths,
  resolveRoot,
  writeConfig,
}
