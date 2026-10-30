/**
 * 办公室任务关键节点：SSE 事件 → 节点映射 + 自然日持久化。
 *
 * 设计要点（见方案讨论）：
 * 1. SSE 帧 id 是「条目身份」而非「事件身份」，同一 message 的多个事件共享 id，
 *    不能当节点主键。这里用复合键：工具节点 `${conv}:tool:${tool_call_id}` upsert，
 *    运行级节点 `${conv}:${work_id}:${type}`。
 * 2. localStorage 只存今天（本地自然日）：读写前比对日期键，跨天即重置。
 * 3. lastEventIds 按会话保存 SSE 续读游标，只作 `?after=` 游标，不作去重主键。
 */
import type { AgentSseEvent } from '../api/agent/events'
import type { PiSseEventData } from '../api/agent/types'

export type MilestoneKind =
  | 'run_start'
  | 'tool_start'
  | 'tool_end'
  | 'retry'
  | 'compaction'
  | 'approval'
  | 'run_end'
  | 'settled'
  | 'record_done'

export type MilestoneLevel = 'info' | 'warn' | 'action'

export interface OfficeMilestone {
  /** 复合唯一键，upsert 语义 */
  key: string
  at: string // ISO
  employee: string
  employeeId?: string
  conversationId: string
  workId?: string
  kind: MilestoneKind
  label: string
  level: MilestoneLevel
  /** 工具节点：end 到达后置 true，用于把「进行中」更新为终态 */
  done?: boolean
}

export interface MilestoneStorageShape {
  date: string // 本地自然日 YYYY-MM-DD
  lastEventIds: Record<string, string>
  items: OfficeMilestone[]
}

const STORAGE_KEY = 'office.milestones.v1'
const MAX_ITEMS = 200

export function localDayKey(d = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function emptyShape(date: string): MilestoneStorageShape {
  return { date, lastEventIds: {}, items: [] }
}

/** 读取持久化节点；日期不是今天则返回空态（自然日持久化）。 */
export function loadMilestoneStorage(now = new Date()): MilestoneStorageShape {
  const today = localDayKey(now)
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MilestoneStorageShape> | null
      if (parsed && parsed.date === today && Array.isArray(parsed.items)) {
        return {
          date: today,
          lastEventIds: parsed.lastEventIds ?? {},
          items: parsed.items.filter((m): m is OfficeMilestone => !!m && typeof m.key === 'string'),
        }
      }
    }
  } catch {
    // 存储损坏视同空态，不阻塞页面
  }
  return emptyShape(today)
}

/** 持久化；超容量时保留最新 MAX_ITEMS 条。写失败（配额）静默降级为仅内存。 */
export function saveMilestoneStorage(state: MilestoneStorageShape): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, items: state.items.slice(-MAX_ITEMS) }),
    )
  } catch {
    // 忽略配额错误
  }
}

export interface MilestoneFallback {
  employee: string
  employeeId?: string
  conversationId: string
}

function isPiEvent(evt: AgentSseEvent): evt is PiSseEventData {
  // reconciliation 帧的 type 为 'reconciliation'；其余为 PiSseEventData。
  return (evt as { type?: unknown }).type !== 'reconciliation'
}

/**
 * 把一条 SSE 事件映射为关键节点；非节点事件（message_update 等高频帧）返回 null。
 * eventId 是 SSE 帧 id，仅用于无 work_id/tool_call_id 时的兜底键。
 */
export function mapSseToMilestone(
  evt: AgentSseEvent,
  eventId: string | undefined,
  fallback: MilestoneFallback,
): OfficeMilestone | null {
  if (!isPiEvent(evt)) return null
  const conv = evt.conversation_id ?? fallback.conversationId
  const toolCallId = evt.tool_call_id ?? evt.toolCallId
  const workId = evt.work_id
  const base = {
    at: new Date().toISOString(),
    employee: evt.source_employee_display_name ?? fallback.employee,
    employeeId: evt.source_employee_id ?? fallback.employeeId,
    conversationId: conv,
    workId,
  }
  switch (evt.type) {
    case 'agent_start':
      return { ...base, key: `${conv}:${workId ?? eventId ?? 'run'}:start`, kind: 'run_start', label: '开始执行', level: 'info' }
    case 'tool_execution_start':
      if (!toolCallId) return null
      return {
        ...base,
        key: `${conv}:tool:${toolCallId}`,
        kind: 'tool_start',
        label: `调用工具 ${evt.toolName ?? 'unknown'}`,
        level: 'info',
        done: false,
      }
    case 'tool_execution_end': {
      if (!toolCallId) return null
      const failed = evt.isError === true
      return {
        ...base,
        key: `${conv}:tool:${toolCallId}`, // 与 start 同键：upsert 更新为终态
        kind: 'tool_end',
        label: `工具 ${evt.toolName ?? 'unknown'} ${failed ? '失败' : '完成'}`,
        level: failed ? 'warn' : 'info',
        done: true,
      }
    }
    case 'auto_retry_start':
      return {
        ...base,
        key: `${conv}:retry:${workId ?? ''}:${evt.attempt ?? eventId ?? ''}`,
        kind: 'retry',
        label: `自动重试 第 ${evt.attempt ?? '?'}/${evt.maxAttempts ?? '?'} 次`,
        level: 'warn',
      }
    case 'compaction_start':
      return {
        ...base,
        key: `${conv}:compact:${workId ?? eventId ?? Date.now()}`,
        kind: 'compaction',
        label: '上下文压缩',
        level: 'info',
      }
    case 'approval_required':
      return {
        ...base,
        key: `${conv}:approval:${toolCallId ?? eventId ?? workId ?? Date.now()}`,
        kind: 'approval',
        label: '等待人工审批',
        level: 'action',
      }
    case 'agent_end':
      return {
        ...base,
        key: `${conv}:${workId ?? eventId ?? 'run'}:end`,
        kind: 'run_end',
        label: evt.reason === 'error' ? '执行结束（错误）' : evt.reason === 'aborted' ? '执行被中止' : '执行结束',
        level: evt.reason === 'error' ? 'warn' : 'info',
      }
    case 'agent_settled':
      return {
        ...base,
        key: `${conv}:${workId ?? eventId ?? 'run'}:settled`,
        kind: 'settled',
        label: '执行完成，已结算',
        level: 'info',
      }
    default:
      // message_update / message_end / tool_execution_update / auto_retry_end / compaction_end 等不落节点
      return null
  }
}

/** upsert：同键更新（保留首次出现时间，刷新内容），否则追加；总量裁剪。 */
export function upsertMilestone(items: OfficeMilestone[], next: OfficeMilestone): OfficeMilestone[] {
  const idx = items.findIndex((m) => m.key === next.key)
  let result: OfficeMilestone[]
  if (idx >= 0) {
    result = items.slice()
    result[idx] = { ...next, at: items[idx].at }
  } else {
    result = [...items, next]
  }
  return result.length > MAX_ITEMS ? result.slice(-MAX_ITEMS) : result
}
