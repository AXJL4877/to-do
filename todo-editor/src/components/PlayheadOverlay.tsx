import { useSyncExternalStore } from 'react'
import { getLivePlayhead, subscribeLivePlayhead } from '../lib/livePlayhead'

type Props = {
  xAt: (t: number) => number
}

/** 始终读 live 时钟；纯展示，不可单独拖（时间轴空白处点击/拖动才改播放头） */
export function PlayheadOverlay({ xAt }: Props) {
  const live = useSyncExternalStore(subscribeLivePlayhead, getLivePlayhead, getLivePlayhead)
  const left = xAt(live)

  return (
    <div
      className="absolute top-0 bottom-0 z-30 pointer-events-none"
      style={{ left: left - 1, width: 2 }}
      data-testid="playhead-layer"
    >
      <div
        className="absolute top-0 bottom-0 left-0 w-0.5"
        style={{ background: 'var(--accent)' }}
        data-testid="playhead"
      />
    </div>
  )
}

/** K 帧图播放头：mapT 把绝对时间映射到 0..1 */
export function KfPlayheadLine({ mapT }: { mapT: (absT: number) => number }) {
  const live = useSyncExternalStore(subscribeLivePlayhead, getLivePlayhead, getLivePlayhead)
  const pct = Math.max(0, Math.min(1, mapT(live))) * 100
  return <div className="pr-kf-playhead" style={{ left: `${pct}%` }} data-testid="kf-playhead" />
}
