import type { PromptRequest } from '../api/agent/types'
import type { GroupMember } from './groupRoster'

export interface GroupPromptContext {
  id: string
  members?: readonly GroupMember[]
}

export interface GroupPromptRoute {
  targetEmployeeIds: string[]
  targetsKnown: boolean
}

export type GroupPromptSubmitter = (
  conversationId: string,
  prompt: PromptRequest,
  idempotencyKey: string,
) => Promise<unknown>

/** 按 Agent 服务的真实路由规则推导本轮目标：@handle fan-out；无 @ 时只到 coordinator。 */
export function resolveGroupPromptRoute(
  group: GroupPromptContext,
  mentions: readonly string[] | undefined,
): GroupPromptRoute {
  const normalizedMentions = [...new Set((mentions ?? []).filter(Boolean))]
  const members = group.members ?? []
  if (normalizedMentions.length === 0) {
    const coordinatorId = members.find((member) => member.is_system_planner)?.employee_id
    return {
      targetEmployeeIds: coordinatorId ? [coordinatorId] : [],
      targetsKnown: Boolean(coordinatorId),
    }
  }

  const targetEmployeeIds: string[] = []
  for (const handle of normalizedMentions) {
    const employeeId = members.find((member) => member.handle === handle)?.employee_id
    if (!employeeId) return { targetEmployeeIds: [], targetsKnown: false }
    if (!targetEmployeeIds.includes(employeeId)) targetEmployeeIds.push(employeeId)
  }
  return { targetEmployeeIds, targetsKnown: true }
}

/**
 * 提交群聊文本消息。
 *
 * 群成员是 AI 员工 roster，不包含当前登录用户。未 @任何成员时，Agent 服务会把消息路由给
 * coordinator；因此这里不能用“是否存在普通成员”判断用户能否发送。
 */
export async function submitGroupPrompt(
  group: GroupPromptContext,
  text: string,
  mentions: readonly string[] | undefined,
  idempotencyKey: string,
  submit: GroupPromptSubmitter,
  attachmentIds?: readonly string[],
): Promise<GroupPromptRoute> {
  const normalizedMentions = [...new Set((mentions ?? []).filter(Boolean))]
  const normalizedAttachmentIds = [...new Set((attachmentIds ?? []).filter(Boolean))]
  const route = resolveGroupPromptRoute(group, normalizedMentions)
  const prompt: PromptRequest = {
    text,
    ...(normalizedMentions.length > 0 ? { mentions: normalizedMentions } : {}),
    ...(normalizedAttachmentIds.length > 0 ? { attachment_ids: normalizedAttachmentIds } : {}),
  }
  await submit(group.id, prompt, idempotencyKey)
  return route
}
