export type MediaKind = 'video' | 'audio' | 'image' | 'font' | 'sticker'
export type TrackKind = 'video' | 'audio' | 'subtitle' | 'effect' | 'adjustment'
export type Tool = 'select' | 'razor' | 'trim' | 'roll' | 'slip' | 'slide' | 'hand'
export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier'
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'add'
export type FitMode = 'contain' | 'cover' | 'stretch' | 'manual'
export type TransitionType = 'dissolve' | 'fadeBlack' | 'fadeWhite' | 'push' | 'wipe'
export type EffectType = 'blur' | 'sharpen' | 'vignette' | 'glow' | 'glitch' | 'mosaic' | 'noiseReduce' | 'filter'
export type MaskType = 'rect' | 'ellipse' | 'linear' | 'pen' | 'text'

/** 贝塞尔手柄：相对本段 (dt, dv) 的偏移；出手柄 x∈(0,1)，入手柄 x∈(-1,0) */
export interface KfHandle { x: number; y: number }

export interface Keyframe {
  id: string
  t: number
  value: number
  ease: Ease
  /** 出手柄 → 下一关键帧 */
  oh?: KfHandle
  /** 入手柄 ← 上一关键帧 */
  ih?: KfHandle
}

export interface Transform2D {
  x: number; y: number; scaleX: number; scaleY: number; rotation: number
  anchorX: number; anchorY: number; opacity: number
  flipH: boolean; flipV: boolean
  cropL: number; cropR: number; cropT: number; cropB: number
  fit: FitMode
}

export interface ColorGrade {
  exposure: number; contrast: number; saturation: number; temperature: number; tint: number
  highlights: number; shadows: number; whites: number; blacks: number
  hueShift: number; lutStrength: number; lutName?: string
}

export interface AudioParams {
  gainDb: number; pan: number; fadeIn: number; fadeOut: number; mute: boolean
  eqLow: number; eqMid: number; eqHigh: number; compress: number
  denoise: number; reverb: number; pitch: number; ducking: boolean
}

export interface TextStyle {
  content: string; fontFamily: string; fontSize: number; color: string
  align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number
  strokeWidth: number; strokeColor: string; shadowBlur: number; shadowColor: string
  bgEnabled: boolean; bgColor: string; bilingual?: string
  animIn: string; animOut: string
  /** 入场时长（秒） */
  animInDur: number
  /** 出场时长（秒） */
  animOutDur: number
}

export interface MediaItem {
  id: string; name: string; kind: MediaKind; url: string; duration: number
  width?: number; height?: number; fps?: number; folderId: string
  favorite: boolean; offline: boolean; proxyUrl?: string
  /** 本机文件路径（桌面版持久化；blob URL 重启会失效） */
  path?: string
}

export interface MediaFolder { id: string; name: string }

export interface TransitionRef { type: TransitionType; duration: number }

export interface EffectInstance {
  id: string; type: EffectType; name: string; strength: number
  enabled: boolean; start: number; end: number
}

export interface Mask {
  type: MaskType; feather: number; expand: number; invert: boolean
  points?: { x: number; y: number }[]
}

/** AE 式 3D 图层变换（归一化构图空间，Z 朝向相机前方为正） */
export interface Transform3D {
  x: number; y: number; z: number
  rotationX: number; rotationY: number; rotationZ: number
  scaleX: number; scaleY: number; scaleZ: number
  anchorX: number; anchorY: number; anchorZ: number
  opacity: number
}

/** 序列虚拟摄像机（透视） */
export interface Camera3D {
  x: number; y: number; z: number
  rotationX: number; rotationY: number; rotationZ: number
  fov: number
  near: number; far: number
  focusDistance: number
  aperture: number
  dof: boolean
  /** 相机属性关键帧：camX / camY / camZ / camRotX / … / fov / focusDistance */
  keyframes: Record<string, Keyframe[]>
}

export interface Scene3D {
  enabled: boolean
  camera: Camera3D
  ambient: number
  fog: number
}

export interface Clip {
  id: string; trackId: string; mediaId?: string; name: string
  start: number; duration: number; inPoint: number; outPoint: number
  linkedId?: string; enabled: boolean; groupId?: string
  speed: number; reverse: boolean; freeze?: number
  speedKeyframes: Keyframe[]; transform: Transform2D; color: ColorGrade; audio: AudioParams
  text?: TextStyle; effects: EffectInstance[]; mask?: Mask; blend: BlendMode
  transitionIn?: TransitionRef; transitionOut?: TransitionRef
  keyframes: Record<string, Keyframe[]>
  chromaKey?: { color: string; tolerance: number; enabled: boolean }
  tracking?: boolean; stabilize?: boolean
  /** 作为 3D 平面参与虚拟摄像机合成 */
  threeD?: boolean
  transform3d?: Transform3D
}

export interface Track {
  id: string; kind: TrackKind; name: string
  locked: boolean; muted: boolean; solo: boolean; hidden: boolean; height: number
}

export interface Marker { id: string; t: number; color: string; label: string }

export interface Sequence {
  id: string; name: string; tracks: Track[]; clips: Clip[]
  markers: Marker[]; workIn: number; workOut: number
  scene3d: Scene3D
}

export interface ProjectSettings {
  width: number; height: number; fps: number; aspect: string; pixelAspect: number
  stillDuration: number; cachePath: string; useProxy: boolean; hwAccel: boolean
  canvasBg: 'black' | 'color' | 'blur' | 'image'; canvasColor: string
  safeFrame: boolean; magnetic: boolean; snap: boolean
}

export interface Prefs {
  defaultDuration: number; cachePath: string
  performance: 'quality' | 'balanced' | 'speed'
  /** 预览 RAM 缓存最长边；0 = 与监视器预览同分辨率 */
  previewCacheMaxEdge: 0 | 480 | 720 | 1080
  shortcuts: Record<string, string>
}

export interface ExportJob {
  id: string; name: string; status: 'queued' | 'running' | 'done' | 'error'
  progress: number; preset: string; rangeOnly: boolean; audioOnly: boolean
}

export interface EffectPreset {
  id: string; name: string; kind: 'color' | 'motion' | 'text' | 'effect'; payload: unknown
}

export const defaultTransform = (): Transform2D => ({
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
  anchorX: 0.5, anchorY: 0.5, opacity: 1,
  flipH: false, flipV: false, cropL: 0, cropR: 0, cropT: 0, cropB: 0, fit: 'contain',
})

export const defaultColor = (): ColorGrade => ({
  exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
  highlights: 0, shadows: 0, whites: 0, blacks: 0, hueShift: 0, lutStrength: 0,
})

export const defaultAudio = (): AudioParams => ({
  gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, mute: false,
  eqLow: 0, eqMid: 0, eqHigh: 0, compress: 0, denoise: 0, reverb: 0, pitch: 0, ducking: false,
})

export const defaultText = (): TextStyle => ({
  content: '标题文字', fontFamily: 'Syne', fontSize: 48, color: '#F5F2EC',
  align: 'center', lineHeight: 1.3, letterSpacing: 0,
  strokeWidth: 0, strokeColor: '#000', shadowBlur: 0, shadowColor: '#000',
  bgEnabled: false, bgColor: '#00000088', animIn: 'fade', animOut: 'none',
  animInDur: 0.8, animOutDur: 0.4,
})

export const defaultTransform3d = (): Transform3D => ({
  x: 0, y: 0, z: 0,
  rotationX: 0, rotationY: 0, rotationZ: 0,
  scaleX: 1, scaleY: 1, scaleZ: 1,
  anchorX: 0, anchorY: 0, anchorZ: 0,
  opacity: 1,
})

export const defaultCamera3d = (): Camera3D => ({
  x: 0, y: 0, z: 5,
  rotationX: 0, rotationY: 0, rotationZ: 0,
  fov: 40,
  near: 0.1, far: 200,
  focusDistance: 5,
  aperture: 0,
  dof: false,
  keyframes: {},
})

export const defaultScene3d = (): Scene3D => ({
  enabled: false,
  camera: defaultCamera3d(),
  ambient: 0.85,
  fog: 0,
})

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}
