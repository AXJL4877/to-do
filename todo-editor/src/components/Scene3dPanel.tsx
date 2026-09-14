import { useState } from 'react'
import { Box, ChevronDown, ChevronRight, Video } from 'lucide-react'
import { useApp } from '../store'
import { NumInput } from './NumInput'
import { PropSection } from './PropUI'
import { ensureScene3d } from '../lib/scene3d'
import { defaultTransform3d } from '../types'

/** 3D：默认只露开关与常用 Z/相机 Z；细节折叠 */
export function Scene3dPanel() {
  const seq = useApp((s) => s.seq())
  const scene = ensureScene3d(seq.scene3d)
  const cam = scene.camera
  const selectedClipIds = useApp((s) => s.selectedClipIds)
  const clip = seq.clips.find((c) => selectedClipIds.includes(c.id))
  const updateScene3d = useApp((s) => s.updateScene3d)
  const updateCamera3d = useApp((s) => s.updateCamera3d)
  const toggleCameraKeyframe = useApp((s) => s.toggleCameraKeyframe)
  const setClipThreeD = useApp((s) => s.setClipThreeD)
  const updateSelectedTransform3d = useApp((s) => s.updateSelectedTransform3d)
  const setMonitorCompose = useApp((s) => s.setMonitorCompose)
  const monitorCompose = useApp((s) => s.monitorCompose)
  const t3 = clip?.transform3d ?? defaultTransform3d()
  const [moreCam, setMoreCam] = useState(false)
  const [moreLayer, setMoreLayer] = useState(false)

  const camRow = (label: string, prop: string, value: number, onChange: (v: number) => void, opts?: { min?: number; max?: number; step?: number }) => (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] w-14 shrink-0" style={{ color: 'var(--text-secondary)' }} title={label}>{label}</span>
      <NumInput value={value} min={opts?.min} max={opts?.max} step={opts?.step ?? 0.01} testId={`cam-${prop}`} onChange={onChange} />
      <button
        type="button"
        className="icon-btn"
        style={{ width: 22, height: 22 }}
        title={`${label}：在播放头打/删关键帧`}
        aria-label={`${label} 关键帧`}
        data-testid={`cam-kf-${prop}`}
        onClick={() => toggleCameraKeyframe(prop)}
      >
        ◆
      </button>
    </div>
  )

  return (
    <div className="flex flex-col gap-2.5 p-2" data-testid="scene3d-panel">
      <label className="flex items-center gap-2 text-[12px] cursor-pointer px-0.5" title="开启后节目监视器使用虚拟摄像机透视">
        <input
          type="checkbox"
          checked={scene.enabled || monitorCompose === '3d'}
          data-testid="scene3d-enabled"
          onChange={(e) => {
            updateScene3d({ enabled: e.target.checked })
            setMonitorCompose(e.target.checked ? '3d' : '2d')
          }}
        />
        启用 3D 摄像机
      </label>

      <PropSection title="相机">
        <div className="flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
          <Video size={12} />
          <span className="text-[10px]">推拉主要调 Z / 视场角</span>
        </div>
        {camRow('深度 Z', 'camZ', cam.z, (v) => updateCamera3d({ z: v }), { min: 0.2, max: 80, step: 0.05 })}
        {camRow('视场角', 'fov', cam.fov, (v) => updateCamera3d({ fov: v }), { min: 10, max: 120, step: 0.5 })}
        <button
          type="button"
          className="btn btn-ghost w-full justify-start text-[11px]"
          data-testid="cam-more-toggle"
          title="展开位置、旋转等次要参数"
          onClick={() => setMoreCam((v) => !v)}
        >
          {moreCam ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {moreCam ? '收起相机细节' : '更多相机参数'}
        </button>
        {moreCam && (
          <>
            {camRow('位置 X', 'camX', cam.x, (v) => updateCamera3d({ x: v }))}
            {camRow('位置 Y', 'camY', cam.y, (v) => updateCamera3d({ y: v }))}
            {camRow('旋转 X', 'camRotX', cam.rotationX, (v) => updateCamera3d({ rotationX: v }), { step: 0.5 })}
            {camRow('旋转 Y', 'camRotY', cam.rotationY, (v) => updateCamera3d({ rotationY: v }), { step: 0.5 })}
            {camRow('旋转 Z', 'camRotZ', cam.rotationZ, (v) => updateCamera3d({ rotationZ: v }), { step: 0.5 })}
            {camRow('对焦距', 'focusDistance', cam.focusDistance, (v) => updateCamera3d({ focusDistance: v }), { min: 0.1, max: 100, step: 0.05 })}
            <div className="flex items-center gap-2">
              <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }} title="环境光强度">环境光</span>
              <NumInput value={scene.ambient} min={0} max={2} step={0.05} testId="scene3d-ambient" onChange={(v) => updateScene3d({ ambient: v })} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }} title="雾浓度">雾</span>
              <NumInput value={scene.fog} min={0} max={1} step={0.02} testId="scene3d-fog" onChange={(v) => updateScene3d({ fog: v })} />
            </div>
          </>
        )}
      </PropSection>

      {clip && (
        <PropSection title="图层">
          <div className="flex items-center gap-1 mb-1" style={{ color: 'var(--text-muted)' }}>
            <Box size={12} />
            <span className="text-[10px] truncate" title={clip.name}>{clip.name}</span>
          </div>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer" title="把该片段当作 3D 空间中的平面">
            <input
              type="checkbox"
              checked={!!clip.threeD}
              data-testid="clip-three-d"
              onChange={(e) => setClipThreeD(e.target.checked)}
            />
            作为 3D 平面
          </label>
          {clip.threeD && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }} title="图层深度，越大越靠近相机前方">深度 Z</span>
                <NumInput value={t3.z} min={-20} max={20} step={0.05} testId="layer-z" onChange={(v) => updateSelectedTransform3d({ z: v })} />
              </div>
              <button
                type="button"
                className="btn btn-ghost w-full justify-start text-[11px]"
                data-testid="layer-more-toggle"
                title="展开绕轴旋转"
                onClick={() => setMoreLayer((v) => !v)}
              >
                {moreLayer ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {moreLayer ? '收起旋转' : '更多旋转'}
              </button>
              {moreLayer && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }}>绕 X</span>
                    <NumInput value={t3.rotationX} step={0.5} testId="layer-rotx" onChange={(v) => updateSelectedTransform3d({ rotationX: v })} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }}>绕 Y</span>
                    <NumInput value={t3.rotationY} step={0.5} testId="layer-roty" onChange={(v) => updateSelectedTransform3d({ rotationY: v })} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] w-14" style={{ color: 'var(--text-secondary)' }}>绕 Z</span>
                    <NumInput value={t3.rotationZ} step={0.5} testId="layer-rotz" onChange={(v) => updateSelectedTransform3d({ rotationZ: v })} />
                  </div>
                </>
              )}
            </>
          )}
        </PropSection>
      )}
    </div>
  )
}
