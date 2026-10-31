import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { UserCog, ChevronDown } from 'lucide-react'
import '../../components/Chat/CreateAgentDialog.css'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import type { ApiEmployee, ApiDepartment } from './api'
import { assignEmployeeDepartment } from './api'
import { listAssignableDepartments } from './orgTree'

interface Props {
  emp: ApiEmployee
  departments: ApiDepartment[]
  onClose: () => void
  onSaved: () => void
}

// 服务端是“追加部门”语义，因此只列出员工尚未所属的部门。
export function AssignDepartmentDialog({ emp, departments, onClose, onSaved }: Props) {
  const options = useMemo(() => listAssignableDepartments(departments, emp.employee_id), [departments, emp.employee_id])
  const [deptId, setDeptId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useDialogFocus<HTMLDivElement>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const handleSave = async () => {
    if (!deptId || saving) return
    setSaving(true)
    setError(null)
    try {
      await assignEmployeeDepartment(emp.employee_id, deptId)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '分配部门失败，请重试')
      setSaving(false)
    }
  }

  return createPortal(
    <div
      ref={overlayRef}
      className="cad-overlay"
      onClick={e => { if (e.target === overlayRef.current && !saving) onClose() }}
    >
      <div ref={dialogRef} className="cad" style={{ width: 440 }} role="dialog" aria-modal="true" aria-labelledby="assign-department-title" aria-describedby="assign-department-description" tabIndex={-1}>
        <div className="cad-header">
          <div className="cad-header-icon">
            <UserCog size={20} strokeWidth={1.7} />
          </div>
          <div>
            <div className="cad-header-title" id="assign-department-title">分配部门</div>
            <div className="cad-header-sub" id="assign-department-description">{emp.display_name} · 将追加到所选部门，不会移出已有部门</div>
          </div>
        </div>

        <div className="cad-fields">
          <div className="cad-field">
            <label className="cad-label" htmlFor="assign-department-select">追加到部门</label>
            {options.length === 0 ? (
              <div role="status" style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无可追加的部门（员工已属于全部部门，或还没有添加部门）。</div>
            ) : (
              <div className="cad-select-wrap">
                <select
                  id="assign-department-select"
                  className="cad-select"
                  value={deptId}
                  onChange={e => setDeptId(e.target.value)}
                  disabled={saving}
                >
                  <option value="">— 请选择部门 —</option>
                  {options.map(d => (
                    <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>
                  ))}
                </select>
                <ChevronDown className="cad-select-chevron" size={14} strokeWidth={1.6} />
              </div>
            )}
          </div>
          {error && <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}
        </div>

        <div className="cad-footer">
          <button type="button" className="cad-btn-cancel" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="cad-btn-submit" onClick={() => void handleSave()} disabled={!deptId || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
