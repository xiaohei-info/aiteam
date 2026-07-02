/**
 * 招募专家页类型（W-M.3）。
 *
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
}

/** 可应用行业方案包（对齐 SolutionPackage，仅取页面所需字段）。 */
export interface SolutionPackage {
  solution_id: string;
  version: string;
  display_name: string;
}

/** 中立模型策略（对齐 ModelPolicy）。 */
export interface ModelPolicy {
  model: string;
  provider_ref?: string | null;
  thinking_level?: string | null;
}

/** 中立运行时策略（对齐 RuntimePolicy）。 */
export interface RuntimePolicy {
  runtime_binding?: string | null;
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
  runtime_policy: RuntimePolicy;
  tools: string[];
  skills: string[];
  knowledge_refs: string[];
  connector_refs: string[];
  memory_policy: Record<string, unknown> | null;
  status: string;
  archive_reason?: string | null;
  archived_at?: string | null;
}

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
  employee_slug: string;
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

/** 方案实例局部更新（对齐 SolutionInstanceUpdate，AITEAM-288）。 */
export interface SolutionInstanceUpdateInput {
  display_name?: string;
  expert_employee_ids?: string[];
  knowledge_refs?: string[];
  skill_refs?: string[];
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
}
