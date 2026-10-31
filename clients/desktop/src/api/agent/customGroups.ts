import type { AgentApiClient } from './client'
import type { ConversationMetadata, PermissionMode } from './types'
import type { ConversationParticipantsEnvelope } from './observations.types'

export type GroupOrchestration = { mode: 'auto' } | {
  mode: 'custom'
  format: 'collaboration-markdown-v1'
  prompt: string
}

export interface CustomGroupCreateRequest {
  id: string
  title: string
  description: string | null
  member_employee_ids: string[]
  coordinator_employee_id: string
  orchestration: GroupOrchestration
  permission_mode?: PermissionMode
}

export const CUSTOM_GROUP_PATH = '/api/agent/conversations/custom-group'

export async function supportsCustomGroups(client: AgentApiClient): Promise<boolean> {
  const schema = await client.request<{ paths?: Record<string, { post?: { operationId?: string } }> }>({ path: '/openapi.json', raw: true })
  return Boolean(schema.paths?.[CUSTOM_GROUP_PATH]?.post)
}

export async function createCustomGroup(client: AgentApiClient, input: CustomGroupCreateRequest) {
  let conversation: ConversationMetadata
  try {
    conversation = await client.request<ConversationMetadata>({ method: 'POST', path: CUSTOM_GROUP_PATH, body: input })
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status !== undefined && status !== 0 && status !== 409 && status < 500) throw error
    // The server may have committed before the response was lost. Never retry with a new ID.
    try {
      const existing = await client.request<ConversationMetadata>({ path: `/api/agent/conversations/${encodeURIComponent(input.id)}` })
      const participants = await client.request<ConversationParticipantsEnvelope['data']>({ path: `/api/agent/conversations/${encodeURIComponent(input.id)}/participants` })
      const ids = participants.participants.map(member => member.employee_id)
      const rule = existing.orchestration
      const sameRule = rule?.mode === input.orchestration.mode && (rule?.mode !== 'custom'
        || (input.orchestration.mode === 'custom' && rule.format === input.orchestration.format && rule.prompt === input.orchestration.prompt))
      if (existing.kind !== 'group' || existing.title !== input.title || (existing.description ?? null) !== input.description
        || existing.coordinator_employee_id !== input.coordinator_employee_id || !sameRule
        || existing.permission_mode !== (input.permission_mode ?? 'read-only')
        || ids.length !== input.member_employee_ids.length || !ids.every(id => input.member_employee_ids.includes(id))) {
        throw Object.assign(new Error('该创建编号已关联不同配置的群聊，请关闭窗口后重新创建。'), { cause: error })
      }
      return { conversation: existing, participants }
    } catch (recoveryError) {
      if (recoveryError instanceof Error && recoveryError.message.startsWith('该创建编号')) throw recoveryError
      throw Object.assign(new Error(error instanceof Error ? error.message : '创建群聊失败，请重试。'), { cause: recoveryError })
    }
  }
  // Creation is already successful. A member read failure must not create another group.
  const participants = await client.request<ConversationParticipantsEnvelope['data']>({ path: `/api/agent/conversations/${encodeURIComponent(conversation.id)}/participants` }).catch(() => null)
  return { conversation, participants }
}

export const GROUP_PARTICIPANTS_PATH = '/api/agent/conversations/{conversation_id}/participants'
export const GROUP_ORCHESTRATION_PATH = '/api/agent/conversations/{conversation_id}/orchestration'

export interface GroupEditCapabilities {
  /** `PATCH /conversations/:id/participants` — add/remove members. */
  members: boolean
  /** `PUT /conversations/:id/orchestration` — dedicated rule endpoint; older services only accept the generic PATCH. */
  orchestration: boolean
}

export const NO_GROUP_EDITING: GroupEditCapabilities = { members: false, orchestration: false }

export async function supportsGroupEditing(client: AgentApiClient): Promise<GroupEditCapabilities> {
  const schema = await client.request<{ paths?: Record<string, { patch?: unknown; put?: unknown }> }>({ path: '/openapi.json', raw: true })
  return {
    members: Boolean(schema.paths?.[GROUP_PARTICIPANTS_PATH]?.patch),
    orchestration: Boolean(schema.paths?.[GROUP_ORCHESTRATION_PATH]?.put),
  }
}

export interface GroupMembersUpdateRequest {
  add_employee_ids?: string[]
  remove_employee_ids?: string[]
  /** Required when a custom rule still references a removed member. */
  orchestration?: GroupOrchestration
  description?: string | null
}

export interface GroupMembersUpdateResult {
  conversation: ConversationMetadata
  participants: ConversationParticipantsEnvelope['data']['participants']
  employee_count: number
}

export interface GroupOrchestrationUpdateRequest {
  orchestration: GroupOrchestration
  /** Switching to automatic orchestration needs a non-empty description (stored or sent). */
  description?: string | null
}

export function updateGroupMembers(client: AgentApiClient, conversationId: string, body: GroupMembersUpdateRequest) {
  return client.request<GroupMembersUpdateResult>({
    method: 'PATCH',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/participants`,
    body,
  })
}

/** Uses the dedicated endpoint when the service has it, otherwise the equivalent generic conversation PATCH. */
export function replaceGroupOrchestration(client: AgentApiClient, conversationId: string, body: GroupOrchestrationUpdateRequest, dedicated: boolean) {
  if (dedicated) {
    return client.request<ConversationMetadata>({
      method: 'PUT',
      path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/orchestration`,
      body,
    })
  }
  return client.request<ConversationMetadata>({
    method: 'PATCH',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}`,
    body,
  })
}
