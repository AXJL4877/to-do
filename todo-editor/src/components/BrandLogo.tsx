export function BrandMark({ size = 32 }: { size?: number }) {
  const boltId = `bolt-cut-${size}`
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
      <defs>
        <clipPath id={boltId}>
          <path
            fillRule="evenodd"
            d="M0 0H128V128H0Z M62 10 L52 42 H60 L48 78 L78 42 H68 L76 10 Z"
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${boltId})`}>
        <path fill="#2F6BFF" d="M64 6 L38 54 L20 82 L46 92 L54 70 L50 48 L64 22 Z" />
        <path fill="#0B1424" d="M64 6 L78 22 L74 48 L70 70 L78 92 L104 82 L86 54 Z" />
      </g>
      <path fill="#2F6BFF" d="M54 86 L54 110 L76 98 Z" />
      <path fill="#0B1424" d="M14 90 L42 97 L39 112 L10 105 Z" />
      <g fill="#F4F0EA">
        <rect x="16" y="95" width="3.5" height="5.5" rx="0.6" transform="rotate(-14 16 95)" />
        <rect x="23" y="96.5" width="3.5" height="5.5" rx="0.6" transform="rotate(-14 23 96.5)" />
        <rect x="30" y="98" width="3.5" height="5.5" rx="0.6" transform="rotate(-14 30 98)" />
        <rect x="37" y="99.5" width="3.5" height="5.5" rx="0.6" transform="rotate(-14 37 99.5)" />
      </g>
      <path fill="#0B1424" d="M82 97 L110 90 L114 105 L85 112 Z" />
      <g fill="#F4F0EA">
        <rect x="88" y="95" width="3.5" height="5.5" rx="0.6" transform="rotate(14 88 95)" />
        <rect x="95" y="96.5" width="3.5" height="5.5" rx="0.6" transform="rotate(14 95 96.5)" />
        <rect x="102" y="98" width="3.5" height="5.5" rx="0.6" transform="rotate(14 102 98)" />
        <rect x="109" y="99.5" width="3.5" height="5.5" rx="0.6" transform="rotate(14 109 99.5)" />
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
          background: '#F4F0EA',
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
