/** S01 账号管理 — 类型定义（issue #413 extends with lifecycle/quota/audit）。 */

export interface PlatformModelRef {
  provider_id: string;
  provider_version: number;
  model_id: string;
  model_version: number;
}

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
  /** 删除时间（deleted 状态才有）；30 天保留期自此起算。 */
  deleted_at?: string | null;
  /** 数据清理完成时间。 */
  purged_at?: string | null;
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

/** 重置管理员密码的结果；一次性明文只在本次响应里出现。 */
export interface OwnerResetResult {
  enterprise_id: string;
  tenant_id: string;
  owner_phone: string;
  owner_bootstrap_secret: string;
  must_reset: boolean;
}

export interface EnterpriseModelAccess {
  enterprise_id: string;
  tenant_id: string;
  allowed_model_refs: PlatformModelRef[] | null;
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

/** 删除后的保留期（天），与服务端一致。 */
export const RETENTION_DAYS = 30;

/** 距保留期结束还剩几天（向上取整）；0 表示已到期，没有删除时间时为 null。 */
export function retentionDaysLeft(deletedAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!deletedAt) return null;
  const end = new Date(deletedAt).getTime() + RETENTION_DAYS * 86_400_000;
  return Math.max(0, Math.ceil((end - now) / 86_400_000));
}

/** 已删除企业的状态文案：剩余可恢复天数 / 可清理 / 已清理。 */
export function deletedLabel(
  enterprise: Pick<EnterpriseAccount, "deleted_at" | "purged_at">, now: number = Date.now(),
): string {
  if (enterprise.purged_at) return "已清理";
  const left = retentionDaysLeft(enterprise.deleted_at, now);
  if (left === null) return "已删除";
  return left > 0 ? `已删除 · ${left} 天内可恢复` : "已删除 · 可清理";
}
