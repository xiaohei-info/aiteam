/**
 * 员工详情、群聊详情用量卡片的显示规则。口径来自 GET /api/agent/usage/statistics：
 * 当前成员 + 当前设备；cost_total 为 null 表示有执行未定价，绝不显示成 $0。
 */
import type { UsageOutcomes, UsageStatistics, UsageStatisticsGroup } from '../api/agent/observations.types.ts'
import type { ContextSegment } from '../api/agent/types.ts'
import type { GroupMember } from './groupRoster.ts'
import type { UsageWindow } from './usageWindow.ts'
import { formatUsdDecimal } from './workRecords.ts'

type UsageCost = Pick<UsageStatistics, 'cost_total' | 'known_cost_total' | 'pricing_status' | 'unpriced_execution_count'>

export interface UsageCostDisplay { value: string; note: string | null }

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** ≥1000 用 K/M 缩写。 */
export function formatTokenCount(value: number): string {
  return compactFormatter.format(value)
}

export function describeUsageTokens(usage: Pick<UsageStatistics, 'input_tokens' | 'output_tokens' | 'cache_tokens'>): string {
  return `输入 ${formatTokenCount(usage.input_tokens)} · 输出 ${formatTokenCount(usage.output_tokens)} · 缓存 ${formatTokenCount(usage.cache_tokens)}`
}

/** known 显示最终费用；partial 显示「≥ 已知小计」并说明未定价次数；unknown 显示「未定价」。 */
export function describeUsageCost(usage: UsageCost): UsageCostDisplay {
  if (usage.pricing_status === 'known' && usage.cost_total !== null) return { value: formatUsdDecimal(usage.cost_total), note: null }
  if (usage.pricing_status === 'unknown') return { value: '未定价', note: '模型未定价' }
  return {
    value: `≥${formatUsdDecimal(usage.known_cost_total)}`,
    note: usage.unpriced_execution_count > 0 ? `${usage.unpriced_execution_count} 次执行未定价` : '部分未定价',
  }
}

/** 执行为 0 时没有成功率。 */
export function usageSuccessRate(usage: Pick<UsageStatistics, 'execution_count' | 'succeeded_count'>): number | null {
  return usage.execution_count === 0 ? null : Math.round((usage.succeeded_count / usage.execution_count) * 100)
}

/** 已评估不足 min_sample 段时服务端不给比例，显示「样本不足」和已评估段数。 */
export function describeResolution(outcomes: UsageOutcomes): { value: string; detail: string } {
  if (outcomes.resolution_rate === null) {
    return { value: '样本不足', detail: `${outcomes.evaluated_count} 段已评估，满 ${outcomes.min_sample} 段后显示` }
  }
  return { value: `${Math.round(outcomes.resolution_rate * 100)}%`, detail: `${outcomes.evaluated_count} 段已评估` }
}

/** 群聊解决情况：按段落结束时间落在时间窗内统计；未评估的段不计入。 */
export function tallySegmentOutcomes(segments: readonly ContextSegment[], window: UsageWindow | Record<string, never>) {
  const start = 'window_start' in window ? Date.parse(window.window_start) : -Infinity
  const end = 'window_end' in window ? Date.parse(window.window_end) : Infinity
  let evaluated = 0
  let resolved = 0
  for (const segment of segments) {
    const endedAt = Date.parse(segment.ended_at)
    if (!segment.outcome || !(endedAt >= start && endedAt < end)) continue
    evaluated += 1
    if (segment.outcome === 'resolved') resolved += 1
  }
  return { evaluated, resolved }
}

export interface GroupUsageRow {
  employeeId: string
  member: GroupMember
  coordinator: boolean
  // 已被移出群，或服务端无法归属（employee_id = "unknown"）的历史用量仍计入合计。
  removed: boolean
  unattributed: boolean
  tokens: number
  cost: UsageCostDisplay
  // 占本群 Token 合计的百分比。
  share: number
}

/** 按服务端顺序（token_total 降序）把分组映射成成员行；名字依次取群成员、员工列表，否则显示 ID。 */
export function groupUsageRows(
  groups: readonly UsageStatisticsGroup[],
  members: readonly GroupMember[],
  employees: ReadonlyMap<string, { displayName: string; avatarUrl?: string | null }>,
): GroupUsageRow[] {
  const total = groups.reduce((sum, group) => sum + group.token_total, 0)
  const byId = new Map(members.map((member) => [member.employee_id, member]))
  return groups.map((group) => {
    const current = byId.get(group.employee_id)
    const unattributed = group.employee_id === 'unknown'
    const employee = employees.get(group.employee_id)
    const member: GroupMember = current ?? {
      employee_id: group.employee_id,
      member_ref_id: group.employee_id,
      member_id: group.employee_id,
      display_name: unattributed ? '未归属' : employee?.displayName ?? group.employee_id,
      avatar_url: employee?.avatarUrl ?? null,
    }
    return {
      employeeId: group.employee_id,
      member,
      coordinator: Boolean(current?.is_system_planner),
      removed: !current && !unattributed,
      unattributed,
      tokens: group.token_total,
      cost: describeUsageCost(group),
      share: total > 0 ? Math.round((group.token_total / total) * 100) : 0,
    }
  })
}

/** 参与员工 = 时间范围内有执行记录的当前群成员数 / 当前群成员数；移出的员工只计入用量，不计入人数。 */
export function groupParticipation(groups: readonly UsageStatisticsGroup[], members: readonly GroupMember[]): number {
  const memberIds = new Set(members.map((member) => member.employee_id))
  return groups.filter((group) => group.execution_count > 0 && memberIds.has(group.employee_id)).length
}

/** 成员超过 6 位时默认显示前 5 位，其余折叠为「其他 N 位」。 */
export function splitUsageRows<T>(rows: readonly T[], expanded: boolean): { visible: readonly T[]; hidden: number } {
  if (expanded || rows.length <= 6) return { visible: rows, hidden: 0 }
  return { visible: rows.slice(0, 5), hidden: rows.length - 5 }
}
