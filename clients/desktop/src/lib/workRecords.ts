import type { WorkRecord, WorkChange } from '../api/agent/observations.types'

export interface WorkWindow { window_start?: string; window_end?: string }
export const WORK_OUTCOME_LABELS: Record<WorkRecord['outcome'], string> = {
  active: '执行中', succeeded: '成功', error: '失败', aborted: '已中止', unknown: '结果未知',
}

export function matchesWorkWindow(record: WorkRecord, window: WorkWindow): boolean {
  if (!window.window_start && !window.window_end) return true
  if (!record.occurred_at) return false
  const time = Date.parse(record.occurred_at)
  return Number.isFinite(time) && (!window.window_start || time >= Date.parse(window.window_start))
    && (!window.window_end || time < Date.parse(window.window_end))
}

export function mergeWorkChanges(records: ReadonlyMap<string, WorkRecord>, changes: readonly WorkChange[], window: WorkWindow): Map<string, WorkRecord> {
  const next = new Map(records)
  for (const change of changes) {
    if (change.operation === 'delete' || !matchesWorkWindow(change.record, window)) next.delete(change.record_id)
    else next.set(change.record_id, change.record)
  }
  return next
}

/** Round only the final decimal string, without binary float or cents summation. */
export function formatUsdDecimal(value: string | null | undefined): string {
  if (value == null || !/^\d+(\.\d+)?$/.test(value)) return '未知'
  const [whole, fraction = ''] = value.split('.')
  const digits = fraction.padEnd(3, '0')
  const cents = BigInt(whole) * 100n + BigInt(digits.slice(0, 2)) + (digits[2] >= '5' ? 1n : 0n)
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
