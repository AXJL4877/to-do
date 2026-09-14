import { useRef } from 'react'
import { KeyframeEditor } from './KeyframeEditor'
import { Timeline } from './Timeline'
import clsx from 'clsx'

/** 时间轴 + 脱离的 K 帧轴：共享横向滚动，高度互不挤占 */
export function TimelineDock({ fill = false }: { fill?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <div
      className={clsx('flex flex-col min-h-0', fill ? 'flex-1 h-full' : 'shrink-0')}
      data-testid="timeline-dock"
    >
      <KeyframeEditor scrollRef={scrollRef} />
      <Timeline scrollRef={scrollRef} fill={fill} />
    </div>
  )
}
