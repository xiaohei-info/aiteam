import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import '../../components/Chat/CreateAgentDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { describeOrgError } from './api'

interface Props {
  department: { id: string; name: string }
  onClose: () => void
  // 保存到后台；抛错则对话框保持打开并显示原因。
  onConfirm: () => Promise<void>
}

export function DeleteDeptDialog({ department, onClose, onConfirm }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useDialogFocus<HTMLDivElement>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !deleting) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, deleting])

  const submit = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(describeOrgError(err, '删除失败，请稍后重试'))
      setDeleting(false)
    }
  }

  return createPortal(
    <div ref={overlayRef} className="cad-overlay" onClick={e => { if (e.target === overlayRef.current && !deleting) onClose() }}>
      <div ref={dialogRef} className="cad" style={{ width: 440 }} role="dialog" aria-modal="true" aria-labelledby="delete-department-title" tabIndex={-1}>
        <div className="cad-header">
          <div className="cad-header-icon"><Trash2 size={20} strokeWidth={1.7} /></div>
          <div>
            <div className="cad-header-title" id="delete-department-title">删除部门「{department.name}」</div>
            <div className="cad-header-sub">子部门会上移到它的上级；员工不会被删除，只是不再属于这个部门</div>
          </div>
        </div>
        {error && <div role="alert" style={{ fontSize: 12, color: '#f87171', padding: '0 20px' }}>{error}</div>}
        <div className="cad-footer">
          <button type="button" className="cad-btn-cancel" onClick={onClose} disabled={deleting}>取消</button>
          <button type="button" className="cad-btn-submit" onClick={() => void submit()} disabled={deleting} autoFocus>{deleting ? '删除中…' : '确认删除'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
