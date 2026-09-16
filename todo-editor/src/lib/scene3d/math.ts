import type { Camera3D, Clip, MediaItem, Prefs, Scene3D, Transform3D } from '../../types'
import { defaultScene3d, defaultCamera3d, defaultTransform3d } from '../../types'
import { sampleKeyframes } from '../keyframeEval'

/** 预览代理纹理最大边长 */
export function proxyMaxEdge(performance: Prefs['performance']): number {
  if (performance === 'speed') return 1024
  if (performance === 'balanced') return 1536
  return 2048
}

export function webglOk(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export function ensureScene3d(raw?: Partial<Scene3D> | null): Scene3D {
  const base = defaultScene3d()
  if (!raw) return base
  return {
    enabled: !!raw.enabled,
    ambient: raw.ambient ?? base.ambient,
    fog: raw.fog ?? base.fog,
    camera: { ...defaultCamera3d(), ...(raw.camera ?? {}), keyframes: raw.camera?.keyframes ?? {} },
  }
}

export function resolveCamera3d(cam: Camera3D, t: number): Camera3D {
  const kf = cam.keyframes
  return {
    ...cam,
    x: sampleKeyframes(kf.camX, t, cam.x),
    y: sampleKeyframes(kf.camY, t, cam.y),
    z: sampleKeyframes(kf.camZ, t, cam.z),
    rotationX: sampleKeyframes(kf.camRotX, t, cam.rotationX),
    rotationY: sampleKeyframes(kf.camRotY, t, cam.rotationY),
    rotationZ: sampleKeyframes(kf.camRotZ, t, cam.rotationZ),
    fov: sampleKeyframes(kf.fov, t, cam.fov),
    focusDistance: sampleKeyframes(kf.focusDistance, t, cam.focusDistance),
  }
}

export function resolveLayer3d(clip: Clip, playhead: number): Transform3D {
  const base = clip.transform3d ?? defaultTransform3d()
  const tr2 = clip.transform
  const localT = Math.max(0, playhead - clip.start)
  const kf = clip.keyframes
  return {
    ...base,
    x: sampleKeyframes(kf.z3dx ?? kf.x, localT, base.x || tr2.x),
    y: sampleKeyframes(kf.z3dy ?? kf.y, localT, base.y || tr2.y),
    z: sampleKeyframes(kf.z3dz, localT, base.z),
    rotationX: sampleKeyframes(kf.rotX, localT, base.rotationX),
    rotationY: sampleKeyframes(kf.rotY, localT, base.rotationY),
    rotationZ: sampleKeyframes(kf.rotZ ?? kf.rotation, localT, base.rotationZ || tr2.rotation),
    scaleX: sampleKeyframes(kf.scale3d ?? kf.scale, localT, base.scaleX * (tr2.scaleX || 1)),
    scaleY: sampleKeyframes(kf.scale3dY ?? kf.scale, localT, base.scaleY * (tr2.scaleY || 1)),
    scaleZ: base.scaleZ,
    opacity: sampleKeyframes(kf.opacity, localT, base.opacity * tr2.opacity),
  }
}

export type SceneFrameInput = {
  scene: Scene3D
  clips: Clip[]
  /** 用于叠层：列表越靠上越靠近相机 */
  tracks?: { id: string; kind: string }[]
  media: MediaItem[]
  playhead: number
  aspect: number
  performance: Prefs['performance']
  selectedIds: string[]
}
