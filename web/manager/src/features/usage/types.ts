/** Manager /api/manager/usage/statistics 响应（租户内 Agent 上报的脱敏小时摘要，无会话内容）。 */
export type UsagePricingStatus = "known" | "partial" | "unknown";
export type UsageGroupBy = "employee" | "member";

export interface UsageStatisticsGroup {
  group_id: string | null;
  display_name: string;
  execution_count: number;
  succeeded_count: number;
  token_total: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_total: string | number | null;
  known_cost_total: string | number | null;
  pricing_status: UsagePricingStatus;
  unpriced_execution_count: number;
}

export interface UsageStatistics {
  window_start: string | null;
  window_end: string | null;
  execution_count: number;
  succeeded_count: number;
  token_total: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_total: string | number | null;
  known_cost_total: string | number | null;
  pricing_status: UsagePricingStatus;
  unpriced_execution_count: number;
  group_by?: UsageGroupBy;
  groups?: UsageStatisticsGroup[];
}

/** UTC 整点 [window_start, window_end)；全部时间为 null。 */
export interface UsageWindow { window_start: string; window_end: string }
