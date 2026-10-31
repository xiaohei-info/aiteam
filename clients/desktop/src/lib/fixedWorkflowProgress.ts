import type { SolutionProjection } from '../api/agent/types'

export const FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_TITLE = '固定流程进度暂不可用'
export const FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON =
  '服务端当前只下发 workflow_skill_ref 版本引用，尚未提供步骤 ID、执行顺序和本轮权威状态。'

export type FixedWorkflowProgressAvailability =
  | { status: 'hidden' }
  | { status: 'unavailable'; title: string; reason: string }

function hasWorkflowSkillReference(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length > 0
}

/**
 * workflow_skill_ref 只是固定版本 Skill 引用，不是可展示的步骤定义或运行快照。
 * 员工 fan-out、tool 调用和 agent_settled 事件也不能代替流程步骤，因此本函数故意
 * 不接受运行事件，只在确认有固定流程引用时返回阻塞说明。
 */
export function resolveFixedWorkflowProgressAvailability(
  solutionInstanceId: string | null,
  solutions: readonly SolutionProjection[],
): FixedWorkflowProgressAvailability {
  if (!solutionInstanceId) return { status: 'hidden' }

  const solution = solutions.find((item) => item.solution_instance_id === solutionInstanceId)
  if (!hasWorkflowSkillReference(solution?.workflow_skill_ref)) return { status: 'hidden' }

  return {
    status: 'unavailable',
    title: FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_TITLE,
    reason: FIXED_WORKFLOW_PROGRESS_UNAVAILABLE_REASON,
  }
}
