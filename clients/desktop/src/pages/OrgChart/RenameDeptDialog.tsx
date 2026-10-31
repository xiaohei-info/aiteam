import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil } from 'lucide-react'
import '../../components/Chat/CreateAgentDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { isImeKeyboardEvent } from '../../lib/imeKeyboard'
import { describeOrgError, type ApiDepartment } from './api'
import { MAX_DEPARTMENT_NAME_LENGTH, renameDepartment } from './orgTree'

interface Props {
  department: { id: string; name: string }
  departments: readonly ApiDepartment[]
  onClose: () => void
  // 保存到后台；抛错则对话框保持打开并显示原因。
  onRenamed: (departments: ApiDepartment[], name: string) => Promise<void>
}

export function RenameDeptDialog({ department, departments, onClose, onRenamed }: Props) {
  const [name, setName] = useState(department.name)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const dialogRef = useDialogFocus<HTMLDivElement>()
  const result = renameDepartment(departments, department.id, name)
  const error = serverError ?? (!result.ok && name.trim() && name.trim() !== department.name ? result.reason : null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving && !isImeKeyboardEvent(e, composingRef.current)) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = async () => {
    if (!result.ok || saving) return
    setSaving(true)
    setServerError(null)
    try {
      await onRenamed(result.departments, name.trim())
      onClose()
    } catch (err) {
      setServerError(describeOrgError(err, '重命名失败，请稍后重试'))
      setSaving(false)
    }
  }

  return createPortal(
    <div ref={overlayRef} className="cad-overlay" onClick={e => { if (e.target === overlayRef.current && !saving) onClose() }}>
      <div ref={dialogRef} className="cad" style={{ width: 440 }} role="dialog" aria-modal="true" aria-labelledby="rename-department-title" tabIndex={-1}>
        <div className="cad-header">
          <div className="cad-header-icon"><Pencil size={20} strokeWidth={1.7} /></div>
          <div>
            <div className="cad-header-title" id="rename-department-title">重命名部门</div>
            <div className="cad-header-sub">只修改名称，部门位置和员工不变</div>
          </div>
        </div>
        <div className="cad-fields">
          <div className="cad-field">
            <label className="cad-label" htmlFor="rename-department-name">部门名称</label>
            <input
              id="rename-department-name"
              className="cad-input"
              value={name}
              maxLength={MAX_DEPARTMENT_NAME_LENGTH}
              onChange={e => { setName(e.target.value); setServerError(null) }}
              disabled={saving}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={e => {
                // 拼音输入法用 Enter 确认候选词，此时不能提交半截名称
                if (e.key === 'Enter' && !isImeKeyboardEvent(e.nativeEvent, composingRef.current)) void submit()
              }}
              aria-invalid={Boolean(error)}
              autoFocus
              onFocus={e => e.currentTarget.select()}
            />
            {error && <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}
          </div>
        </div>
        <div className="cad-footer">
          <button type="button" className="cad-btn-cancel" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="cad-btn-submit" onClick={() => void submit()} disabled={!result.ok || saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
