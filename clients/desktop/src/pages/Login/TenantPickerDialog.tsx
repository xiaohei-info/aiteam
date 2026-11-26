import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Building2 } from 'lucide-react'
import './TenantPickerDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import type { TenantCandidate } from '../../lib/loginFailure'

interface TenantPickerDialogProps {
  account: string
  candidates: readonly TenantCandidate[]
  onPick: (candidate: TenantCandidate) => void
  onCancel: () => void
}

/** 同一账号属于多个企业时，让用户选择这次要登录的企业。 */
export default function TenantPickerDialog({ account, candidates, onPick, onCancel }: TenantPickerDialogProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>()

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onCancel])

  return createPortal(
    <div className="tpd-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div
        ref={dialogRef}
        className="tpd"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tpd-title"
        aria-describedby="tpd-description"
        tabIndex={-1}
      >
        <div className="tpd-header">
          <div className="tpd-title" id="tpd-title">选择要登录的企业</div>
          <div className="tpd-desc" id="tpd-description">账号 {account} 属于多个企业，请选择这次要登录的企业。</div>
        </div>
        <ul className="tpd-list" aria-label="可登录的企业">
          {candidates.map((candidate) => (
            <li key={candidate.tenant_id}>
              <button type="button" className="tpd-item" onClick={() => onPick(candidate)}>
                <Building2 size={16} aria-hidden="true" />
                <span className="tpd-item-name">{candidate.enterprise_name}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="tpd-footer">
          <button type="button" className="tpd-btn" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
