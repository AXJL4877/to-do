/**
 * preserveSource：生成时调用包内（或可选 env 指向的）工作流入口。
 * 不写 env 时，入口相对已安装技能包目录；产物写到 KOUBO_WORK（成片 outDir）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveFfmpeg, resolveFfprobe } from '../animBuild.mjs'
import { cleanScript, timingPhrases } from '../skillPacks.mjs'
import { pythonEnv, resolveMishiRoot, resolvePython, resolveTtsTimelineRoot } from '../toolRoots.mjs'
import { fileExists, newElement, newSegment, nextId, pickedVariant, stableHash } from './doc.mjs'
import { render, storyboard, voice } from './layers.mjs'

const jobs = new Map()

export function cancelSourceWorkflow(id) {
  jobs.get(id)?.kill()
}

export function sourceCanceled() {
  const e = new Error('已停止')
  e.sourceCanceled = true
  return e
}

export function resolveSourceRoot(spec, packDir) {
  let root
  if (spec.env) {
    const raw = process.env[spec.env]
    if (!raw || !String(raw).trim()) {
      throw new Error(`未设置 ${spec.env}。把该环境变量指到含 ${spec.entry} 的目录，或把工作流打进扩展包并去掉 preserveSource.env。`)
    }
    root = path.resolve(String(raw))
  } else {
    if (!packDir) throw new Error('技能包目录未知，无法启动包内工作流')
    root = path.resolve(packDir)
  }
  const entry = path.resolve(root, spec.entry)
  if (!entry.startsWith(root + path.sep)) throw new Error('工作流入口超出包目录')
  if (!existsSync(entry)) throw new Error(`包内没有 ${spec.entry}`)
  return { root, entry }
}

/** 失败时优先展示含 error / JSON 的末行，避免只截到命令路径尾巴 */
function summarizeProcessTail(tail) {
  const text = String(tail || '').trim()
  if (!text) return '无输出'
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hit = [...lines].reverse().find((l) => /error|失败|Traceback|Error|必须|找不到/i.test(l) && !/^\+\s/.test(l))
  const pick = hit || lines.at(-1) || text
  return pick.slice(-500)
}

function runProcess(cmd, args, { cwd, env, timeoutMs, onLine, canceled, docId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...env },
    })
    jobs.set(docId, child)
    let tail = ''
    const take = (buf) => {
      const s = buf.toString('utf8')
      tail = (tail + s).slice(-4000)
      const line = s.split(/\r?\n/).filter(Boolean).at(-1)
      if (line) onLine(line.slice(0, 180))
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => { child.kill(); reject(new Error('工作流超时')) }, timeoutMs)
    const poll = setInterval(() => { if (canceled()) child.kill() }, 400)
    const finish = () => { clearTimeout(timer); clearInterval(poll); jobs.delete(docId) }
    child.on('error', (e) => { finish(); reject(e) })
    child.on('close', (code) => {
      finish()
      if (canceled()) reject(sourceCanceled())
      else if (code === 0) resolve()
      else reject(new Error(`工作流退出 ${code}：${summarizeProcessTail(tail)}`))
    })
  })
}

function ffmpeg(bin, args) {
  const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'ffmpeg 失败').trim().slice(-400))
}

function probeFilm(bin, file) {
  const r = spawnSync(bin, ['-hide_banner', '-i', file], { windowsHide: true, encoding: 'utf8' })
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const size = text.match(/(\d{3,5})x(\d{3,5})/)
  if (!d) throw new Error('读不到成片时长')
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: size ? Number(size[1]) : 1920,
    height: size ? Number(size[2]) : 1080,
  }
}

function slimTiming(raw) {
  return {
    duration: Number(raw?.duration) || 0,
    speaker: raw?.speaker ?? null,
    speech_rate: raw?.speech_rate ?? null,
    max_pause: raw?.max_pause ?? null,
    sentences: (raw?.sentences ?? []).map((s) => ({
      text: s.text, start: s.start, end: s.end,
      phrases: (s.phrases ?? []).map((p) => ({ text: p.text, start: p.start, end: p.end })),
    })),
  }
}

function mediaReady(ctx, seg) {
  if (!seg.voice || !fileExists(ctx.outDir, seg.voice.audio) || !fileExists(ctx.outDir, seg.voice.timing)) return false
  const boards = seg.boards || []
  if (!boards.length) return false
  return boards.every((b) => (b.render?.result?.elements || []).every((el) =>
    fileExists(ctx.outDir, el.video) && fileExists(ctx.outDir, el.hold)))
}

function copyOver(dir, from, to) {
  if (!from || from === to) return
  copyFileSync(path.join(dir, from), path.join(dir, to))
}

function restamp(ctx, seg) {
  const dir = ctx.outDir
  const vhash = voice.hash(ctx, seg)
  const names = voice.names(ctx, seg)
  copyOver(dir, seg.voice.audio, names.audio)
  copyOver(dir, seg.voice.timing, names.timing)
  seg.voice = { ...seg.voice, hash: vhash, audio: names.audio, timing: names.timing }
  seg.plan = {
    hash: storyboard.hash(ctx, seg), voiceHash: vhash, source: 'user',
    notes: seg.plan?.notes || '包内工作流成片',
  }
  for (const board of seg.boards || []) {
    const prev = board.render?.result
    if (!prev?.elements?.length) continue
    const window = { startMs: prev.startMs, endMs: prev.endMs }
    for (let i = 0; i < board.elements.length; i++) {
      const variant = pickedVariant(board.elements[i])
      const hold = prev.elements[i]?.hold
      if (variant && hold) { variant.source = 'upload'; variant.file = hold }
    }
    board.render = {
      hash: render.hash(ctx, seg, board, window),
      result: { ...prev, elements: prev.elements },
    }
  }
}

function resolveBgmPlan(work) {
  const paths = [
    path.join(work, '02_镜头设计', 'bgm_plan.json'),
    path.join(work, '04_动画渲染', 'output', 'bgm_plan.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      const plan = data?.bgm && typeof data.bgm === 'object' ? data.bgm : data
      if (Array.isArray(plan?.segments) && plan.segments.length) return plan
    } catch { /* next */ }
  }
  const design = path.join(work, '02_镜头设计', 'shots_design.json')
  if (existsSync(design)) {
    try {
      const data = JSON.parse(readFileSync(design, 'utf8'))
      if (Array.isArray(data?.bgm?.segments) && data.bgm.segments.length) return data.bgm
    } catch { /* */ }
  }
  return null
}

function resolveRefBgmFile(work, packDir, sourceName) {
  const name = path.basename(String(sourceName || ''))
  if (!name) return null
  const dirs = [
    path.join(work, 'ref_bgm'),
    path.join(work, '..', 'ref_bgm'),
    packDir ? path.join(packDir, 'workflow', 'ref_bgm') : '',
    packDir ? path.join(packDir, 'ref_bgm') : '',
  ].filter(Boolean)
  for (const d of dirs) {
    const hit = path.join(d, name)
    if (existsSync(hit)) return hit
  }
  return null
}

/** 按原管线 bgm_plan：片头 Holding Court → 中段精卫 → 后段 Memories，分轨入时间轴 */
function bindBgmPlan(ctx, seg, { work }) {
  const plan = work ? resolveBgmPlan(work) : null
  const packDir = ctx.entry?.dir || ''
  const dir = ctx.outDir
  const duration = Number(seg.voice?.duration) || Number(plan?.duration) || 0
  if (!plan?.segments?.length) {
    ctx.doc.sourceBgmPlan = null
    // 回退：整段 bed（仅当管线写出）
    const bedSrc = work ? path.join(work, '04_动画渲染', 'output', 'bgm_bed.wav') : ''
    if (bedSrc && existsSync(bedSrc)) {
      const st = statSync(bedSrc)
      const finger = stableHash({ bgm: 'bed', size: st.size, mtime: Math.round(st.mtimeMs || 0) })
      const bgmName = `${ctx.doc.id}_bgm_bed_${finger}.wav`
      copyFileSync(bedSrc, path.join(dir, bgmName))
      ctx.doc.sourceBgm = { file: bgmName, hash: finger, duration }
    } else {
      ctx.doc.sourceBgm = null
    }
    return
  }
  const segments = []
  for (const raw of plan.segments) {
    const id = String(raw.id || 'bgm')
    const srcPath = resolveRefBgmFile(work, packDir, raw.source)
    if (!srcPath) continue
    const start = Number(raw.start) || 0
    const end = Number(raw.end) || duration
    const span = Math.max(0.2, end - start)
    const ext = path.extname(srcPath) || '.mp3'
    const finger = stableHash({ id, source: path.basename(srcPath), start, end, vol: raw.volume })
    const file = `${ctx.doc.id}_bgm_${id}_${finger.slice(0, 12)}${ext}`
    copyFileSync(srcPath, path.join(dir, file))
    segments.push({
      id,
      file,
      source: path.basename(srcPath),
      start,
      end,
      duration: span,
      volume: Number(raw.volume) || 0.4,
      fade_in: Number(raw.fade_in) || 0,
      fade_out: Number(raw.fade_out) || 0,
      trim_start: Number(raw.trim_start) || 0,
      trim_dur: raw.trim_dur == null ? null : Number(raw.trim_dur),
      loop: !!raw.loop,
      hash: finger,
    })
  }
  const planHash = stableHash({ segs: segments.map((s) => s.hash) })
  ctx.doc.sourceBgmPlan = {
    hash: planHash,
    duration,
    policy: plan.policy || 'prescribed_holding_jingwei_memories_v2',
    notes: plan.notes || '片头 Holding Court → 中段精卫 → 后段 Memories',
    segments,
  }
  // 兼容旧验收：sourceBgm 指向第一段
  ctx.doc.sourceBgm = segments[0]
    ? { file: segments[0].file, hash: planHash, duration }
    : null
}

/** 只挂配音 + 字幕。与成片无关，所以可以在管线早期先接上（见 watchEarlyVoice）。
 *  voice.hash 仅由 seg.text + TTS 参数决定，因此这里算出的 audio/timing 文件名
 *  与之后 bindFilm 用**完全一致** —— 提前挂上不会产生第二份，后续原地替换即可。 */
function attachVoiceOnly(ctx, seg, { timing, work }) {
  const dir = ctx.outDir
  const vhash = voice.hash(ctx, seg)
  const names = voice.names(ctx, seg)
  const timingObj = slimTiming(timing)
  writeFileSync(path.join(dir, names.timing), JSON.stringify(timingObj))
  const phrases = timingPhrases(timingObj)
  if (!phrases.length) return null
  const ttsWav = work ? path.join(work, '01_口播试听', 'audio.wav') : ''
  if (!ttsWav || !existsSync(ttsWav)) return null
  copyFileSync(ttsWav, path.join(dir, names.audio))
  seg.voice = {
    hash: vhash, audio: names.audio, timing: names.timing,
    duration: Number(timingObj.duration) || phrases.at(-1).end,
    speaker: timingObj.speaker,
    phrases: phrases.map(({ text, start, end, sentence }) => ({ text, start, end, sentence })),
  }
  // 与 kit.render 一致：intro_red 句不铺白字幕，元素镜（scene 等）才有字幕
  const skipIntroSubs = workHasIntroRed(work)
  const subCues = phrases
    .filter((p) => !(skipIntroSubs && Number(p.sentence) === 0))
    .map(({ text, start, end }) => ({ text, start, end, keywords: [] }))
  seg.subtitles = {
    hash: stableHash({ timing: names.timing, kind: 'koubo-phrases', skipIntro: skipIntroSubs }),
    params: {},
    cues: subCues,
  }
  return phrases
}

function attachVoiceAndSubs(ctx, seg, { timing, film, duration, work }) {
  const dir = ctx.outDir
  const names = voice.names(ctx, seg)
  const timingObj = slimTiming(timing)
  if (!timingObj.duration) timingObj.duration = duration
  const phrases = attachVoiceOnly(ctx, seg, { timing: timingObj, work })
  if (!phrases) throw new Error('工作流没有返回可用的时间戳')
  const ff = resolveFfmpeg()
  if (!seg.voice) {
    // work/01 缺失时退回成片音轨
    const bare = work ? path.join(work, '04_动画渲染', 'output', '成片_无BGM前.mp4') : ''
    const voiceSrc = bare && existsSync(bare) ? bare : film
    if (String(voiceSrc).toLowerCase().endsWith('.wav')) {
      copyFileSync(voiceSrc, path.join(dir, names.audio))
    } else {
      ffmpeg(ff, ['-y', '-i', voiceSrc, '-vn', '-acodec', 'pcm_s16le', path.join(dir, names.audio)])
    }
    seg.voice = {
      hash: voice.hash(ctx, seg), audio: names.audio, timing: names.timing,
      duration: Number(timingObj.duration) || phrases.at(-1).end,
      speaker: timingObj.speaker,
      phrases: phrases.map(({ text, start, end, sentence }) => ({ text, start, end, sentence })),
    }
  }
  seg.plan = { hash: storyboard.hash(ctx, seg), voiceHash: voice.hash(ctx, seg), source: 'user', notes: '包内工作流成片' }
  bindBgmPlan(ctx, seg, { work })
  return { ff, phrases }
}

/**
 * 管线早期就把配音/字幕接上，不必等成片。
 *
 * 为什么需要：`preserveSource` 把整条管线交给一个长跑进程，而铺轨原先**只**发生在
 * 最后的 `bindFilm` 里。实测：TTS 在第 8 秒就产出 `01_口播试听/{audio.wav,timing.json}`，
 * 成片要到 6 分钟后才好 —— 于是整段时间时间轴一片空白，看起来像"连 TTS 都没入轨"。
 * 而本扩展自己的描述写的是"时间轴渐进入轨：先口播…"，即**本意就是渐进**。
 *
 * 前端每 2s 轮询成片文档并调 syncProduction，所以只要这里把 seg.voice 落盘并 save，
 * 配音片段就会自己流进时间轴。
 */
async function watchEarlyVoice(ctx, seg, work, { save, env, canceled }) {
  const timingFile = path.join(work, '01_口播试听', 'timing.json')
  const audioFile = path.join(work, '01_口播试听', 'audio.wav')
  const t0 = Date.now()
  while (Date.now() - t0 < 15 * 60 * 1000) {
    if (typeof canceled === 'function' && canceled()) return
    if (existsSync(timingFile) && existsSync(audioFile)) {
      try {
        const raw = JSON.parse(readFileSync(timingFile, 'utf8'))
        attachVoiceOnly(ctx, seg, { timing: raw, work })
        if (seg.voice) {
          save()
          env.phase('配音已入轨（元素与成片继续生成中）')
        }
        return
      } catch {
        return
      }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

function workHasIntroRed(work) {
  if (!work) return false
  const paths = [
    path.join(work, '02_镜头设计', 'shots_design.json'),
    path.join(work, '02_镜头设计', 'plan.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      const beat0 = data?.beats?.[0] || data?.shots?.[0]
      const vis = String(beat0?.visual || beat0?._visual || '')
      if (vis === 'intro_red' || vis === 'intro') return true
      if (Array.isArray(beat0?.intro_lines) && beat0.intro_lines.length) return true
      if (Array.isArray(data?.intro?.lines) && data.intro.lines.length) return true
    } catch { /* next */ }
  }
  return false
}

function copySourceFilm(ctx, seg, { ff, film, width, height }) {
  const dir = ctx.outDir
  const video = `${ctx.doc.id}_source_film.mp4`
  const hold = `${ctx.doc.id}_source_hold.png`
  ffmpeg(ff, ['-y', '-i', film, '-an', '-c:v', 'copy', path.join(dir, video)])
  ffmpeg(ff, ['-y', '-ss', '1', '-i', film, '-frames:v', '1', path.join(dir, hold)])
  ctx.doc.sourceFilm = {
    file: video,
    hold,
    width,
    height,
    duration: seg.voice.duration,
    hash: stableHash({ film: video, dur: seg.voice.duration }),
    note: '成片参照（对照用）；默认时间轴按原管线逐镜分层，不整片盖轨',
  }
  return { video, hold }
}

function bindFilmOnly(ctx, seg, { ff, film, width, height, video, hold }) {
  const fps = Number(ctx.doc.params.fps) || 30
  const el = newElement(ctx.doc, { at: 0, label: '成片', draw: 'original film', role: 'hero' }, 1)
  el.variants[0].source = 'upload'
  el.variants[0].file = hold
  const board = { id: nextId(ctx.doc, 'b'), start: 0, render: null, elements: [el] }
  const window = { startMs: 0, endMs: Math.round(seg.voice.duration * 1000) }
  const frames = Math.max(2, Math.round(seg.voice.duration * fps))
  board.render = {
    hash: render.hash(ctx, seg, board, window),
    result: {
      fps, width, height, startMs: window.startMs, endMs: window.endMs, layout: 'source',
      elements: [{
        id: el.id, label: el.label, video, hold,
        crop: [0, 0, width, height], startMs: 0, durationMs: window.endMs,
        frames, enter: 'cut',
      }],
    },
  }
  seg.boards = [board]
}

/** 分层可入轨：镜间连续、有非背景元素、媒体齐全。 */
function layersUsable(manifest, layerDir, durationMs) {
  const boards = [...(manifest.boards || [])].sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
  if (!boards.length) return false
  if ((boards[0].startMs || 0) > 80) return false
  for (let i = 1; i < boards.length; i++) {
    if ((boards[i].startMs || 0) - (boards[i - 1].endMs || 0) > 80) return false
  }
  const lastEnd = boards.at(-1).endMs || 0
  if (lastEnd < durationMs - 400) return false
  const els = boards.flatMap((b) => b.elements || [])
  if (!els.some((e) => e.role && e.role !== 'plate')) return false
  for (const e of els) {
    if (!e.hold || !e.video) return false
    if (!existsSync(path.join(layerDir, e.hold)) || !existsSync(path.join(layerDir, e.video))) return false
  }
  return true
}

export function bindLayerBoards(ctx, seg, { manifest, layerDir, width, height }) {
  const dir = ctx.outDir
  const fps = Number(manifest.fps) || Number(ctx.doc.params.fps) || 30
  const w = Number(manifest.width) || width
  const h = Number(manifest.height) || height
  const boards = []
  for (const mb of manifest.boards || []) {
    const elements = []
    const resultEls = []
    for (const raw of mb.elements || []) {
      const holdSrc = path.join(layerDir, raw.hold)
      const videoSrc = path.join(layerDir, raw.video)
      if (!existsSync(holdSrc) || !existsSync(videoSrc)) continue
      const holdName = `${ctx.doc.id}_${raw.id}_hold.png`
      // 保留原后缀（qtrle .mov 保 alpha；勿写死 .webm 否则透明变黑底）
      const vext = path.extname(raw.video) || '.mov'
      const videoName = `${ctx.doc.id}_${raw.id}${vext}`
      copyFileSync(holdSrc, path.join(dir, holdName))
      copyFileSync(videoSrc, path.join(dir, videoName))
      // 元素自带音效（泡泡转场原声）：一并收进产物目录，交给宿主落到独立音轨
      let sfxName = null
      if (raw.sfx) {
        const sfxSrc = path.join(layerDir, raw.sfx)
        if (existsSync(sfxSrc)) {
          sfxName = `${ctx.doc.id}_${raw.id}_sfx${path.extname(raw.sfx) || '.wav'}`
          copyFileSync(sfxSrc, path.join(dir, sfxName))
        } else {
          // 清单声明了音效但文件不在：以前静默丢掉，时间轴上表现为"音效缺失"且没有任何提示，
          // 只能靠人眼发现。这里至少留一行，让生成日志能指到具体元素和路径。
          console.warn(`[source-layers] 元素 ${raw.id} 声明了音效 ${raw.sfx}，但 ${sfxSrc} 不存在，该音效不会被入轨`)
        }
      }
      const el = newElement(ctx.doc, {
        at: 0,
        label: raw.label || raw.id,
        draw: raw.sourceName || raw.label || raw.id,
        role: raw.role || 'support',
      }, 1)
      el.variants[0].source = 'upload'
      el.variants[0].file = holdName
      elements.push(el)
      resultEls.push({
        id: el.id,
        label: el.label,
        video: videoName,
        hold: holdName,
        crop: raw.crop || [0, 0, w, h],
        startMs: Number(raw.startMs) || Number(mb.startMs) || 0,
        durationMs: Number(raw.durationMs) || Math.max(1, (mb.endMs || 0) - (mb.startMs || 0)),
        frames: Math.max(2, Number(raw.frames) || 8),
        enter: raw.enter || 'fade',
        ...(raw.chromaKey ? { chromaKey: raw.chromaKey } : {}),
        ...(sfxName ? { sfx: sfxName } : {}),
      })
    }
    if (!resultEls.length) continue
    const board = { id: nextId(ctx.doc, 'b'), start: 0, render: null, elements }
    const window = {
      startMs: Number(mb.startMs) || 0,
      endMs: Number(mb.endMs) || (Number(mb.startMs) || 0) + 200,
    }
    board.render = {
      hash: render.hash(ctx, seg, board, window),
      result: {
        fps, width: w, height: h,
        startMs: window.startMs, endMs: window.endMs,
        layout: 'source-layers',
        elements: resultEls,
      },
    }
    boards.push(board)
  }
  if (!boards.length) return false
  seg.boards = boards
  return true
}

export function bindFilm(ctx, seg, { timing, film, width, height, duration, work }) {
  const { ff } = attachVoiceAndSubs(ctx, seg, { timing, film, duration, work })
  const { video, hold } = copySourceFilm(ctx, seg, { ff, film, width, height })

  const manifestPath = work
    ? path.join(work, '04_动画渲染', 'output', 'layers_manifest.json')
    : ''
  let boundLayers = false
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const layerDir = path.join(work, '04_动画渲染', 'output', manifest.dir || 'layers')
      const durationMs = Math.round((seg.voice.duration || duration || 0) * 1000)
      if (layersUsable(manifest, layerDir, durationMs) && bindLayerBoards(ctx, seg, { manifest, layerDir, width, height })) {
        boundLayers = true
        const nEl = seg.boards.reduce((n, b) => n + (b.elements?.length || 0), 0)
        ctx.doc.sourceLayers = {
          available: true,
          bound: true,
          boards: seg.boards.length,
          elements: nEl,
          note: '渐进分层入轨：TTS → 逐镜 visual（intro_red/scene/…）→ 三段 BGM；成片见 sourceFilm 对照',
        }
      } else {
        const boards = manifest.boards || []
        ctx.doc.sourceLayers = {
          available: boards.length > 0,
          bound: false,
          boards: boards.length,
          elements: boards.reduce((n, b) => n + ((b.elements || []).length), 0),
          note: '分层未达入轨门槛（空隙/缺层/缺媒体），时间轴回退完整成片',
        }
      }
    } catch (e) {
      console.error('sourceLayers bind failed', e)
    }
  }

  if (!boundLayers) {
    bindFilmOnly(ctx, seg, { ff, film, width, height, video, hold })
  }
}

export async function runPreservedSource(ctx, env, opts) {
  const spec = ctx.pack.preserveSource
  if (opts.stopAfter === 'plan') throw new Error('这条成片按包内工作流出片，没有单独的宿主分镜阶段')
  const text = cleanScript(ctx.doc.script)
  if (!text) throw new Error('没有口播文案')
  if (ctx.doc.segments.length !== 1 || ctx.doc.segments[0].text !== text) {
    ctx.doc.segments = [newSegment(ctx.doc, { text, title: ctx.doc.title || '口播' })]
  }
  const seg = ctx.doc.segments[0]
  const scriptHash = stableHash({ text })
  // 短路（复用已生成结果）只在"真的什么都没要求重做"时成立：
  //  · 带 scope = 用户明确要求重做某段/某镜/某元素（工作台里的「只生成这个元素」等）
  //  · force = 界面上的「重试」按钮
  // 没有它们时，mediaReady 只看"文件在不在"——某个素材生成失败（没进 elements）时它照样返回 true，
  // 于是点重试会被这里静静吞掉，什么都没跑 ✗
  if (!opts.force && !opts.scope && ctx.doc.sourceRun?.scriptHash === scriptHash && mediaReady(ctx, seg)) {
    restamp(ctx, seg)
    env.phase('成片未改文案，沿用已生成结果')
    return
  }
  const packDir = ctx.entry?.dir
  const { root, entry } = resolveSourceRoot(spec, packDir)
  // 工作目录：优先复用文档里记着的那一个（例如"命令行导入"写下的 sourceWork）。
  // 不然收尾出来的 id 每次都映射到一个**新的空目录**，点一次重试就等于从零重跑
  // （连配音都要重配一版）✗ —— 而复用目录后，包内各步会自然跳过已生成的产物，
  // 只补缺的那一项（正是"生图失败 → 手动重试"想要的行为）。
  const rememberedWork = typeof ctx.doc.params?.sourceWork === 'string' ? ctx.doc.params.sourceWork : ''
  const work = rememberedWork && existsSync(rememberedWork)
    ? rememberedWork
    : path.join(ctx.outDir, `${ctx.doc.id}_koubo`)
  mkdirSync(work, { recursive: true })
  const scriptFile = path.join(work, '口播.txt')
  writeFileSync(scriptFile, text)
  const kitAssets = path.join(work, 'kit_assets')
  const workflowRoot = path.dirname(entry)
  const pyPath = [
    workflowRoot,
    path.join(workflowRoot, 'kit'),
    process.env.PYTHONPATH,
  ].filter(Boolean).join(path.delimiter)
  const args = [entry, ...spec.args, '--script', scriptFile]
  env.phase('包内工作流')
  // 与管线**并发**跑：TTS 一落盘就把配音/字幕挂进时间轴，不必等成片。
  // 这个 promise 永不 reject，失败只是"没提前挂上"，最后 bindFilm 仍会兜底。
  const earlyVoice = watchEarlyVoice(ctx, seg, work, {
    save: opts.save, env, canceled: opts.canceled,
  }).catch(() => {})
  await runProcess(resolvePython(), args, {
    cwd: workflowRoot,
    env: {
      KOUBO_WORK: work,
      KOUBO_CODE: workflowRoot,
      KOUBO_KIT_ASSETS: kitAssets,
      KOUBO_EMIT_LAYERS: '1',
      TTS_TIMELINE_ROOT: resolveTtsTimelineRoot(),
      MISHI_ROOT: resolveMishiRoot(),
      ...pythonEnv(),
      PYTHONPATH: pyPath,
      // 把自带的 ffmpeg/ffprobe 交给包内工作流：别让它去机器 PATH 上碰运气
      FFMPEG: resolveFfmpeg(),
      FFPROBE: resolveFfprobe(),
    },
    timeoutMs: (Number(spec.timeoutSec) || 10800) * 1000,
    onLine: (line) => env.phase(`工作流 ${line}`),
    canceled: opts.canceled,
    docId: ctx.doc.id,
  })
  const film = path.join(work, '04_动画渲染', 'output', '成片.mp4')
  const timingFile = path.join(work, '01_口播试听', 'timing.json')
  await earlyVoice
  if (!existsSync(film) || !existsSync(timingFile)) throw new Error('工作流结束，但没有成片或时间戳')
  const timing = JSON.parse(readFileSync(timingFile, 'utf8'))
  const probed = probeFilm(resolveFfmpeg(), film)
  bindFilm(ctx, seg, { timing, film, ...probed, work })
  ctx.doc.outline = { source: 'user', notes: '包内工作流' }
  ctx.doc.sourceRun = { scriptHash }
  ctx.doc.quality = readGateStatus(work)
}

/**
 * 读取包内工作流写出的 gate_status.json，把「产物成功」与「质量门结果」分开带到文档上。
 *
 * 为什么需要：包内管线约定"成片产出即成功，质量门未过只告警"（见 run_pipeline.py），
 * 但那个告警只打在子进程 stdout 上，而宿主只保留 tail 的 500 字符 —— 用户根本看不到。
 * 结果是最糟的组合：成片和分层都交付了，用户却不知道有几道质量门没过。
 * 这里把状态读进文档，前端即可如实展示；读不到就是 null（老扩展/老工作流不受影响）。
 */
export function readGateStatus(work) {
  const file = path.join(work, '04_动画渲染', 'output', 'gate_status.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const summary = path.join(work, '04_动画渲染', 'output', 'accept_gates', 'summary.json')
    let failed = []
    if (existsSync(summary)) {
      try {
        const rows = JSON.parse(readFileSync(summary, 'utf8')).results || []
        failed = rows.filter((r) => r && r.ok === false).map((r) => String(r.gate || '?'))
      } catch { /* 报告坏了不该影响入轨 */ }
    }
    return {
      productOk: raw.product_ok === true,
      gatesOk: raw.gates_ok === true,
      failedGates: failed,
      note: String(raw.note || '').slice(0, 200),
    }
  } catch {
    return null
  }
}
