import * as THREE from 'three'
import type { Clip, MediaItem } from '../../types'
import { proxyMaxEdge, resolveCamera3d, resolveLayer3d, type SceneFrameInput } from './math'

type LayerMesh = THREE.Mesh & { userData: { clipId: string; url?: string; pendingUrl?: string } }

/**
 * Electron/WebGL 内 3D 合成预览。React 只调 sync/resize/render/dispose。
 */
export class Scene3dRenderer {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private root = new THREE.Group()
  private ambient: THREE.AmbientLight
  private layers = new Map<string, LayerMesh>()
  private texCache = new Map<string, THREE.Texture>()
  private loading = new Set<string>()
  private maxEdge = 1536
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    this.renderer.setClearColor(0x12141a, 1)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.scene = new THREE.Scene()
    this.scene.add(this.root)
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 200)
    this.camera.position.set(0, 0, 5)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.9)
    this.scene.add(this.ambient)
    const key = new THREE.DirectionalLight(0xffffff, 0.35)
    key.position.set(2, 3, 4)
    this.scene.add(key)
  }

  resize(cssW: number, cssH: number) {
    if (this.disposed || cssW <= 0 || cssH <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(cssW, cssH, false)
    this.camera.aspect = cssW / cssH
    this.camera.updateProjectionMatrix()
  }

  sync(input: SceneFrameInput) {
    if (this.disposed) return
    this.maxEdge = proxyMaxEdge(input.performance)
    const cam = resolveCamera3d(input.scene.camera, input.playhead)
    this.camera.fov = cam.fov
    this.camera.near = cam.near
    this.camera.far = cam.far
    this.camera.aspect = input.aspect
    this.camera.updateProjectionMatrix()
    this.camera.position.set(cam.x, cam.y, cam.z)
    this.camera.rotation.set(
      THREE.MathUtils.degToRad(cam.rotationX),
      THREE.MathUtils.degToRad(cam.rotationY),
      THREE.MathUtils.degToRad(cam.rotationZ),
      'YXZ',
    )
    this.ambient.intensity = input.scene.ambient
    if (input.scene.fog > 0.001) {
      this.scene.fog = new THREE.FogExp2(0x12141a, input.scene.fog * 0.08)
    } else {
      this.scene.fog = null
    }

    const active = input.clips.filter((c) => {
      if (!c.enabled || c.threeD === false) return false
      // scene3d.enabled 时：三D 图层 + 默认把无 threeD=false 的可见视频/图/字也当平面
      const inRange = input.playhead >= c.start && input.playhead < c.start + c.duration
      if (!inRange) return false
      if (c.threeD) return true
      if (!input.scene.enabled) return false
      return !!(c.mediaId || c.text)
    })

    const keep = new Set(active.map((c) => c.id))
    for (const [id, mesh] of this.layers) {
      if (!keep.has(id)) {
        this.root.remove(mesh)
        mesh.geometry.dispose()
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.map = null
        mat.dispose()
        this.layers.delete(id)
      }
    }

    const mediaMap = new Map(input.media.map((m) => [m.id, m]))
    // 轨道列表自上而下覆盖：后添加的更靠近相机（轻微 z bias）
    active.forEach((clip, i) => {
      let mesh = this.layers.get(clip.id)
      if (!mesh) {
        mesh = this.makePlane(clip.id)
        this.layers.set(clip.id, mesh)
        this.root.add(mesh)
      }
      const t3 = resolveLayer3d(clip, input.playhead)
      this.applyTransform(mesh, t3, i)
      mesh.visible = true
      const selected = input.selectedIds.includes(clip.id)
      const mat = mesh.material as THREE.MeshBasicMaterial
      mat.opacity = t3.opacity
      // 文字/图片纹理带透明；不开 transparent 会挡住下层画面
      mat.transparent = true
      mat.depthWrite = false
      mat.color.set(selected ? 0xfff4e8 : 0xffffff)
      this.bindTexture(mesh, clip, mediaMap.get(clip.mediaId ?? ''))
    })
  }

  render() {
    if (this.disposed) return
    this.renderer.render(this.scene, this.camera)
  }

  /** 离屏导出用：返回 dataURL */
  capturePng(): string {
    this.render()
    return this.canvas.toDataURL('image/png')
  }

  dispose() {
    this.disposed = true
    for (const mesh of this.layers.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.layers.clear()
    for (const tex of this.texCache.values()) tex.dispose()
    this.texCache.clear()
    this.renderer.dispose()
  }

  private makePlane(clipId: string): LayerMesh {
    const geo = new THREE.PlaneGeometry(1.778, 1)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat) as unknown as LayerMesh
    mesh.userData = { clipId }
    return mesh
  }

  private applyTransform(mesh: THREE.Mesh, t: Transform3DLike, stackIndex: number) {
    mesh.position.set(t.x * 2.2, t.y * 1.2, t.z - stackIndex * 0.002)
    mesh.rotation.set(
      THREE.MathUtils.degToRad(t.rotationX),
      THREE.MathUtils.degToRad(t.rotationY),
      THREE.MathUtils.degToRad(t.rotationZ),
      'YXZ',
    )
    mesh.scale.set(Math.max(0.01, t.scaleX), Math.max(0.01, t.scaleY), 1)
  }

  private bindTexture(mesh: LayerMesh, clip: Clip, media?: MediaItem) {
    if (clip.text) {
      const key = `text:${clip.id}:${clip.text.content}:${clip.text.fontSize}:${clip.text.color}`
      if (mesh.userData.url === key) return
      const tex = this.textTexture(clip)
      this.setMap(mesh, tex, key)
      return
    }
    const url = media?.proxyUrl || media?.url
    if (!url) return
    if (mesh.userData.url === url) return
    const cached = this.texCache.get(url)
    if (cached) {
      this.setMap(mesh, cached, url)
      return
    }
    if (this.loading.has(url)) {
      // 标记等待中，加载完成后按 clipId 回填
      mesh.userData.pendingUrl = url
      return
    }
    this.loading.add(url)
    mesh.userData.pendingUrl = url
    // SVG / data URL 不能可靠走 TextureLoader，先栅格到 canvas 再贴图
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      this.loading.delete(url)
      if (this.disposed) return
      try {
        const tex = this.rasterTexture(img)
        this.texCache.set(url, tex)
        let hit = 0
        for (const m of this.layers.values()) {
          if (m.userData.pendingUrl === url || m.userData.url === url) {
            this.setMap(m, tex, url)
            delete m.userData.pendingUrl
            hit++
          }
        }
        if (hit > 0) this.render()
      } catch {
        /* ignore decode errors */
      }
    }
    img.onerror = () => {
      this.loading.delete(url)
    }
    // 部分环境下 SVG data URL 需显式尺寸；用 decode 更稳
    img.src = url
  }

  /** 把任意 Image（含 SVG data URL）画成 CanvasTexture，WebGL 可上传 */
  private rasterTexture(img: HTMLImageElement): THREE.Texture {
    const w = Math.max(1, img.naturalWidth || img.width || 1)
    const h = Math.max(1, img.naturalHeight || img.height || 1)
    const max = this.maxEdge
    const scale = Math.max(w, h) > max ? max / Math.max(w, h) : 1
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * scale))
    c.height = Math.max(1, Math.round(h * scale))
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  private setMap(mesh: LayerMesh, tex: THREE.Texture, key: string) {
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.map = tex
    mat.needsUpdate = true
    mesh.userData.url = key
    const img = tex.image as { width?: number; height?: number } | undefined
    if (img?.width && img?.height) {
      const ar = img.width / img.height
      mesh.geometry.dispose()
      mesh.geometry = new THREE.PlaneGeometry(ar > 1 ? ar : 1, ar > 1 ? 1 : 1 / ar)
    }
  }

  private textTexture(clip: Clip): THREE.Texture {
    const t = clip.text!
    const c = document.createElement('canvas')
    c.width = 1024
    c.height = 512
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.fillStyle = t.color
    ctx.font = `${t.fontSize * 2}px ${t.fontFamily}, sans-serif`
    ctx.textAlign = t.align
    ctx.textBaseline = 'middle'
    const x = t.align === 'left' ? 40 : t.align === 'right' ? c.width - 40 : c.width / 2
    ctx.fillText(t.content, x, c.height / 2)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.premultiplyAlpha = false
    return tex
  }
}

type Transform3DLike = {
  x: number; y: number; z: number
  rotationX: number; rotationY: number; rotationZ: number
  scaleX: number; scaleY: number; opacity: number
}
