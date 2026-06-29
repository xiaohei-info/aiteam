/** S04 财务管理 — 类型定义。 */

export interface FinanceOverview {
  period: string;
  total_recharged: number | string;
  total_tokens_billed: number;
  total_api_cost: number | string;
  gross_profit: number | string;
  profit_margin: number;
  active_orgs: number;
  monthly_trend: Array<Record<string, unknown>>;
  top5_consumers: Array<Record<string, unknown>>;
}

export interface FinanceReport {
  recharge_details: Array<Record<string, unknown>>;
  consumption_details: Array<Record<string, unknown>>;
  profit_details: Array<Record<string, unknown>>;
}
