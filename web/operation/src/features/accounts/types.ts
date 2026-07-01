/** S01 账号管理 — 类型定义（issue #413 extends with lifecycle/quota/audit）。 */

export interface EnterpriseAccount {
  org_id: string;
  enterprise_name: string;
  contact_name: string;
  contact_phone: string;
  registered_at: string;
  total_recharged: number | string;
  token_consumed: number;
  status: string;
  /** New canonical lifecycle status (use this going forward). */
  operation_status?: string;
  monthly_active: boolean;
}

export interface QuotaSnapshot {
  employee_limit: number;
  employee_used: number;
  storage_limit_mb: number;
  storage_used_mb: number;
  api_rate_limit: number;
  api_rate_used: number;
  token_quota_limit: number;
  token_quota_used: number;
}

export interface EnrichedAudit {
  event_id: string;
  enterprise_id: string;
  action: string;
  detail?: string;
  actor_id?: string | null;
  actor_name?: string | null;
  severity?: string;
  result?: string;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
}

export interface EnterpriseAccountDetail extends EnterpriseAccount {
  recharge_records: Array<Record<string, unknown>>;
  audit_events: EnrichedAudit[];
  audit_events_total?: number;
  employee_count: number;
  token_history: Array<Record<string, unknown>>;
  quota?: QuotaSnapshot | null;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  banned_at?: string | null;
  banned_reason?: string | null;
  closed_at?: string | null;
}

export interface EnterpriseStats {
  total_enterprises: number;
  active_enterprises?: number;
  suspended_enterprises?: number;
  banned_enterprises?: number;
  closed_enterprises?: number;
  new_this_month: number;
  monthly_active: number;
  total_recharged: number | string;
}

export type EnterpriseActionBody =
  | { action: "recharge"; amount?: number | string; payment_method?: string }
  | { action: "notify"; message?: string }
  | { action: "ban"; message?: string }
  | { action: "unban" }
  | { action: "suspend"; reason?: string }
  | { action: "close"; reason?: string }
  | { action: "reactivate" }
  | { action: "adjust_quota"; quota?: number | string };

export interface LifecycleCommand {
  action: "activate" | "suspend" | "ban" | "close";
  reason?: string;
}
