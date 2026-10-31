import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Building2, Sparkles } from 'lucide-react'
import '../../components/Chat/CreateAgentDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { isImeKeyboardEvent } from '../../lib/imeKeyboard'
import { createDepartment, type ApiDepartment } from './api'
import { hasDepartmentNamed } from './orgTree'

interface Props {
  departments: readonly ApiDepartment[]
  onClose: () => void
  onCreated: () => void
}

export default function CreateDeptDialog({ departments, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const dialogRef = useDialogFocus<HTMLDivElement>()
  const trimmed = name.trim()
  const duplicate = hasDepartmentNamed(departments, trimmed)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving && !isImeKeyboardEvent(e, composingRef.current)) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const handleSubmit = async () => {
    if (!trimmed || duplicate || saving) return
    setSaving(true)
    setError(null)
    try {
      await createDepartment(trimmed)
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '创建部门失败，请重试')
      setSaving(false)
    }
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="cad-overlay"
      onClick={e => { if (e.target === overlayRef.current && !saving) onClose() }}
    >
      <div ref={dialogRef} className="cad" style={{ width: 440 }} role="dialog" aria-modal="true" aria-labelledby="create-department-title" aria-describedby="create-department-description" tabIndex={-1}>
        <div className="cad-header">
          <div className="cad-header-icon">
            <Building2 size={20} strokeWidth={1.7} />
          </div>
          <div>
            <div className="cad-header-title" id="create-department-title">新建部门</div>
            <div className="cad-header-sub" id="create-department-description">创建后可在员工菜单中把员工分配到该部门</div>
          </div>
        </div>

        <div className="cad-fields">
          <div className="cad-field">
            <label className="cad-label" htmlFor="create-department-name">部门名称</label>
            <input
              id="create-department-name"
              className="cad-input"
              placeholder="例如：运营部"
              value={name}
              maxLength={64}
              onChange={e => setName(e.target.value)}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={e => {
                // 拼音输入法用 Enter 确认候选词，此时不能提交半截部门名
                if (e.key === 'Enter' && !isImeKeyboardEvent(e.nativeEvent, composingRef.current)) void handleSubmit()
              }}
              autoFocus
              disabled={saving}
              aria-invalid={duplicate}
              aria-describedby={duplicate ? 'create-department-duplicate' : undefined}
            />
            {duplicate && <div id="create-department-duplicate" style={{ fontSize: 12, color: '#f87171' }}>已有同名部门，请换一个名称</div>}
          </div>
          {error && <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}
        </div>

        <div className="cad-footer">
          <button type="button" className="cad-btn-cancel" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="cad-btn-submit" onClick={() => void handleSubmit()} disabled={!trimmed || duplicate || saving}>
            <Sparkles size={14} strokeWidth={1.7} />
            {saving ? '创建中…' : '创建部门'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
