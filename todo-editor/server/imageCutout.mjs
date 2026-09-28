/**
 * 白底抠像：color-to-alpha（按白色反混合），适合纯色纸 / 扁平图形放在纯白底上的素材。
 * 输入 PNG 或 JPEG，输出 RGBA PNG。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const png = PNG.sync.read(buf)
    return { width: png.width, height: png.height, data: png.data }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
    return { width: img.width, height: img.height, data: Buffer.from(img.data.buffer) }
  }
  throw new Error('不支持的图片格式（仅 PNG / JPEG）')
}

/**
 * @param {{ width: number, height: number, data: Buffer }} img RGBA，原地修改
 * @param {number} threshold 0~0.5：低于该"离白程度"的像素视为背景噪点，直接透明
 */
export function keyWhite(img, threshold) {
  const d = img.data
  const span = 1 - threshold
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255
    const g = d[i + 1] / 255
    const b = d[i + 2] / 255
    const a = Math.max(1 - r, 1 - g, 1 - b)
    if (a <= threshold) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0
      continue
    }
    // 反混合：c = a·fg + (1-a)·white → fg = 1 - (1-c)/a
    d[i] = Math.round((1 - (1 - r) / a) * 255)
    d[i + 1] = Math.round((1 - (1 - g) / a) * 255)
    d[i + 2] = Math.round((1 - (1 - b) / a) * 255)
    d[i + 3] = Math.round(Math.min(1, (a - threshold) / span) * 255)
  }
  return img
}

/**
 * 绿幕抠像：按"绿色溢出度" g-max(r,b) 算透明度并去绿边，保留白色 / 灰色纸张的不透明度。
 * 适合近单色素材生成在纯绿 (#00FF00) 底上。
 * @param {number} threshold 0~0.5：溢出度低于它的像素完全保留；高于 threshold+0.3 的完全透明
 */
export function keyGreen(img, threshold) {
  const d = img.data
  const lo = threshold
  const hi = threshold + 0.3
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2]
    const m = Math.max(r, b)
    const spill = (g - m) / 255
    if (spill <= 0) continue
    if (spill >= hi) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0
      continue
    }
    d[i + 1] = m
    if (spill > lo) d[i + 3] = Math.round(d[i + 3] * (hi - spill) / (hi - lo))
  }
  return img
}

export function applyCutout(img, method, threshold) {
  if (method === 'keyWhite') return keyWhite(img, threshold)
  if (method === 'keyGreen') return keyGreen(img, threshold)
  throw new Error(`未知抠像方法 ${method}`)
}

/** 裁到不透明内容的包围盒，四周留 pad 比例的边 */
export function trimTransparent(img, pad = 0.02) {
  const { width: w, height: h, data: d } = img
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return img
  const p = Math.round(Math.max(x1 - x0, y1 - y0) * pad)
  x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p)
  x1 = Math.min(w - 1, x1 + p); y1 = Math.min(h - 1, y1 + p)
  const nw = x1 - x0 + 1
  const nh = y1 - y0 + 1
  const out = Buffer.alloc(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    d.copy(out, y * nw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4)
  }
  return { width: nw, height: nh, data: out }
}

export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height })
  img.data.copy(png.data)
  return PNG.sync.write(png)
}

/** 读 inPath → 抠像 → 写 outPath(PNG)；返回输出尺寸 */
export function cutoutFile(inPath, outPath, { method, threshold, trim }) {
  let img = applyCutout(decodeImage(readFileSync(inPath)), method, threshold)
  if (trim) img = trimTransparent(img)
  writeFileSync(outPath, encodePng(img))
  return { width: img.width, height: img.height }
}
