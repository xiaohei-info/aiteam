import { CloudOff, RefreshCw, ShieldAlert, TriangleAlert, WifiOff } from 'lucide-react'
import './RequestErrorState.css'
import type { RequestErrorInfo } from '../../lib/requestError'

interface RequestErrorStateProps {
  error: RequestErrorInfo
  onRetry: () => void
  retryLabel?: string
  retrying?: boolean
  compact?: boolean
  className?: string
}

const ERROR_ICONS = {
  forbidden: ShieldAlert,
  unavailable: CloudOff,
  network: WifiOff,
  unknown: TriangleAlert,
}

export default function RequestErrorState({
  error,
  onRetry,
  retryLabel = '重试',
  retrying = false,
  compact = false,
  className = '',
}: RequestErrorStateProps) {
  const Icon = ERROR_ICONS[error.kind]
  const classes = ['rs-error', compact ? 'compact' : '', className].filter(Boolean).join(' ')

  return (
    <div className={classes} data-kind={error.kind} role="alert">
      <span className="rs-error-icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <div className="rs-error-copy">
        <strong>{error.title}</strong>
        <span>{error.message}</span>
      </div>
      <button className="rs-error-retry" disabled={retrying} onClick={onRetry} type="button">
        <RefreshCw className={retrying ? 'spinning' : undefined} size={14} strokeWidth={1.9} />
        {retrying ? '重试中' : retryLabel}
      </button>
    </div>
  )
}
