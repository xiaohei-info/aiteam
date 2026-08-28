/** S04 财务管理 — 类型定义。 */

export interface FinanceOverview {
  period: string;
  total_recharged: number | string;
  total_tokens_billed: number;
  total_api_cost: number | string;
  unknown_pricing_tokens?: number;
  unknown_pricing_runs?: number;
  gross_profit: number | string | null;
  profit_margin: number | null;
  profit_status?: string;
  revenue_currency?: "CNY";
  cost_currency?: "USD";
  active_orgs: number;
  monthly_trend: Array<Record<string, unknown>>;
  top5_consumers: Array<Record<string, unknown>>;
}

export interface FinanceReport {
  recharge_details: Array<Record<string, unknown>>;
  consumption_details: Array<Record<string, unknown>>;
  profit_details: Array<Record<string, unknown>>;
}
