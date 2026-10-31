/** 员工不可用事件确认后跨登录、重启不重复提示。 */
import { useEffect, useState } from 'react'
import { agentApi } from '../api/agent'
import type { ExpertProjection } from '../api/agent/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../hooks/useGlobalShortcut'
import { acknowledgeNotice, employeeUnavailableMessage, isNoticeAcknowledged, unavailableNoticeKey } from '../lib/employeeAvailability'
import { useAgentAuthStore } from '../stores/agentAuth'
import './GrantsSyncNotice.css'

export default function GrantsSyncNotice() {
  const generation = useAgentAuthStore((s) => s.sessionGeneration)
  const skipped = useAgentAuthStore((s) => s.grantsSyncSkipped)
  const tenantId = useAgentAuthStore((s) => s.tenantId)
  const memberId = useAgentAuthStore((s) => s.claims?.user_id)
  const [employees, setEmployees] = useState<ExpertProjection[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const pending = employees.flatMap((employee) => {
    const message = employeeUnavailableMessage(employee)
    if (!message || !tenantId || !memberId) return []
    const key = unavailableNoticeKey(tenantId, memberId, employee.employee_id, employee.availability_revision ?? `${employee.version}:${employee.status}`)
    if (dismissed.includes(key) || isNoticeAcknowledged(localStorage, key)) return []
    return [{ employee, message, key }]
  })
  const isOpen = pending.length > 0
  const close = () => {
    for (const { key } of pending) acknowledgeNotice(localStorage, key)
    setDismissed((previous) => [...previous, ...pending.map(({ key }) => key)])
  }
  const dialogRef = useDialogFocus<HTMLDivElement>({ active: isOpen })
  useGlobalShortcutClose({ active: isOpen, onClose: close })

  useEffect(() => {
    let cancelled = false
    void agentApi.listExperts()
      .then(({ experts }) => { if (!cancelled && useAgentAuthStore.getState().sessionGeneration === generation) setEmployees(experts) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [skipped, generation])

  if (!isOpen) return null

  return (
    <div className="grants-sync-notice-overlay" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <div ref={dialogRef} className="grants-sync-notice" role="dialog" aria-modal="true" aria-labelledby="grants-sync-notice-title" aria-describedby="grants-sync-notice-description" tabIndex={-1}>
        <div className="grants-sync-notice__body">
          <p className="grants-sync-notice__title" id="grants-sync-notice-title">部分员工暂不可用</p>
          <div className="grants-sync-notice__employees">{pending.map(({ employee, message, key }) => <p key={key}>{employee.display_name}：{message}</p>)}</div>
          <p id="grants-sync-notice-description">历史消息仍可查看，其他员工不受影响。确认后不再重复提示本次状态变化。</p>
        </div>
        <div className="grants-sync-notice__actions">
          <button type="button" className="grants-sync-notice__button grants-sync-notice__button--primary" onClick={close}>我知道了</button>
        </div>
      </div>
    </div>
  )
}
