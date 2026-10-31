import './GoldenDotsLoading.css'

interface GoldenDotsLoadingProps {
  label?: string
  className?: string
  size?: 'sm' | 'md'
}

export default function GoldenDotsLoading({
  label = '加载中',
  className = '',
  size = 'md',
}: GoldenDotsLoadingProps) {
  const classes = ['gdl', `gdl-${size}`, className].filter(Boolean).join(' ')

  return (
    <div className={classes} role="status" aria-label={label}>
      <span className="gdl-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="gdl-label">{label}</span>
    </div>
  )
}
