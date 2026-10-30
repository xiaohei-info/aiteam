/**
 * 员工详情「记忆」二级视图的显示规则。数据来自 GET /api/agent/employees/:id/memories(/summary),
 * 客户端固定 scope=mine:普通成员只看到自己对话产生的记忆,其他成员贡献的只显示数量。
 */
import type { EmployeeMemory, EmployeeMemorySummary } from '../api/agent/employeeMemories.ts'

export const MEMORY_PAGE_SIZE = 20
export const MAX_MEMORY_KEYWORD_CHARS = 1024
export const MEMORY_SEARCH_DEBOUNCE_MS = 300
export const MEMORY_DELETE_CONFIRM_TEXT = '删除后员工将不再记得这条内容，不可恢复'
export const MEMORY_EMPTY_TEXT = '还没有记忆。在「这个问题解决了吗？」里结束一段对话后，关键内容会保存在这里'
export const MEMORY_SEARCH_EMPTY_TEXT = '没有找到相关记忆'

/** Agent 没有直接导出 AgentApiError 给纯逻辑层,按 status/code 结构判断。 */
interface ProblemLike { status?: unknown; code?: unknown; message?: unknown }

export type MemoryProblem =
  // 旧版随包 Agent 没有记忆路由(404 not_found):隐藏入口。
  | { kind: 'unsupported'; text: string; retry: false }
  | { kind: 'disabled'; text: string; retry: false }
  | { kind: 'unavailable'; text: string; retry: true }
  | { kind: 'failed'; text: string; retry: true }

function problemFields(error: unknown): { status: number | null; code: string | null } {
  const value = (error && typeof error === 'object' ? error : {}) as ProblemLike
  return {
    status: typeof value.status === 'number' ? value.status : null,
    code: typeof value.code === 'string' ? value.code : null,
  }
}

/** 读取列表、摘要失败时的文案。企业未开通与服务不可用目前都是 503 memory_unavailable,无法区分。 */
export function describeMemoryProblem(error: unknown): MemoryProblem {
  const { status, code } = problemFields(error)
  if (status === 404 && code !== 'memory_employee_not_found' && code !== 'employee_not_found') {
    return { kind: 'unsupported', text: '当前版本暂不支持查看记忆，请更新服务后重试。', retry: false }
  }
  if (status === 404) return { kind: 'disabled', text: '这位员工不在企业服务中，暂时无法查看记忆。', retry: false }
  if (status === 403 && code === 'employee_not_authorized') return { kind: 'disabled', text: '你还没有获得这位员工的使用授权。', retry: false }
  if (status === 403) return { kind: 'disabled', text: '这位员工没有开启记忆', retry: false }
  if (status === 503 && code === 'manager_unavailable') return { kind: 'unavailable', text: '企业服务暂不可用', retry: true }
  if (status === 503) return { kind: 'unavailable', text: '记忆服务暂不可用', retry: true }
  return { kind: 'failed', text: '记忆加载失败', retry: true }
}

/** 删除失败的文案;普通成员只能删除自己贡献的记忆。 */
export function describeMemoryDeleteError(error: unknown): string {
  const { status, code } = problemFields(error)
  if (status === 403 && code === 'memory_not_contributor') return '只能删除由你的对话产生的记忆。'
  if (status === 403) return '没有权限删除这条记忆。'
  if (status === 503) return '记忆服务暂不可用，请稍后重试。'
  return '删除失败，请重试。'
}

/** 关键词去首尾空白并截到服务端上限(按字符计);空串不传。 */
export function normalizeMemoryKeyword(input: string): string | undefined {
  const keyword = input.trim()
  return keyword ? [...keyword].slice(0, MAX_MEMORY_KEYWORD_CHARS).join('') : undefined
}

/** 摘要卡片的入口文案:条数加载失败时只显示「查看全部 →」。 */
export function memoryEntryLabel(summary: EmployeeMemorySummary | null): string {
  return summary ? `查看全部 ${summary.total_count} 条 →` : '查看全部 →'
}

const pad = (value: number) => String(value).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 今天显示 HH:mm,今年显示 M/D,更早显示 YYYY/M/D;无法解析时为 null。 */
export function formatMemoryTime(value: string | null, now = new Date()): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  if (sameDay(date, now)) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** 顶部统计:条数 · 近 7 天新增 · 最近被用到。 */
export function describeMemorySummary(summary: EmployeeMemorySummary, now = new Date()): string {
  const parts = [`近 7 天新增 ${summary.recent_count}`]
  const latest = formatMemoryTime(summary.latest_used_at, now)
  if (latest) parts.push(`最近被用到 ${sameDay(new Date(summary.latest_used_at!), now) ? `今天 ${latest}` : latest}`)
  return parts.join(' · ')
}

/** 其他成员贡献、来源未知的记忆只显示数量,内容仅管理员可见;都为 0 时不显示。 */
export function describeHiddenMemories(summary: EmployeeMemorySummary): string | null {
  const parts: string[] = []
  if (summary.others_count > 0) parts.push(`另有 ${summary.others_count} 条来自其他同事的对话`)
  if (summary.unattributed_count > 0) parts.push(`来源未知 ${summary.unattributed_count} 条`)
  return parts.length ? `${parts.join('，')}，仅管理员可见` : null
}

/** 单条元信息里的时间:优先「被用到」,否则「保存于」。 */
export function memoryTimeLabel(memory: Pick<EmployeeMemory, 'created_at' | 'last_used_at'>, now = new Date()): string | null {
  const used = formatMemoryTime(memory.last_used_at, now)
  if (used) return `${used} 被用到`
  const created = formatMemoryTime(memory.created_at, now)
  return created ? `${created} 保存` : null
}

/** importance 0–1 换算为 4 档星;未知为 null(不显示星)。 */
export function memoryImportanceStars(importance: number | null): number | null {
  if (importance === null || !Number.isFinite(importance)) return null
  return Math.min(4, Math.max(1, Math.ceil(Math.min(1, Math.max(0, importance)) * 4)))
}

/** 超过 3 行(约 90 字或 3 个换行)的正文默认折叠。 */
export function isLongMemory(content: string): boolean {
  return [...content].length > 90 || content.split('\n').length > 3
}

export type MemoryGroupKey = 'today' | 'week' | 'earlier'
export const MEMORY_GROUP_LABELS: Record<MemoryGroupKey, string> = { today: '今天', week: '近 7 天', earlier: '更早' }

/** 按 created_at 分为今天 / 近 7 天 / 更早;组内保留服务端顺序,时间未知归入更早。 */
export function groupMemories(memories: readonly EmployeeMemory[], now = new Date()): Array<{ key: MemoryGroupKey; items: EmployeeMemory[] }> {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()
  const groups: Record<MemoryGroupKey, EmployeeMemory[]> = { today: [], week: [], earlier: [] }
  for (const memory of memories) {
    const at = memory.created_at ? Date.parse(memory.created_at) : NaN
    const key: MemoryGroupKey = Number.isNaN(at) ? 'earlier' : at >= todayStart ? 'today' : at >= weekStart ? 'week' : 'earlier'
    groups[key].push(memory)
  }
  return (['today', 'week', 'earlier'] as const).filter((key) => groups[key].length).map((key) => ({ key, items: groups[key] }))
}

/** 加载更多时追加下一页,按 memory_id 去重(删除后偏移量前移会产生重叠)。 */
export function appendMemoryPage(current: readonly EmployeeMemory[], next: readonly EmployeeMemory[]): EmployeeMemory[] {
  const seen = new Set(current.map((memory) => memory.memory_id))
  return [...current, ...next.filter((memory) => !seen.has(memory.memory_id))]
}
