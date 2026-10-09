/** 按 public/brand-logo.png 描的矢量：雪山（蓝 / 深蓝两面 + 白色闪电）、播放三角、两侧胶片 */
const LEFT_HOLES = [[220, 600], [268, 626], [316, 652], [364, 678]]
const RIGHT_HOLES = [[664, 680], [711, 655], [758, 630], [805, 605]]

export function BrandMark({ size = 32, cut = '#f0f0f0' }: { size?: number; cut?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      aria-hidden
      className="shrink-0 block"
    >
      <g transform="translate(-24.4 -22.6) scale(0.1705)">
        <path fill="#707070" d="M513 250 L402 384 L386 377 L250 553 L455 655 L455 562 L500 430 Z" />
        <path fill="#1c1c1c" d="M513 250 L624 384 L641 377 L776 553 L620 640 L463 552 L500 430 Z" />
        <path fill={cut} d="M514 256 L570 504 L502 428 L349 558 L388 380 L424 406 Z" />
        <path fill="#707070" d="M478 590 L610 665 L478 760 Z" />
        <path fill="#1c1c1c" d="M193 553 L456 688 L456 762 L193 625 Z" />
        <path fill="#1c1c1c" d="M633 655 L834 553 L834 624 L633 732 Z" />
        <g fill={cut}>
          {LEFT_HOLES.map(([x, y]) => <rect key={x} x={x - 11} y={y - 15} width="22" height="30" rx="5" />)}
          {RIGHT_HOLES.map(([x, y]) => <rect key={x} x={x - 11} y={y - 15} width="22" height="30" rx="5" />)}
        </g>
      </g>
    </svg>
  )
}

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  const size = compact ? 28 : 32
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="brand-logo">
      <div
        className="shrink-0 grid place-items-center overflow-hidden"
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          background: '#f0f0f0',
        }}
      >
        <BrandMark size={Math.round(size * 0.92)} />
      </div>
      <div className="min-w-0 leading-none">
        <div className="brand-mark" style={{ fontSize: compact ? '1rem' : '1.25rem' }}>TO DO</div>
        {!compact && <div className="eyebrow mt-0.5">Editor</div>}
      </div>
    </div>
  )
}
