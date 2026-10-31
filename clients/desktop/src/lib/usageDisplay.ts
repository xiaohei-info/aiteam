export const USAGE_DATA_UNAVAILABLE = '数据未提供'

export interface EmployeeUsageMetrics {
  invocation_count?: number | null
  token_usage?: number | null
  total_cost?: number | null
  currency?: string | null
}

export interface TemplateUsageMetrics {
  price_per_call?: number | null
  cumulative_cost?: number | null
  currency?: string | null
}

function isUsageNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function formatUsageCount(value: number | null | undefined): string {
  return isUsageNumber(value) && Number.isInteger(value)
    ? value.toLocaleString('zh-CN')
    : USAGE_DATA_UNAVAILABLE
}

export function formatUsageCost(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (!isUsageNumber(value)) return USAGE_DATA_UNAVAILABLE

  const amount = value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
  if (currency === 'CNY') return `¥${amount}`
  if (currency === 'USD') return `$${amount}`
  return currency ? `${currency} ${amount}` : amount
}

export function formatPricePerCall(
  value: number | null | undefined,
  currency?: string | null,
): string {
  const amount = formatUsageCost(value, currency)
  return amount === USAGE_DATA_UNAVAILABLE ? amount : `${amount}/次`
}
