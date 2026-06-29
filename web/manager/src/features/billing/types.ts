export interface UsageOverview { period: string; total_tokens: number; total_cost: number | string; top_employee_id: string | null; top_employee_tokens: number; trend: Array<Record<string, unknown>>; ranking: Array<Record<string, unknown>>; }
export interface UsageRecord { record_id: string; employee_id: string; employee_name: string; date: string; input_tokens: number; output_tokens: number; cost: number | string; }
export interface BillingBalance { balance: number | string; estimated_tokens: number; warning_threshold: number | string; updated_at: string; }
export interface Recharge { recharge_id: string; amount: number | string; payment_method: string; status: string; order_no: string; token_credited: number; created_at: string; }
