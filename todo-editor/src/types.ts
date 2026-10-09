export type MediaKind = 'video' | 'audio' | 'image' | 'font' | 'sticker'
export type TrackKind = 'video' | 'audio' | 'subtitle' | 'effect' | 'adjustment'
export type Tool = 'select' | 'razor' | 'trim' | 'roll' | 'slip' | 'slide' | 'hand' | 'rate'
export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | 'bezier'
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'add'
export type FitMode = 'contain' | 'cover' | 'stretch' | 'manual'
export type TransitionType = 'dissolve' | 'fadeBlack' | 'fadeWhite' | 'push' | 'wipe'
export type EffectType = 'blur' | 'sharpen' | 'vignette' | 'glow' | 'glitch' | 'mosaic' | 'noiseReduce' | 'filter' | 'chalkDust'
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
  /** 花字：存在时替代 color / stroke / shadow 的简单样式 */
  fancy?: FancyText
}

/** 花字尺寸类数值均以 1080p 画面像素计，渲染时按画布高度缩放 */
export interface FancyStroke { color: string; width: number }

export interface DynamicText {
  version: 1 | 2
  engine: 'jizura'
  presetId: string
  seed: number
  duration: number
  motion: number
  accent: string
  composition?: {
    corner?: { sceneBase?: number; direction: 'clockwise' | 'alternate' | 'mixed'; easing: 'spring' | 'back' | 'expo'; variant: 'mix' | 'type' | 'pop' | 'mask' | 'slam' | 'ribbon' | 'echo' | 'focus'; zoom: number; transition: number; stagger: number; trail: number; backgroundColor: string }
    style: string; mood: string; background: 'style' | 'transparent'; unify: boolean
    parts: Partial<Record<'layout' | 'enter' | 'hold' | 'exit' | 'decor' | 'treat' | 'bg' | 'cam' | 'fx' | 'trans', string>>
    fx: { decor: number; chroma: number; glitch: number; texture: number; bgSwitch: number }
    offset: number
    scenes: { content: string; start: number; end: number }[]
  }
}

export interface FancyText {
  dynamic?: DynamicText
  chalk?: { duration: number; grain: number; hand: boolean }
  /** 来源预设 id（仅展示用） */
  preset?: string
  fontWeight: number
  italic?: boolean
  /** 1 色为纯色；2~4 色为线性渐变 */
  fill: string[]
  /** 渐变方向（度）：90 = 自上而下 */
  fillAngle: number
  /** 由内向外的多层描边 */
  strokes: FancyStroke[]
  shadow?: { color: string; blur: number; x: number; y: number }
  /** 立体厚度：沿 angle 方向堆叠 depth 层 */
  extrude?: { color: string; depth: number; angle: number }
  glow?: { color: string; blur: number }
  /** 顶部高光 0~1 */
  gloss?: number
  /** 文字背后的底块 */
  bg?: { color: string; radius: number; padX: number; padY: number }
  /** 字内质感纹理（小尺寸 JPEG dataURL，随工程保存） */
  texture?: string
  textureOpacity?: number
  textureBlend?: 'normal' | 'multiply' | 'overlay'
}

export interface MediaItem {
  id: string; name: string; kind: MediaKind; url: string; duration: number
  width?: number; height?: number; fps?: number; folderId: string
  favorite: boolean; offline: boolean; proxyUrl?: string
  /** 本机文件路径（桌面版持久化；blob URL 重启会失效） */
  path?: string
  /** 相对工程文件的路径（保存时由主进程写入，打开时绝对路径失效再用它找回） */
  relPath?: string
  /** 低分辨率代理文件（userData/cache/proxies；useProxy 时预览优先） */
  proxyPath?: string
  /** 探测结果：是否含音轨（视频入轨时自动带 A 轨） */
  hasAudio?: boolean
  /** 带透明通道的视频（VP9 alpha WebM）：不生成 H.264 代理、不走原生单层解码、不当作不透明遮挡层 */
  alpha?: boolean
  /** 已复制进项目文件夹的 AI 产物：原来在 AI 服务上的路径 /ai-generated/<name>（去重、找任务用） */
  aiUrl?: string
}

/** 媒体库文件夹；parentId 为空表示根级。系统文件夹（f_all / f_broll / f_audio / f_sticker / f_web）不可删除 */
export interface MediaFolder { id: string; name: string; parentId?: string | null }

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

/** 时间线元素元数据（绝对时间轴为唯一基准，随工程 JSON 持久化） */
export interface ChalkStroke {
  /** 笔尖轨迹 [素材秒, u, v]，u/v 为片段画面内 0~1 坐标 */
  tip: number[][]
  /** 生成时的画幅（手的尺寸按它换算到工程画面） */
  frame: { width: number; height: number }
  /** 粉笔手图：尺寸为生成画幅下的像素，tipX/tipY 为笔尖在图里的位置 0~1；mediaId 为导入媒体库后的素材 */
  hand: { url: string; width: number; height: number; tipX: number; tipY: number; mediaId?: string }
  /** 「粉笔手书写」入场动画是否开启、手的大小倍率 */
  on?: boolean
  scale?: number
}

export interface ClipMeta {
  /** 绝对时间轴起点（头秒）= clip.start */
  absIn: number
  /** 绝对时间轴终点（尾秒）= clip.start + clip.duration */
  absOut: number
  /** 同 absIn，兼容旧字段 */
  start: number
  duration: number
  /** 同 absOut */
  end: number
  /** 素材剪切入点（媒体时间） */
  inPoint: number
  /** 素材剪切出点（媒体时间） */
  outPoint: number
  trackId: string
  trackName?: string
  trackKind?: TrackKind
  enabled: boolean
  trackHidden?: boolean
  trackMuted?: boolean
  /** 最终是否可见：片段启用且轨道未隐藏 */
  visible?: boolean
  /** 配乐垫底：一键调音跳过，再次铺曲时整段换掉 */
  role?: 'bgm'
  source?: {
    type: 'ai' | 'import' | 'manual'
    jobId?: string
    kind?: string
    /** 同一任务的分层：同层片段共用轨道，层号小的在上 */
    lane?: number
    /** 任务内产物的唯一键：同一产物只入轨一次 */
    key?: string
    /** 成片产物的版本（生成层的输入指纹）：版本变了就原位换成新产物 */
    rev?: string
    /** 入轨时自动排的位置（变换签名）；和当前不同说明用户挪过，换新产物时保留用户的位置 */
    layout?: string
    /** 粉笔元素的书写片段：可套「粉笔手书写」入场动画 */
    chalk?: ChalkStroke
    /** 旧版独立粉笔手片段所属元素 id；打开时会并回元素的 chalk.on 并删除该片段 */
    handFor?: string
    handScale?: number
  }
  updatedAt?: number
}

export interface Clip {
  id: string; trackId: string; mediaId?: string; name: string
  start: number; duration: number; inPoint: number; outPoint: number
  linkedId?: string; enabled: boolean; groupId?: string
  speed: number; reverse: boolean; freeze?: number
  speedKeyframes: Keyframe[]; transform: Transform2D; color: ColorGrade; audio: AudioParams
  text?: TextStyle
  /** 纯色底：无素材，铺满画布的纯色层（#RRGGBB） */
  solid?: { color: string }
  effects: EffectInstance[]; mask?: Mask; blend: BlendMode
  transitionIn?: TransitionRef; transitionOut?: TransitionRef
  keyframes: Record<string, Keyframe[]>
  chromaKey?: { color: string; tolerance: number; enabled: boolean }
  tracking?: boolean; stabilize?: boolean
  /** 作为 3D 平面参与虚拟摄像机合成 */
  threeD?: boolean
  transform3d?: Transform3D
  /** 独立元数据：时间线位置、轨道、可见性、来源等 */
  meta?: ClipMeta
}

export interface Track {
  id: string; kind: TrackKind; name: string
  locked: boolean; muted: boolean; solo: boolean; hidden: boolean; height: number
  /** 配乐轨：锁定，不参与成片配音入轨，整理时间轴时保留 */
  role?: 'bgm'
}

export interface Marker { id: string; t: number; color: string; label: string }

export interface Sequence {
  id: string; name: string; tracks: Track[]; clips: Clip[]
  markers: Marker[]; workIn: number; workOut: number
  scene3d: Scene3D
}

export interface ProjectSettings {
  /** Explicitly removed generated files are not silently restored by polling. New hashed outputs can still import. */
  removedGeneratedMedia?: string[]
  width: number; height: number; fps: number; aspect: string; pixelAspect: number
  stillDuration: number; cachePath: string; useProxy: boolean; hwAccel: boolean
  /** B2：节目监视器原生 popup 预览（默认关） */
  nativePreview: boolean
  canvasBg: 'black' | 'color' | 'blur' | 'image'; canvasColor: string
  safeFrame: boolean; magnetic: boolean; snap: boolean
  /** 流式入轨的 AI 任务已放过的产物键（任务 id → 键），跟片段一起存进工程：刷新丢了片段也就没有记录，会重新补上 */
  aiPlaced?: Record<string, string[]>
  /**
   * 本工程用到的成片（成片 id → 入轨记录）：t0 为整片起点，auto 为是否自动入轨，
   * placed 为每个产物键最后一次放上时的版本（片段被删而版本没变 = 用户删的，不再放回）
   */
  aiProductions?: Record<string, ProductionPlacement>
}

export interface ProductionPlacement { t0: number; auto: boolean; placed: Record<string, string>; createdAt: number }

export interface Prefs {
  defaultDuration: number; cachePath: string
  performance: 'quality' | 'balanced' | 'speed'
  /** 预览 RAM 缓存最长边；0 = 与监视器预览同分辨率 */
  previewCacheMaxEdge: 0 | 480 | 720 | 1080
  /** 预览磁盘缓存上限（GB），超出按最近使用淘汰 */
  previewDiskCacheGb?: 2 | 5 | 10 | 20
  shortcuts: Record<string, string>
}

export interface ExportJob {
  id: string; name: string; status: 'queued' | 'running' | 'done' | 'error'
  progress: number; preset: string; rangeOnly: boolean; audioOnly: boolean
  /** 实际导出的画幅，如 3840×2160 */
  size?: string
  /** 当前阶段说明：透明素材转码 / 合成画面 / 编码 */
  stage?: string
  path?: string
  error?: string
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
