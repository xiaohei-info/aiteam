import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Wallet } from 'lucide-react'
import './RechargePromptDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { useBillingStore } from '../../stores/billing'

export default function RechargePromptDialog() {
  const isOpen = useBillingStore((s) => s.isRechargePromptOpen)
  const message = useBillingStore((s) => s.rechargeMessage)
  const close = useBillingStore((s) => s.closeRechargePrompt)
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: isOpen })

  useGlobalShortcutClose({ active: isOpen, onClose: close })

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, close])

  if (!isOpen) return null

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close()
  }

  return createPortal(
    <div className="rpd-overlay" onClick={handleOverlayClick}>
      <div ref={dialogRef} className="rpd" role="dialog" aria-modal="true" aria-labelledby="rpd-title" aria-describedby="rpd-description" tabIndex={-1}>
        <div className="rpd-body">
          <div className="rpd-icon" aria-hidden="true">
            <Wallet size={22} strokeWidth={1.8} />
          </div>
          <div className="rpd-title" id="rpd-title">账户余额不足</div>
          <div className="rpd-desc" id="rpd-description">{message}</div>
        </div>
        <div className="rpd-footer">
          <button
            type="button"
            className="rpd-btn"
            onClick={close}
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭提示（⌘W / Ctrl+W）"
          >
            稍后再说
          </button>
          <button type="button" className="rpd-btn rpd-btn--primary" onClick={close}>
            我知道了
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
