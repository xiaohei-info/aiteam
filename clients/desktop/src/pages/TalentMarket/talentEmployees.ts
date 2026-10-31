import type { ExpertProjection } from '../../api/agent/types'
import { employeeUnavailableMessage } from '../../lib/employeeAvailability.ts'

export interface RecruitmentLink { templateId: string; employeeId: string }

export function parseRecruitmentLinks(payload: unknown): RecruitmentLink[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) throw new Error('招募记录格式不正确')
  return payload.data.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    return row.status === 'succeeded' && typeof row.template_id === 'string' && typeof row.created_employee_id === 'string'
      ? [{ templateId: row.template_id, employeeId: row.created_employee_id }] : []
  })
}

/** Only authoritative template IDs and current member grants; names are never identity. */
export function resolveTalentEmployees(templateId: string, experts: ExpertProjection[], links: RecruitmentLink[]): ExpertProjection[] {
  const ids = new Set(links.filter(link => link.templateId === templateId).map(link => link.employeeId))
  return experts.filter(expert => !expert.revoked && expert.status !== 'archived'
    && (expert.source_template_id === templateId || ids.has(expert.employee_id)))
}

/** 该员工已有的真实会话（排除 `emp_` 占位）；没有则返回 null，由调用方新建。 */
export function findEmployeeConversationId(
  conversations: ReadonlyArray<{ id: string; _employeeId?: string }>,
  employeeId: string,
): string | null {
  return conversations.find(conv => conv._employeeId === employeeId && !conv.id.startsWith('emp_'))?.id ?? null
}

export type TalentChatTarget =
  | { kind: 'single'; employee: ExpertProjection }
  | { kind: 'none' }

/**
 * "开始对话"的目标员工：Manager 规定同一模板每个企业只能招募一次，正常只有一个员工，直接进入；
 * 异常出现多个时取第一个（由调用方记日志），零个提示去完成授权。
 */
export function pickTalentChatTarget(employees: ExpertProjection[]): TalentChatTarget {
  return employees.length ? { kind: 'single', employee: employees[0] } : { kind: 'none' }
}

export const TALENT_GRANT_MISSING_MESSAGE = '已招募，但本机还没有该员工的授权。请在企业后台完成员工配置和成员授权后再试。'

/** 已招募人才当前不能发起对话的原因（缺授权、暂停、下架等）；可以对话时返回 null。 */
export function talentChatBlockedReason(employees: ExpertProjection[]): string | null {
  const target = pickTalentChatTarget(employees)
  return target.kind === 'none' ? TALENT_GRANT_MISSING_MESSAGE : employeeUnavailableMessage(target.employee)
}
