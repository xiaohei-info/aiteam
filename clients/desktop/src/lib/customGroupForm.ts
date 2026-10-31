import type { CustomGroupCreateRequest } from '../api/agent/customGroups'

export interface GroupPromptMember { employeeId: string; displayName: string; roleName?: string }
export interface EmployeeMention { id: string; label: string }

/** Bind friendly, unambiguous display tokens to IDs for this editor session. */
export function mentionBindings(members: readonly GroupPromptMember[]): EmployeeMention[] {
  const used = new Set<string>()
  return members.map(member => {
    const base = member.displayName.replace(/[【】\r\n]/gu, ' ').trim() || 'AI 员工'
    let label = base
    let index = 2
    while (used.has(label)) label = `${base}（${index++}）`
    used.add(label)
    return { id: member.employeeId, label }
  })
}

export function encodeGroupPrompt(text: string, bindings: readonly EmployeeMention[], selectedIds: readonly string[]): string {
  const prompt = text.replace(/@【([^】]+)】/gu, (_token, label: string) => {
    const binding = bindings.find(item => item.label === label)
    if (!binding || !selectedIds.includes(binding.id)) throw new Error(`请修复已移除或无效的成员引用：${label}`)
    return `@{${binding.id}}`
  })
  if (prompt.includes('@【')) throw new Error('成员引用不完整，请使用 @ 选择群内员工。')
  const withoutRefs = prompt.replace(/@\{([^{}\s]+)\}/gu, (_token, id: string) => {
    if (!selectedIds.includes(id)) throw new Error('协作提示词引用了未选入群的员工。')
    return ''
  })
  if (withoutRefs.includes('@{')) throw new Error('成员引用格式不完整。')
  return prompt.trim()
}

export function groupPromptTemplate(bindings: readonly EmployeeMention[]): string {
  const first = bindings[0] ? `@【${bindings[0].label}】` : '协调人'
  const second = bindings[1] ? `@【${bindings[1].label}】` : first
  return `协作目标：\n描述本群需要完成的协作目标。\n\n执行规则：\n按编号顺序推进，使用前一步实际结果；缺少必要信息时向用户提问。\n\n协作流程：\n1. ${first} → ${second}：分析任务并交付结果。\n   交付物：填写本步骤的成果。\n\n最终交付：\n由协调人汇总成果与待确认事项。`
}

export function validateGroupRequest(input: CustomGroupCreateRequest): string | null {
  if (!input.title.trim() || input.title.length > 200) return '请填写 1–200 字符的群聊名称。'
  if ((input.description?.length ?? 0) > 4000) return '群简介不能超过 4000 字符。'
  if (input.member_employee_ids.length < 1 || input.member_employee_ids.length > 32) return '请选择 1–32 位 AI 员工。'
  if (new Set(input.member_employee_ids).size !== input.member_employee_ids.length) return '群成员不能重复。'
  if (!input.member_employee_ids.includes(input.coordinator_employee_id)) return '请从已选成员中指定协调人。'
  if (input.orchestration.mode === 'auto' && !input.description?.trim()) return '自动编排需要填写群简介。'
  if (input.orchestration.mode === 'custom') {
    if (!input.orchestration.prompt.trim() || input.orchestration.prompt.length > 16_000) return '请填写 1–16000 字符的协作提示词。'
    try { encodeGroupPrompt(input.orchestration.prompt, [], input.member_employee_ids) }
    catch (error) { return (error as Error).message }
  }
  return null
}
