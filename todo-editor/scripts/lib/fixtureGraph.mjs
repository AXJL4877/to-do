/**
 * 手写 EditGraph fixture 辅助：字段对齐 src/lib/editGraph.ts 的 buildEditGraph 输出。
 * mediaPath 使用相对 tests/… 路径，golden.mjs 运行时解析为绝对路径。
 */

export function clip(overrides = {}) {
  const {
    mediaPath = 'tests/media/gop250.mp4',
    start = 0,
    duration = 5,
    inPoint = 0,
    outPoint,
    trackId = 'v1',
    enabled = true,
    kind = 'video',
    speed = 1,
    reverse = false,
    freeze,
    omitOutPoint = false,
    x = 0,
    y = 0,
    scaleX = 1,
    scaleY = 1,
    rotation = 0,
    opacity = 1,
    cropL = 0,
    cropR = 0,
    cropT = 0,
    cropB = 0,
    exposure = 0,
    contrast = 0,
    saturation = 0,
    temperature = 0,
    tint = 0,
    blend = 'normal',
    text,
    effects,
    mask,
    chromaKey,
    transitionIn,
    transitionOut,
    keyframes,
  } = overrides

  const c = {
    mediaPath,
    start,
    duration,
    inPoint,
    trackId,
    enabled,
    kind,
    speed,
    reverse,
    x, y, scaleX, scaleY, rotation, opacity,
    cropL, cropR, cropT, cropB,
    exposure, contrast, saturation, temperature, tint,
    blend,
  }
  if (!omitOutPoint) c.outPoint = outPoint ?? inPoint + duration * (speed || 1)
  if (freeze !== undefined) c.freeze = freeze
  if (text) c.text = text
  if (effects) c.effects = effects
  if (mask) c.mask = mask
  if (chromaKey) c.chromaKey = chromaKey
  if (transitionIn) c.transitionIn = transitionIn
  if (transitionOut) c.transitionOut = transitionOut
  if (keyframes) c.keyframes = keyframes
  return c
}

export function graph({ clips, tracks, settings, workIn = 0, workOut, rangeOnly, audioOnly }) {
  const g = {
    version: 1,
    clips,
    tracks,
    settings: settings || { width: 640, height: 360, fps: 30 },
    workIn,
    workOut: workOut ?? Math.max(...clips.map((c) => c.start + c.duration), 1),
  }
  if (rangeOnly != null) g.rangeOnly = rangeOnly
  if (audioOnly != null) g.audioOnly = audioOnly
  return g
}

export function videoTracks(...ids) {
  return ids.map((id) => ({ id, kind: 'video', muted: false }))
}
