import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { UserPlus, X } from 'lucide-react'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'

interface RecruitAliasDialogProps {
  talentName: string
  submitting: boolean
  onCancel: () => void
  onConfirm: (alias: string) => void
}

export default function RecruitAliasDialog({
  talentName,
  submitting,
  onCancel,
  onConfirm,
}: RecruitAliasDialogProps) {
  const [alias, setAlias] = useState(talentName)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useDialogFocus<HTMLFormElement>({ initialFocusRef: inputRef })
  const trimmedAlias = alias.trim()

  useGlobalShortcutClose({ onClose: () => { if (!submitting) onCancel() } })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, submitting])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!trimmedAlias || submitting) return
    onConfirm(trimmedAlias)
  }

  return createPortal(
    <div
      className="tm-alias-overlay"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !submitting) onCancel()
      }}
    >
      <form
        className="tm-alias-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tm-alias-title"
        aria-describedby="tm-alias-description"
        tabIndex={-1}
        onSubmit={handleSubmit}
      >
        <div className="tm-alias-header">
          <span className="tm-alias-icon" aria-hidden="true">
            <UserPlus size={19} strokeWidth={1.8} />
          </span>
          <div>
            <h2 id="tm-alias-title">设置人才别名</h2>
            <p id="tm-alias-description">为“{talentName}”设置一个加入团队后使用的名称。</p>
          </div>
          <button
            className="tm-alias-close"
            type="button"
            aria-label="关闭"
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭招募确认（⌘W / Ctrl+W）"
            disabled={submitting}
            onClick={onCancel}
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        <label className="tm-alias-field">
          <span>人才别名</span>
          <input
            ref={inputRef}
            value={alias}
            maxLength={50}
            placeholder="请输入人才别名"
            disabled={submitting}
            onChange={event => setAlias(event.target.value)}
          />
          <small>{alias.length}/50</small>
        </label>

        <div className="tm-alias-actions">
          <button type="button" disabled={submitting} onClick={onCancel}>取消</button>
          <button className="primary" type="submit" disabled={!trimmedAlias || submitting}>
            {submitting ? '招募中…' : '确认'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
