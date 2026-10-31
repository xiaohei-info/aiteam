export type ServiceWriteStatus = 'available' | 'gone' | 'not_implemented' | 'integration_incomplete' | 'unavailable'

export interface ServiceWriteAvailability {
  enabled: boolean
  reason: string
  status: ServiceWriteStatus
}

const STATUS_REASONS: Record<Exclude<ServiceWriteStatus, 'available'>, string> = {
  gone: '知识库服务当前返回 410；新建、上传、绑定与重试暂不可用。',
  not_implemented: '当前服务未开放部门及员工编辑。',
  integration_incomplete: '暂停与恢复仅限企业所有者或管理员在管理端操作；当前客户端尚未接入员工生命周期写接口，且服务端尚未定义运行中任务的处理规则。',
  unavailable: '服务当前不可用，请稍后重试。',
}

export function getServiceWriteAvailability(status: ServiceWriteStatus): ServiceWriteAvailability {
  return status === 'available'
    ? { enabled: true, reason: '', status }
    : { enabled: false, reason: STATUS_REASONS[status], status }
}

export function isWriteActionDisabled(
  availability: ServiceWriteAvailability,
  isPending = false,
): boolean {
  return !availability.enabled || isPending
}

export const KNOWLEDGE_BASE_WRITE_AVAILABILITY: ServiceWriteAvailability = {
  enabled: false,
  status: 'integration_incomplete',
  reason: '当前服务未开放知识库管理，新建、上传、绑定与重试暂不可用。',
}
const ORG_CHART_MANAGE_ROLES: readonly string[] = ['owner', 'enterprise_admin']
// 非所有者/管理员时的不可用态；服务端会再次校验角色，这里只负责前端提示。
export const ORG_CHART_WRITE_AVAILABILITY: ServiceWriteAvailability = {
  enabled: false,
  status: 'unavailable',
  reason: '仅企业所有者或管理员可添加部门、为员工追加部门。',
}
export function getOrgChartWriteAvailability(roles: readonly string[] | null | undefined): ServiceWriteAvailability {
  return roles?.some(role => ORG_CHART_MANAGE_ROLES.includes(role))
    ? getServiceWriteAvailability('available')
    : ORG_CHART_WRITE_AVAILABILITY
}
export const ORG_EMPLOYEE_TRANSFER_AVAILABILITY: ServiceWriteAvailability = {
  enabled: false,
  status: 'not_implemented',
  reason: '当前服务未开放员工调动。',
}
export const EMPLOYEE_SERVICE_CONTROL_AVAILABILITY = getServiceWriteAvailability('integration_incomplete')
