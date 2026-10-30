import type { SolutionProjection } from '../api/agent/types'

export const GROUP_TITLE_EDIT_OWNERSHIP_NOTE =
  '当前群聊是服务端按登录成员返回的自有本地会话，群名称修改仍由服务端 owner 校验。'

export interface ResolvedGroupDetails {
  description: string | null
  descriptionMessage: string | null
  coordinatorInstructions: string | null
  orchestrationMessage: string | null
  orchestrationMode: 'fixed' | 'unavailable' | 'auto' | 'custom'
  orchestrationModeLabel: '固定流程' | '编排模式不可用' | '未保存编排规则' | '自动' | '自定义'
  orchestrationModeMessage: string
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function hasWorkflowSkillRef(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length > 0
}

export function resolveGroupDetails(
  solutionInstanceId: string | null,
  solutions: readonly SolutionProjection[],
  config?: { description?: string | null; orchestration?: import('../api/agent/customGroups').GroupOrchestration | null; members?: readonly { employee_id: string; display_name: string }[] },
): ResolvedGroupDetails {
  if (config?.orchestration) {
    const rule = config.orchestration
    return {
      description: nonEmptyText(config.description), descriptionMessage: config.description ? null : '尚未填写群简介。',
      coordinatorInstructions: rule.mode === 'custom' ? rule.prompt.replace(/@\{([^{}]+)\}/gu, (_token, id: string) => {
        const member = config.members?.find(item => item.employee_id === id)
        return member ? `@${member.display_name}` : '（原成员已不可用）'
      }) : null,
      orchestrationMessage: rule.mode === 'auto' ? '协调人根据群简介和成员能力为每次任务规划协作。' : null,
      orchestrationMode: rule.mode, orchestrationModeLabel: rule.mode === 'auto' ? '自动' : '自定义',
      orchestrationModeMessage: rule.mode === 'auto' ? '以群简介作为协作目标。' : '按创建时保存的协作提示词推进。',
    }
  }
  if (!solutionInstanceId) {
    return {
      description: null,
      descriptionMessage: '服务端 Conversation 未提供群简介字段，且当前群聊未关联方案。',
      coordinatorInstructions: null,
      // 没有编排规则也没有关联方案：不是数据缺失，而是这个群不属于自选成员群，原因只在标签旁说一次。
      orchestrationMessage: null,
      orchestrationMode: 'unavailable',
      orchestrationModeLabel: '未保存编排规则',
      orchestrationModeMessage: '该群不是自选成员群，没有保存编排规则，无法切换编排方式。',
    }
  }

  const solution = solutions.find((item) => item.solution_instance_id === solutionInstanceId)
  if (!solution) {
    return {
      description: null,
      descriptionMessage: '关联方案投影当前不可用，无法读取群简介。',
      coordinatorInstructions: null,
      orchestrationMessage: '关联方案投影当前不可用，无法读取会话编排。',
      orchestrationMode: 'unavailable',
      orchestrationModeLabel: '编排模式不可用',
      orchestrationModeMessage: '关联方案投影当前不可用，无法读取编排模式。',
    }
  }

  const description = nonEmptyText(solution.description)
  const coordinatorInstructions = nonEmptyText(solution.coordinator_instructions)
  const fixedWorkflow = hasWorkflowSkillRef(solution.workflow_skill_ref)
  return {
    description,
    descriptionMessage: description ? null : '关联方案未提供群简介。',
    coordinatorInstructions,
    orchestrationMessage: coordinatorInstructions ? null : '会话编排字段未提供。',
    orchestrationMode: fixedWorkflow ? 'fixed' : 'unavailable',
    orchestrationModeLabel: fixedWorkflow ? '固定流程' : '编排模式不可用',
    orchestrationModeMessage: fixedWorkflow
      ? '方案提供了 workflow_skill_ref 固定版本引用。'
      : '关联方案未提供 workflow_skill_ref，无法确认编排模式。',
  }
}
