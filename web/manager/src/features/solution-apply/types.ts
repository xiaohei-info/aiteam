/**
 * SolutionApplyRecord 追踪页类型（AITEAM-266）。
 *
 * 严格对齐后端契约——所有字段取自 manager_service/schemas.py:SolutionApplyRecordOut，
 * 不重定义。SolutionApplyRecord 是方案应用的历史/审计行（who/when/version/status + 落地专家），
 * 前端只读展示，不写配置。
 */

/** 方案应用状态：applied | revoked（对齐 SolutionApplyRecordOut.status）。 */
export type SolutionApplyStatus = "applied" | "revoked";

/** 一条方案应用记录（对齐 SolutionApplyRecordOut，仅取页面所需字段）。 */
export interface SolutionApplyRecord {
  id: string;
  solution_id: string;
  solution_version: string;
  applied_by: string | null;
  status: SolutionApplyStatus | string;
  expert_instance_ids: string[];
  detail: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 方案实例（对齐 SolutionInstanceOut，仅取页面所需字段）。 */
export interface SolutionInstanceSummary {
  id: string;
  solution_id: string;
  solution_version: string;
  display_name: string;
  status: string;
  created_at: string | null;
}
