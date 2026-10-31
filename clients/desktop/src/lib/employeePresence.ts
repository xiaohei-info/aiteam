export interface AuthoritativeEmployeePresence {
  online_status?: string | null
  last_seen_at?: string | null
}

export interface EmployeePresenceDisplay {
  known: boolean
  label: string
  lastSeenLabel: string
}

export const EMPLOYEE_PRESENCE_UNAVAILABLE: EmployeePresenceDisplay = Object.freeze({
  known: false,
  label: '在线状态未提供',
  lastSeenLabel: '最后在线时间未提供',
})

/**
 * 在线状态只能消费 B1 约定的权威字段。生命周期 status、readiness 与 Office
 * 工作状态即使被误传进来也不会被当作在线状态。
 */
export function resolveEmployeePresence(
  source?: AuthoritativeEmployeePresence | null,
): EmployeePresenceDisplay {
  const status = source?.online_status?.trim().toLowerCase()
  if (status !== 'online' && status !== 'offline' && status !== 'busy') {
    return EMPLOYEE_PRESENCE_UNAVAILABLE
  }

  const label = status === 'online' ? '在线' : status === 'busy' ? '忙碌' : '离线'
  const lastSeenAt = source?.last_seen_at?.trim()
  return {
    known: true,
    label,
    lastSeenLabel: lastSeenAt ? `最后在线：${lastSeenAt}` : '最后在线时间未提供',
  }
}
