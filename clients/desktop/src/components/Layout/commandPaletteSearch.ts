export type CommandPaletteResultKind = 'employee' | 'private-conversation' | 'group-conversation'

export interface CommandPaletteEmployeeSource {
  employeeId: string
  displayName: string
  roleName?: string
  skills?: string[]
  persona?: string
  targetConversationId: string
  avatarUrl?: string | null
}

export interface CommandPaletteConversationSource {
  id: string
  kind: 'private' | 'group'
  title: string
  preview?: string
  memberCount?: number | null
  avatarUrl?: string | null
}

export interface CommandPalettePrivateConversationInput {
  id: string
  title: string
  lastMessage?: string
  employeeId?: string
}

export interface CommandPaletteGroupConversationInput {
  id: string
  name: string
  lastMessage?: string
  memberCount?: number | null
}

export interface CommandPaletteWorkbenchEmployeeInput {
  employeeId: string
  displayName: string
  conversationId: string | null
  avatarUrl?: string | null
}

export interface CommandPaletteResult {
  key: string
  kind: CommandPaletteResultKind
  targetId: string
  label: string
  description: string
  preview?: string
  avatarUrl?: string | null
}

export interface CommandPaletteSearchResults {
  employees: CommandPaletteResult[]
  conversations: CommandPaletteResult[]
}

export interface CommandPaletteSearchOptions {
  query: string
  employees: readonly CommandPaletteEmployeeSource[]
  conversations: readonly CommandPaletteConversationSource[]
  limitPerSection?: number
}

export interface UnavailableSearchSource {
  key: 'tasks' | 'knowledge'
  label: string
  reason: string
}

export const UNAVAILABLE_SEARCH_SOURCES: readonly UnavailableSearchSource[] = [
  {
    key: 'tasks',
    label: '任务',
    reason: '自动化调度与任务查询接口尚未接入。',
  },
  {
    key: 'knowledge',
    label: '知识',
    reason: '知识库 API 当前返回 410，企业管理端能力尚未开放。',
  },
]

const DEFAULT_SECTION_LIMIT = 6

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function getMatchRank(query: string, values: readonly (string | undefined)[]): number | null {
  if (!query) return 3

  let rank: number | null = null
  for (const value of values) {
    const normalizedValue = normalizeSearchValue(value ?? '')
    if (!normalizedValue) continue
    if (normalizedValue === query) rank = Math.min(rank ?? 2, 0)
    else if (normalizedValue.startsWith(query)) rank = Math.min(rank ?? 2, 1)
    else if (normalizedValue.includes(query)) rank = Math.min(rank ?? 2, 2)
  }
  return rank
}

function byRankThenLabel(
  left: { rank: number; result: CommandPaletteResult },
  right: { rank: number; result: CommandPaletteResult },
): number {
  return left.rank - right.rank || left.result.label.localeCompare(right.result.label, 'zh-CN')
}

/**
 * 会话事实源来自 store 已加载的服务端列表。所有 emp_ 项只是员工入口，不是已创建会话；
 * 其余私聊即使员工授权已撤销或映射缺失也必须保留，员工投影只用于补头像和名称。
 */
export function buildCommandPaletteConversationSources(options: {
  conversations: readonly CommandPalettePrivateConversationInput[]
  groups: readonly CommandPaletteGroupConversationInput[]
  employees: readonly CommandPaletteWorkbenchEmployeeInput[]
}): CommandPaletteConversationSource[] {
  const employeeByConversationId = new Map(
    options.employees
      .filter((employee) => employee.conversationId)
      .map((employee) => [employee.conversationId as string, employee]),
  )
  const employeeById = new Map(options.employees.map((employee) => [employee.employeeId, employee]))

  const privateSources = options.conversations
    .filter((conversation) => !conversation.id.startsWith('emp_'))
    .map((conversation) => {
      const employee = employeeByConversationId.get(conversation.id)
        ?? (conversation.employeeId ? employeeById.get(conversation.employeeId) : undefined)
      return {
        id: conversation.id,
        kind: 'private' as const,
        title: conversation.title.trim() || employee?.displayName || '未命名会话',
        preview: conversation.lastMessage,
        avatarUrl: employee?.avatarUrl,
      }
    })

  const groupSources = options.groups.map((group) => ({
    id: group.id,
    kind: 'group' as const,
    title: group.name.trim() || '未命名群聊',
    preview: group.lastMessage,
    memberCount: group.memberCount,
  }))

  return [...privateSources, ...groupSources]
}

/**
 * 只匹配真实 workbench 投影中的员工与会话元数据。
 * 会话预览只用于展示，不参与匹配，避免误实现 A2.3 的跨会话消息全文搜索。
 */
export function searchCommandPalette(options: CommandPaletteSearchOptions): CommandPaletteSearchResults {
  const query = normalizeSearchValue(options.query)
  const limit = Math.max(1, options.limitPerSection ?? DEFAULT_SECTION_LIMIT)

  const employees = options.employees
    .map((employee) => {
      const rank = getMatchRank(query, [
        employee.displayName,
        employee.roleName,
        ...(employee.skills ?? []),
        employee.persona,
      ])
      if (rank === null) return null
      return {
        rank,
        result: {
          key: `employee:${employee.employeeId}`,
          kind: 'employee' as const,
          targetId: employee.targetConversationId,
          label: employee.displayName,
          description: employee.roleName?.trim() || 'AI 员工',
          avatarUrl: employee.avatarUrl,
        },
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort(byRankThenLabel)
    .slice(0, limit)
    .map((item) => item.result)

  const conversations = options.conversations
    .map((conversation) => {
      const rank = getMatchRank(query, [conversation.title])
      if (rank === null) return null
      const isGroup = conversation.kind === 'group'
      return {
        rank,
        result: {
          key: `conversation:${conversation.kind}:${conversation.id}`,
          kind: (isGroup ? 'group-conversation' : 'private-conversation') as CommandPaletteResultKind,
          targetId: conversation.id,
          label: conversation.title,
          description: isGroup
            ? `群聊会话${conversation.memberCount === null || conversation.memberCount === undefined ? '' : `，${conversation.memberCount} 位成员`}`
            : '单聊会话',
          preview: conversation.preview?.trim() || undefined,
          avatarUrl: conversation.avatarUrl,
        },
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort(byRankThenLabel)
    .slice(0, limit)
    .map((item) => item.result)

  return { employees, conversations }
}

export type CommandPaletteNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** 返回由 aria-activedescendant 使用的循环选中索引。 */
export function moveCommandPaletteSelection(
  currentIndex: number,
  itemCount: number,
  key: CommandPaletteNavigationKey,
): number {
  if (itemCount <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount
  return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount
}

/** 返回焦点陷阱中的下一个索引，Tab 与 Shift+Tab 都会在弹层内循环。 */
export function moveTrappedFocus(currentIndex: number, itemCount: number, reverse: boolean): number {
  if (itemCount <= 0) return -1
  if (currentIndex < 0) return reverse ? itemCount - 1 : 0
  return reverse
    ? (currentIndex - 1 + itemCount) % itemCount
    : (currentIndex + 1) % itemCount
}
