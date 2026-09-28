/**
 * 关键帧 → 动画：拼图切格、逐帧抠像、地平线对齐、统一裁边、ffmpeg 合成。
 * 透明通道输出 WebM(VP9 yuva420p)，否则 MP4(H.264)。帧均为 RGBA { width, height, data }。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { applyCutout, encodePng } from './imageCutout.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG,
    process.env.TODO_NATIVE_BIN && path.join(process.env.TODO_NATIVE_BIN, 'ffmpeg.exe'),
    path.join(ROOT, 'native', 'bin', 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
  ].filter(Boolean)
  return candidates.find((c) => existsSync(c)) || 'ffmpeg'
}

export function crop(img, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    img.data.copy(out, y * w * 4, ((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4)
  }
  return { width: w, height: h, data: out }
}

/** 等分网格切格；inset 为每格四周内缩比例，避开格间残线 */
export function sliceGrid(img, cols, rows, inset = 0.03) {
  const cw = Math.floor(img.width / cols)
  const ch = Math.floor(img.height / rows)
  const ix = Math.round(cw * inset)
  const iy = Math.round(ch * inset)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(crop(img, c * cw + ix, r * ch + iy, cw - ix * 2, ch - iy * 2))
    }
  }
  return cells
}

function fill(w, h, bg) {
  const data = Buffer.alloc(w * h * 4)
  if (bg) for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255 }
  return { width: w, height: h, data }
}

/** 把 img 以 (dx, dy) 偏移贴到 w×h 新画布上，超出部分丢弃 */
export function place(img, w, h, dx, dy, bg) {
  const out = fill(w, h, bg)
  for (let y = 0; y < img.height; y++) {
    const ty = y + dy
    if (ty < 0 || ty >= h) continue
    const sx0 = Math.max(0, -dx)
    const sx1 = Math.min(img.width, w - dx)
    if (sx1 <= sx0) continue
    img.data.copy(out.data, (ty * w + sx0 + dx) * 4, (y * img.width + sx0) * 4, (y * img.width + sx1) * 4)
  }
  return out
}

/** 内容包围盒：透明帧看 alpha，不透明帧看"离白程度" */
export function contentBox(img, alpha, threshold = 0.1) {
  const { width: w, height: h, data: d } = img
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const ink = alpha ? d[i + 3] > 8 : (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255 > threshold
      if (!ink) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/**
 * 关键帧 → 统一尺寸、对齐、（可选）抠像后的帧。
 * @param {{ width:number, height:number, data:Buffer }[]} frames
 * @param {{ cutout: { method: string, threshold: number } | null, align: 'none'|'baseline' }} opts
 */
export function normalizeFrames(frames, { cutout, align }) {
  const alpha = !!cutout
  const bg = alpha ? null : [255, 255, 255]
  const W = frames[0].width
  const H = frames[0].height
  let out = frames.map((f) => {
    const g = { width: f.width, height: f.height, data: Buffer.from(f.data) }
    if (alpha) applyCutout(g, cutout.method, cutout.threshold)
    return g.width === W && g.height === H
      ? g
      : place(g, W, H, Math.round((W - g.width) / 2), Math.round((H - g.height) / 2), bg)
  })

  const boxes = out.map((f) => contentBox(f, alpha))
  if (align === 'baseline') {
    const floor = Math.max(...boxes.map((b) => (b ? b.y1 : 0)))
    out = out.map((f, i) => {
      const b = boxes[i]
      if (!b || b.y1 === floor) return f
      const dy = floor - b.y1
      b.y0 += dy
      b.y1 += dy
      return place(f, W, H, 0, dy, bg)
    })
  }

  // 所有帧共用一个裁边框，保证逐帧叠放不跳
  const valid = boxes.filter(Boolean)
  if (alpha && valid.length) {
    const u = {
      x0: Math.min(...valid.map((b) => b.x0)), y0: Math.min(...valid.map((b) => b.y0)),
      x1: Math.max(...valid.map((b) => b.x1)), y1: Math.max(...valid.map((b) => b.y1)),
    }
    const pad = Math.round(Math.max(u.x1 - u.x0, u.y1 - u.y0) * 0.03)
    const x0 = Math.max(0, u.x0 - pad)
    const y0 = Math.max(0, u.y0 - pad)
    const x1 = Math.min(W - 1, u.x1 + pad)
    const y1 = Math.min(H - 1, u.y1 + pad)
    out = out.map((f) => crop(f, x0, y0, x1 - x0 + 1, y1 - y0 + 1))
  }

  // yuv420 要求偶数宽高
  const ew = out[0].width + (out[0].width % 2)
  const eh = out[0].height + (out[0].height % 2)
  if (ew !== out[0].width || eh !== out[0].height) out = out.map((f) => place(f, ew, eh, 0, 0, bg))
  return out
}

/** 播放顺序：forward 顺放；pingpong 往返（不重复首尾帧），再整体重复 repeat 次 */
export function playOrder(n, loop, repeat) {
  const one = [...Array(n).keys()]
  if (loop === 'pingpong' && n > 2) one.push(...[...Array(n - 2).keys()].map((i) => n - 2 - i))
  return Array.from({ length: repeat }, () => one).flat()
}

function runFfmpeg(args, timeoutMs = 180000) {
  const ffmpeg = resolveFfmpeg()
  return new Promise((resolve, reject) => {
    let err = ''
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => { try { child.kill() } catch { /* */ } }, timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? '找不到 ffmpeg（FFMPEG / native/bin / WinGet / PATH）' : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error((err || `ffmpeg 退出码 ${code}`).trim().slice(-400)))
    })
  })
}

/**
 * 写出逐帧 PNG 并合成动画文件。
 * @returns {Promise<{ video: string, frames: string[], width: number, height: number, duration: number, playFrames: number }>}
 */
export async function writeAnimation(frames, { outDir, id, fps, loop, repeat, alpha }) {
  const frameNames = frames.map((f, i) => {
    const name = `${id}_f${String(i + 1).padStart(2, '0')}.png`
    writeFileSync(path.join(outDir, name), encodePng(f))
    return name
  })

  const order = playOrder(frames.length, loop, repeat)
  const tmp = path.join(outDir, `_${id}_seq`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const pngs = frames.map((f) => encodePng(f))
  order.forEach((fi, i) => writeFileSync(path.join(tmp, `${String(i).padStart(4, '0')}.png`), pngs[fi]))

  const video = `${id}.${alpha ? 'webm' : 'mp4'}`
  const input = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(tmp, '%04d.png')]
  const codec = alpha
    ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-auto-alt-ref', '0', '-row-mt', '1']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart']
  try {
    await runFfmpeg([...input, ...codec, '-an', path.join(outDir, video)])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return {
    video,
    frames: frameNames,
    width: frames[0].width,
    height: frames[0].height,
    duration: order.length / fps,
    playFrames: order.length,
  }
}
