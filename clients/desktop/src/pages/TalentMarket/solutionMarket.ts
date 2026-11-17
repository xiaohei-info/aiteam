import type { ExpertProjection, SolutionProjection } from '../../api/agent/types.ts'

export type SolutionStart =
  | { kind: 'chat'; employeeId: string; label: '开始私聊' }
  | { kind: 'group'; label: '用此方案建群' }
  | { kind: 'unavailable'; reason: string }

/** 缺省按组群：旧方案没有 mode 字段。 */
export function solutionMode(solution: Pick<SolutionProjection, 'mode'>): 'solo' | 'group' {
  return solution.mode === 'solo' ? 'solo' : 'group'
}

export const SOLUTION_MODE_LABEL = { solo: '单人', group: '组群' } as const

/** 方案里本机已授权、可用的成员；成员不在本机授权里时不会出现。 */
export function solutionMembers(solution: SolutionProjection, experts: readonly ExpertProjection[]): ExpertProjection[] {
  const byId = new Map(experts.filter(expert => !expert.revoked).map(expert => [expert.employee_id, expert]))
  return (solution.expert_employee_ids ?? []).flatMap(id => byId.get(id) ?? [])
}

/** 方案卡上的主操作：单人 → 私聊唯一专家；组群 → 建群。成员没授权到本机时说明原因，不给按钮。 */
export function solutionStart(solution: SolutionProjection, experts: readonly ExpertProjection[]): SolutionStart {
  const ids = solution.expert_employee_ids ?? []
  const members = solutionMembers(solution, experts)
  if (!ids.length) return { kind: 'unavailable', reason: '方案还没有成员' }
  if (members.length < ids.length) return { kind: 'unavailable', reason: '有成员尚未授权到本机，请在企业后台完成授权后刷新' }
  if (solutionMode(solution) === 'solo') {
    const only = members[0]
    return only ? { kind: 'chat', employeeId: only.employee_id, label: '开始私聊' } : { kind: 'unavailable', reason: '方案还没有成员' }
  }
  return { kind: 'group', label: '用此方案建群' }
}

/** 推荐能力的一行摘要；没有推荐返回 null。仅提示，不代表已安装。 */
export function recommendedSummary(solution: Pick<SolutionProjection, 'recommended_capabilities'>): string | null {
  const items = solution.recommended_capabilities ?? []
  if (!items.length) return null
  const skills = items.filter(item => item.kind === 'skill').length
  const mcps = items.filter(item => item.kind === 'mcp').length
  return [skills ? `${skills} 个 skill` : '', mcps ? `${mcps} 个 MCP` : ''].filter(Boolean).join('、')
}
