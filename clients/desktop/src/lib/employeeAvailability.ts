export interface EmployeeAvailability {
  availability_reason?: string
  availability_revision?: string
  status?: string
}

export function employeeUnavailableMessage(employee?: EmployeeAvailability): string | null {
  if (!employee) return null
  if (employee.availability_reason === 'employee_dependency_unavailable') return '员工使用的模型暂不可用，无法继续对话'
  if (employee.status === 'paused') return '员工已暂停，无法继续对话'
  if (employee.availability_reason === 'employee_unavailable' || employee.status === 'archived') return '员工已下架，无法继续对话'
  if (employee.status && employee.status !== 'active') return '员工暂不可用，无法继续对话'
  return null
}

export function unavailableNoticeKey(tenantId: string, memberId: string, employeeId: string, revision: string): string {
  return `aiteam:employee-unavailable:${JSON.stringify([tenantId, memberId, employeeId, revision])}`
}

export function isNoticeAcknowledged(storage: Pick<Storage, 'getItem'>, key: string): boolean {
  try { return storage.getItem(key) === '1' } catch { return false }
}

export function acknowledgeNotice(storage: Pick<Storage, 'setItem'>, key: string): void {
  try { storage.setItem(key, '1') } catch { /* Memory dismissal still applies when storage is unavailable. */ }
}
