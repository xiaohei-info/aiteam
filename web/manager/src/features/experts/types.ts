/**
 * 招募专家共享类型定义（W-M.3）。
 *
 * 为 /marketplace（浏览+招募）、/solutions（方案目录+应用）与共享 useExpertsApi 提供类型。
 * 与后端契约对齐（不重定义）：
 * - 浏览：/api/manager/recruit/catalog/experts → ExpertTemplateDetail；/catalog/solutions → SolutionPackage
 * - 招募/应用：/api/manager/recruit/experts、/solutions
 * - 实例：/api/manager/employees（EmployeeConfigOut；PUT 全量 EmployeeConfigIn）
 */

/** 可招募专家模板（对齐 ExpertTemplateDetail）。 */
export interface ExpertTemplate {
  template_id: string;
  version: string;
  display_name: string;
  persona?: string | null;
  platform_model_ref?: { provider_id: string; provider_version: number; model_id: string; model_version: number };
  is_recruited?: boolean;
}

/** 方案包内专家摘要（对齐 SolutionPackage.experts 的 ExpertTemplateDetail）。 */
export interface SolutionPackageExpertSummary {
  template_id: string;
  version: string;
  display_name: string;
  persona?: string | null;
  category?: string;
  avatar_url?: string;
  system_prompt?: string;
  platform_model_ref?: { provider_id: string; provider_version: number; model_id: string; model_version: number };
  skill_ids?: string[];
  description?: string;
  sequence_no?: number;
  enabled?: boolean;
}

/**
 * 可应用行业方案包（对齐 SolutionPackage）。
 * 详情字段（experts / knowledge_refs / skill_refs / prompts / tags）后端已通过 catalog 端口返回，
 * 前端取全量用于「查看方案详情」展示，不再裁剪。
 */
export interface SolutionPackage {
  solution_id: string;
  version: string;
  display_name: string;
  experts?: SolutionPackageExpertSummary[];
  knowledge_refs?: string[];
  skill_refs?: string[];
  tags?: string[];
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
}

/** 中立模型策略（对齐 ModelPolicy）。 */
export interface ModelPolicy {
  model: string;
  provider_ref?: string | null;
  provider_version?: number | null;
  model_version?: number | null;
  pricing?: Record<string, unknown> | null;
  thinking_level?: string | null;
}

/** Pi 会话执行限制；不选择底层执行器。 */
export interface ExecutionPolicy {
  timeout_seconds?: number | null;
}

/** 专家实例配置（对齐 EmployeeConfigOut；PUT 时回传全量为 EmployeeConfigIn）。 */
export interface EmployeeConfig {
  employee_id: string;
  employee_slug: string;
  version: number;
  display_name: string;
  persona?: string | null;
  model_policy: ModelPolicy;
  execution_policy: ExecutionPolicy;
  tools: string[];
  skills: string[];
  knowledge_refs: string[];
  connector_refs: string[];
  memory_policy: Record<string, unknown> | null;
  status: string;
  archive_reason?: string | null;
  archived_at?: string | null;
}

/**
 * EmployeeConfig 写入端（对齐后端 EmployeeConfigIn）。
 * 仅含可编辑/可透传字段，剔除服务端托管字段（employee_id / employee_slug / version / status / archive_reason / archived_at）。
 * PUT /api/manager/employees/{id} 使用此形态，避免把只读标识回写后端。
 */
export type EmployeeConfigIn = Omit<
  EmployeeConfig,
  "employee_id" | "employee_slug" | "version" | "status" | "archive_reason" | "archived_at"
>;

/** 可用生命周期流转（对齐 EmployeeLifecycleOptionsOut）。 */
export interface LifecycleOptions {
  allowed_transitions: string[];
  is_runnable: boolean;
  is_provisionable: boolean;
}

/** 招募专家入参（对齐 RecruitExpertRequest）。 */
export interface RecruitExpertInput {
  template_id: string;
  template_version?: string | null;
  /** 可选；未传时后端自动生成 slug（PRD P03：实例标识由服务端自动创建）。 */
  employee_slug?: string | null;
  display_name_override?: string | null;
}

/** 应用方案入参（对齐 ApplySolutionRequest）。 */
export interface ApplySolutionInput {
  solution_id: string;
  solution_version?: string | null;
  display_name_override?: string | null;
}

/** 本 tenant 的方案实例（对齐 SolutionInstanceOut）。 */
export interface SolutionInstance {
  id: string;
  solution_id: string;
  solution_version: string;
  display_name: string;
  status: string;
  expert_employee_ids: string[];
  knowledge_refs: string[];
  skill_refs: string[];
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
  created_at: string | null;
  updated_at: string | null;
}
