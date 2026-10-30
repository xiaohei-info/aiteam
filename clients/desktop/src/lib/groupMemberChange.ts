import type { GroupMembersUpdateRequest, GroupOrchestration } from '../api/agent/customGroups'
import { encodeGroupPrompt, type EmployeeMention } from './customGroupForm.ts'

export const MAX_GROUP_MEMBERS = 32
const MAX_PROMPT_LENGTH = 16_000

export interface MemberChange {
  currentIds: readonly string[]
  coordinatorId: string | null
  add: readonly string[]
  remove: readonly string[]
}

/** Members after the change: current members minus removals, then additions. */
export function nextRoster({ currentIds, add, remove }: Pick<MemberChange, 'currentIds' | 'add' | 'remove'>): string[] {
  return [...currentIds.filter(id => !remove.includes(id)), ...add.filter(id => !currentIds.includes(id))]
}

export type MemberEditAvailability = { enabled: true } | { enabled: false; reason: string | null }

/**
 * Whether "manage members" can be used right now. `capabilities` is null while the service is still
 * being probed; the entry stays visible but disabled so a missing feature is explained, not hidden.
 */
export function memberEditAvailability(input: {
  isCustomGroup: boolean
  rosterLoaded: boolean
  capabilities: { members: boolean } | null
}): MemberEditAvailability {
  if (!input.isCustomGroup) return { enabled: false, reason: '该群不是自选成员群，暂不支持增减成员；如需调整成员，请通过“创建群聊”新建。' }
  if (!input.rosterLoaded) return { enabled: false, reason: '群成员尚未读取成功，请刷新后重试。' }
  if (input.capabilities === null) return { enabled: false, reason: null }
  if (!input.capabilities.members) return { enabled: false, reason: '当前 Agent 版本不支持增减成员，请升级 Agent 后使用。' }
  return { enabled: true }
}

/** Mirror of the server rules so the dialog can explain a refusal before sending anything. */
export function validateMemberChange(change: MemberChange): string | null {
  if (change.add.length + change.remove.length === 0) return '请选择要加入或移出的成员。'
  if (new Set(change.add).size !== change.add.length || new Set(change.remove).size !== change.remove.length) return '所选成员存在重复。'
  if (change.add.some(id => change.remove.includes(id))) return '同一位成员不能同时加入和移出。'
  if (change.add.some(id => change.currentIds.includes(id))) return '所选员工已在群内。'
  if (change.remove.some(id => !change.currentIds.includes(id))) return '所选成员不在群内。'
  if (change.coordinatorId && change.remove.includes(change.coordinatorId)) return '协调人不能移出群聊。'
  const size = nextRoster(change).length
  if (size < 1 || size > MAX_GROUP_MEMBERS) return `群成员需为 1–${MAX_GROUP_MEMBERS} 位，变更后为 ${size} 位。`
  return null
}

/** Store form `@{id}` → editor form `@【name】`. Unknown IDs stay as they are. */
export function decodeGroupPrompt(prompt: string, bindings: readonly EmployeeMention[]): string {
  return prompt.replace(/@\{([^{}\s]+)\}/gu, (token, id: string) => {
    const binding = bindings.find(item => item.id === id)
    return binding ? `@【${binding.label}】` : token
  })
}

/** Employee IDs a rule mentions, whether written as `@【name】` or `@{id}`. */
export function promptReferences(text: string, bindings: readonly EmployeeMention[]): string[] {
  const ids = new Set<string>()
  for (const match of text.matchAll(/@\{([^{}\s]+)\}/gu)) ids.add(match[1]!)
  for (const match of text.matchAll(/@【([^】]+)】/gu)) {
    const binding = bindings.find(item => item.label === match[1])
    if (binding) ids.add(binding.id)
  }
  return [...ids]
}

/** Names of the members being removed that the rule still points at. */
export function removedReferences(text: string, bindings: readonly EmployeeMention[], remove: readonly string[]): string[] {
  return promptReferences(text, bindings)
    .filter(id => remove.includes(id))
    .map(id => bindings.find(item => item.id === id)?.label ?? id)
}

export type MemberUpdatePlan = { request: GroupMembersUpdateRequest } | { error: string }

/**
 * Build the member-change request. For a custom rule the edited text is encoded against the
 * resulting roster and sent only when it differs from the stored rule, so an untouched rule is
 * never rewritten; a rule that still references a removed member fails here, not on the server.
 */
export function planMemberUpdate(input: {
  change: MemberChange
  orchestration: GroupOrchestration
  /** Rule text as shown in the editor; ignored for automatic orchestration. */
  ruleText: string
  bindings: readonly EmployeeMention[]
}): MemberUpdatePlan {
  const problem = validateMemberChange(input.change)
  if (problem) return { error: problem }
  const request: GroupMembersUpdateRequest = {}
  if (input.change.add.length) request.add_employee_ids = [...input.change.add]
  if (input.change.remove.length) request.remove_employee_ids = [...input.change.remove]
  if (input.orchestration.mode === 'custom') {
    let prompt: string
    try { prompt = encodeGroupPrompt(input.ruleText, input.bindings, nextRoster(input.change)) }
    catch (error) { return { error: (error as Error).message } }
    if (!prompt) return { error: '协作提示词不能为空。' }
    if (prompt.length > MAX_PROMPT_LENGTH) return { error: `协作提示词不能超过 ${MAX_PROMPT_LENGTH} 字符。` }
    if (prompt !== input.orchestration.prompt.trim()) {
      request.orchestration = { mode: 'custom', format: 'collaboration-markdown-v1', prompt }
    }
  }
  return { request }
}

export type OrchestrationTarget = 'auto' | 'custom'

export interface OrchestrationPlanInput {
  target: OrchestrationTarget
  /** Rule text as shown in the editor (custom target). */
  ruleText: string
  /** Description draft (auto target). */
  description: string
  memberIds: readonly string[]
  bindings: readonly EmployeeMention[]
}

export type OrchestrationPlan =
  | { request: { orchestration: GroupOrchestration; description?: string | null } }
  | { error: string }

/** Build the request for saving a rule or switching mode; automatic mode needs a purpose. */
export function planOrchestrationUpdate(input: OrchestrationPlanInput): OrchestrationPlan {
  if (input.target === 'auto') {
    const description = input.description.trim()
    if (!description) return { error: '自动编排需要填写群简介。' }
    if (description.length > 4000) return { error: '群简介不能超过 4000 字符。' }
    return { request: { orchestration: { mode: 'auto' }, description } }
  }
  let prompt: string
  try { prompt = encodeGroupPrompt(input.ruleText, input.bindings, input.memberIds) }
  catch (error) { return { error: (error as Error).message } }
  if (!prompt) return { error: '请填写协作提示词。' }
  if (prompt.length > MAX_PROMPT_LENGTH) return { error: `协作提示词不能超过 ${MAX_PROMPT_LENGTH} 字符。` }
  return { request: { orchestration: { mode: 'custom', format: 'collaboration-markdown-v1', prompt } } }
}

/** User-facing text for a failed group edit; never shows server English or internals. */
export function describeGroupEditError(error: unknown, fallback: string): string {
  const { status, code } = (error ?? {}) as { status?: number; code?: string }
  switch (code) {
    case 'conversation_busy': return '群里有成员正在执行任务，请等本轮结束后再修改。'
    case 'invalid_orchestration_reference': return '协作规则引用了不在群内的成员，请改写规则后再保存。'
    case 'invalid_group_coordinator': return '协调人不能移出群聊。'
    case 'invalid_group_members': return '成员变更不符合要求，请刷新群成员后重试。'
    case 'invalid_group_orchestration': return '编排规则不符合要求，请检查后重试。'
    case 'invalid_group_configuration': return '该群不是自选成员群，暂不支持修改简介、成员和编排规则。'
    case 'employee_not_authorized': return '所选员工的授权已变化，请刷新员工后重试。'
    default:
  }
  if (status === 404) return '群聊不存在，或当前服务暂不支持该操作，请更新服务后重试。'
  if (status === 403) return '没有权限执行该操作，请刷新后重试。'
  if (status === 409) return '群聊状态已变化，请稍后重试。'
  return fallback
}
