import type { ThinkingStep, ToolCall } from '../stores/chat'

export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoTaskItem {
  id: string
  title: string
  status: TodoTaskStatus
}

export interface TodoTaskCardData {
  callId: string
  items: TodoTaskItem[]
}

/**
 * 展示态：服务端只下发 pending/in_progress/completed；`unfinished` 是客户端派生态，
 * 表示“所属回复已结束、但条目仍停在 in_progress”。
 */
export type TodoTaskDisplayStatus = TodoTaskStatus | 'unfinished'

export interface TodoTaskDisplayItem extends TodoTaskItem {
  displayStatus: TodoTaskDisplayStatus
}

export interface TodoTaskDisplay {
  items: TodoTaskDisplayItem[]
  total: number
  completed: number
  unfinished: number
  allCompleted: boolean
}

const MAX_ITEMS = 32
const MAX_ID_LENGTH = 128
const MAX_TITLE_LENGTH = 500
const ITEM_KEYS = new Set(['id', 'title', 'status'])
const PAYLOAD_KEYS = new Set(['items', 'item_count'])

/** JSON 边界解析结果：反序列化后再由各 parse 函数收敛到具体域类型。 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(value: string | undefined): JsonValue | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return undefined
  }
}

function normalizeItems(value: unknown): TodoTaskItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const ids = new Set<string>()
  const items: TodoTaskItem[] = []

  for (const candidate of value) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !ITEM_KEYS.has(key))) return null
    const { id, title, status } = candidate
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || /[\\/]/u.test(id)) return null
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    if (ids.has(id)) return null
    ids.add(id)
    items.push({ id, title, status })
  }

  return items
}

function parsePayload(value: unknown): TodoTaskItem[] | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !PAYLOAD_KEYS.has(key))) return null
  if ('item_count' in value
    && (!Number.isInteger(value.item_count) || value.item_count !== (Array.isArray(value.items) ? value.items.length : -1))) {
    return null
  }
  return normalizeItems(value.items)
}

/**
 * 只识别 FredServer 已落约的 todo_update；其它结构化工具继续使用通用安全降级。
 * 结果优先于输入，确保完成态展示服务端执行后的权威列表。
 */
export function parseTodoTaskCard(call: ToolCall): TodoTaskCardData | null {
  if (call.isError || (call.toolKind !== 'todo' && call.name !== 'todo_update')) return null
  const candidates = [call.resultValue, parseJson(call.result), call.input]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const items = parsePayload(candidate)
    if (items) return { callId: call.id, items }
  }
  return null
}

/** Legacy messages may only carry toolCalls; retain them in the expandable process too. */
export function withToolCallSteps(
  steps: ThinkingStep[] | undefined,
  calls: ToolCall[] | undefined,
): ThinkingStep[] | undefined {
  const result = [...(steps ?? [])]
  const knownIds = new Set(result.flatMap((step) => step.kind === 'tool' ? [step.tool.id] : []))
  for (const call of calls ?? []) {
    if (knownIds.has(call.id)) continue
    result.push({ kind: 'tool', tool: call })
    knownIds.add(call.id)
  }
  return result.length > 0 ? result : undefined
}

/**
 * in_progress 只在所属回复仍在输出时代表“进行中”；回复结束后仍未完成的条目降级为
 * 终止态 `unfinished`，避免卡片在消息发完后永久显示旋转的“进行中”。
 */
export function resolveTodoTaskDisplayStatus(
  status: TodoTaskStatus,
  isActive: boolean,
): TodoTaskDisplayStatus {
  return status === 'in_progress' && !isActive ? 'unfinished' : status
}

/** 把服务端快照解析成可直接渲染的展示态，并给出顶部统计。 */
export function toTodoTaskDisplay(card: TodoTaskCardData, isActive: boolean): TodoTaskDisplay {
  const items = card.items.map((item) => ({
    ...item,
    displayStatus: resolveTodoTaskDisplayStatus(item.status, isActive),
  }))
  const completed = items.filter((item) => item.displayStatus === 'completed').length
  const unfinished = items.filter((item) => item.displayStatus === 'unfinished').length
  return {
    items,
    total: items.length,
    completed,
    unfinished,
    allCompleted: items.length > 0 && completed === items.length,
  }
}

/** todo_update replaces the checklist for this response; only the latest valid snapshot is current. */
export function collectTodoTaskCards(
  steps: ThinkingStep[] | undefined,
  calls: ToolCall[] | undefined,
): TodoTaskCardData[] {
  let latest: TodoTaskCardData | null = null
  for (const step of withToolCallSteps(steps, calls) ?? []) {
    if (step.kind !== 'tool') continue
    const card = parseTodoTaskCard(step.tool)
    if (card) latest = card
  }
  return latest ? [latest] : []
}
