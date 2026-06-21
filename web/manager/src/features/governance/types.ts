/**
 * 企业治理页类型（W-M.5）。
 *
 * 与后端契约对齐（不重定义）：计量聚合 UsageRollupOut、审计摘要 AuditSummaryOut、
 * 软配额策略 QuotaPolicyIn/Out、治理动作 QuotaEnforcementActionOut（D24 软配额，不阻断 run）。
 * 红线：本页只展示脱敏聚合摘要，绝不含会话内容（D13）。
 */

/** 计量聚合行（对齐 UsageRollupOut）。 */
export interface UsageRollup {
  rollup_id: string;
  summary_id: string;
  employee_id?: string | null;
  window_start: string;
  window_end: string;
  run_count: number;
  token_total: number;
  cost_total: string | number;
  error_count: number;
  duration_seconds_total: number;
}

/** 审计事件摘要（对齐 AuditSummaryOut）。 */
export interface AuditSummary {
  event_id: string;
  summary_id: string;
  actor: string;
  action: string;
  resource_type?: string | null;
  resource_id?: string | null;
  occurred_at: string;
}

/** 软配额策略（对齐 QuotaPolicyOut）。 */
export interface QuotaPolicy {
  policy_id: string;
  policy_slug: string;
  display_name: string;
  scope: string;
  target_ref?: string | null;
  window_start: string;
  window_end: string;
  dimensions: Record<string, unknown>;
  enforcement: string;
  status: string;
  version: number;
}

/** 建配额策略入参（对齐 QuotaPolicyIn）。 */
export interface CreateQuotaInput {
  policy_slug: string;
  display_name: string;
  scope: "tenant" | "employee" | "member";
  target_ref?: string | null;
  window_start: string;
  window_end: string;
  dimensions: Record<string, number>;
  enforcement: "soft" | "hard";
  status: "active" | "paused";
}

/** 治理动作结果（对齐 QuotaEnforcementActionOut）。 */
export interface EnforcementAction {
  policy_id: string;
  policy_slug: string;
  enforcement: string;
  actions: string[];
  severity: string;
  detail?: string | null;
}
