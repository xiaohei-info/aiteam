import type {
  ConversationMetadata,
  ExpertProjection,
  SolutionProjection,
} from '../api/agent/types'

export interface GroupMember {
  employee_id: string
  member_ref_id: string
  member_id: string
  display_name: string
  profile_available?: boolean
  handle?: string
  role_name?: string
  department_name?: string
  department_ids?: string[]
  is_system_planner?: boolean
  avatar_url?: string | null
  online_status?: string | null
  last_seen_at?: string | null
  can_mention?: boolean
  unavailable_reason?: string
}

export interface ResolvedGroupRoster {
  status: 'loaded' | 'unavailable'
  members: GroupMember[]
  memberCount: number | null
  message: string
}

export const SOLUTION_ROSTER_SOURCE_MESSAGE =
  '群头像成员来自已授权协作方案 roster；当前会话接口尚未下发 members[]。'

function uniqueIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter(Boolean))]
}

function isUsableSolution(solution: SolutionProjection): boolean {
  return solution.status === undefined || solution.status === 'applied'
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((id) => rightSet.has(id))
}

export function findMatchingSolution(
  solutions: readonly SolutionProjection[],
  selectedEmployeeIds: readonly string[],
): SolutionProjection | undefined {
  const selected = uniqueIds(selectedEmployeeIds)
  if (selected.length === 0) return undefined
  return solutions.find((solution) => {
    if (!isUsableSolution(solution)) return false
    const roster = uniqueIds(solution.expert_employee_ids)
    return roster.length > 0 && sameIds(roster, selected)
  })
}

function toMember(
  employeeId: string,
  expert: ExpertProjection | undefined,
  coordinatorId: string | null,
): GroupMember {
  const canMention = Boolean(expert && !expert.revoked)
  return {
    employee_id: employeeId,
    member_ref_id: employeeId,
    member_id: employeeId,
    display_name: expert?.display_name ?? '不可用成员',
    profile_available: Boolean(expert),
    handle: expert?.handle,
    role_name: expert?.handle ?? '授权已撤销或配置缺失',
    department_name: typeof expert?.department_name === 'string' ? expert.department_name : undefined,
    department_ids: Array.isArray(expert?.department_ids) ? expert.department_ids.filter((id): id is string => typeof id === 'string') : undefined,
    is_system_planner: employeeId === coordinatorId,
    avatar_url: expert?.avatar_url ?? null,
    online_status: expert?.online_status ?? null,
    last_seen_at: expert?.last_seen_at ?? null,
    can_mention: canMention,
    unavailable_reason: canMention ? undefined : '当前授权中已不可用',
  }
}

export function resolveGroupRoster(
  conversation: ConversationMetadata,
  solutions: readonly SolutionProjection[],
  experts: readonly ExpertProjection[],
): ResolvedGroupRoster {
  const expertById = new Map(experts.map((expert) => [expert.employee_id, expert]))
  const coordinatorId = conversation.coordinator_employee_id
  const solutionId = conversation.solution_instance_id

  if (solutionId) {
    const solution = solutions.find((item) => item.solution_instance_id === solutionId)
    const rosterIds = uniqueIds(solution?.expert_employee_ids)
    if (solution && isUsableSolution(solution) && rosterIds.length > 0) {
      const effectiveCoordinatorId = coordinatorId ?? solution.coordinator_employee_id ?? null
      return {
        status: 'loaded',
        members: rosterIds.map((employeeId) => toMember(employeeId, expertById.get(employeeId), effectiveCoordinatorId)),
        memberCount: rosterIds.length,
        message: SOLUTION_ROSTER_SOURCE_MESSAGE,
      }
    }
  }

  // 无 solution 的旧群，服务端只返回 coordinator，不返回 participant session。
  // 这里只展示可确认的协调人并标明不完整，绝不把全部授权专家伪装成群成员。
  const confirmedMembers = coordinatorId
    ? [toMember(coordinatorId, expertById.get(coordinatorId), coordinatorId)]
    : []
  return {
    status: 'unavailable',
    members: confirmedMembers,
    memberCount: null,
    message: solutionId
      ? '当前会话接口尚未下发 members[]；关联协作方案已不可用，无法读取完整群成员。'
      : '当前会话接口尚未下发 members[]；该群未关联协作方案，服务端未提供真实成员列表。',
  }
}

/** Display membership only from the conversation's fixed participant index. */
export function participantRoster(
  response: import('../api/agent/observations.types').ConversationParticipantsEnvelope['data'],
  experts: readonly ExpertProjection[],
): ResolvedGroupRoster {
  const byId = new Map(experts.map(expert => [expert.employee_id, expert]))
  return {
    status: 'loaded', memberCount: response.employee_count, message: '当前会话的真实数字员工，不包含本机用户。',
    members: response.participants.map(participant => ({
      employee_id: participant.employee_id, member_id: participant.employee_id, member_ref_id: participant.employee_id,
      display_name: participant.display_name, handle: participant.handle ?? undefined,
      role_name: participant.role_title ?? '岗位未设置',
      department_name: participant.department_name ?? undefined,
      department_ids: participant.department_ids,
      is_system_planner: participant.role === 'coordinator',
      profile_available: byId.has(participant.employee_id),
      avatar_url: byId.get(participant.employee_id)?.avatar_url ?? null,
      can_mention: participant.available,
      unavailable_reason: participant.available ? undefined : '当前授权或员工配置不可用',
    })),
  }
}
