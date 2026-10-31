/**
 * 用量统计的时间窗。GET /api/agent/usage/statistics 要求 window_start/window_end 都对齐 UTC 整点，
 * 否则 422，所以本地午夜向下取整到 UTC 小时，终点取当前时刻之后的下一个 UTC 整点。
 * UTC+8 这类整点时区没有误差；UTC+5:30 这类时区会多算半小时，属于已知局限，界面不显示。
 * 每次请求都要重新计算，跨天、跨小时后窗口才会随之滚动。
 */
export type UsageRange = 'today' | 'week' | 'all'

export interface UsageWindow { window_start: string; window_end: string }

export const USAGE_RANGE_LABELS: Record<UsageRange, string> = { today: '今日', week: '近 7 天', all: '全部' }

const HOUR = 3_600_000

function hourAlignedWindow(localStart: Date, now: Date): UsageWindow {
  return {
    window_start: new Date(Math.floor(localStart.getTime() / HOUR) * HOUR).toISOString(),
    window_end: new Date(Math.ceil((now.getTime() + 1) / HOUR) * HOUR).toISOString(),
  }
}

/** 本地当日，含当前小时。 */
export function todayWindow(now = new Date()): UsageWindow {
  return hourAlignedWindow(new Date(now.getFullYear(), now.getMonth(), now.getDate()), now)
}

/** 含今天在内的最近 days 个本地自然日。 */
export function lastDaysWindow(days: number, now = new Date()): UsageWindow {
  return hourAlignedWindow(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)), now)
}

/** 「全部」不传时间窗。 */
export function usageRangeWindow(range: UsageRange, now = new Date()): UsageWindow | Record<string, never> {
  if (range === 'today') return todayWindow(now)
  if (range === 'week') return lastDaysWindow(7, now)
  return {}
}
