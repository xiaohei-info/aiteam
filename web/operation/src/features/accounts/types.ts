/** S01 账号管理 — 类型定义。 */

export interface EnterpriseAccount {
  org_id: string;
  enterprise_name: string;
  contact_name: string;
  contact_phone: string;
  registered_at: string;
  total_recharged: number | string;
  token_consumed: number;
  status: string;
  monthly_active: boolean;
}

export interface EnterpriseAccountDetail extends EnterpriseAccount {
  recharge_records: Array<Record<string, unknown>>;
  employee_count: number;
  token_history: Array<Record<string, unknown>>;
}

export interface EnterpriseStats {
  total_enterprises: number;
  new_this_month: number;
  monthly_active: number;
  total_recharged: number | string;
}

export interface EnterpriseActionBody {
  action: "recharge" | "ban" | "unban" | "notify" | "adjust_quota";
  amount?: number | string;
  message?: string;
}
