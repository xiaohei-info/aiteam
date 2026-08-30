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
  category?: string | null;
  avatar_url?: string | null;
  description?: string | null;
  tags?: string[];
  skill_ids?: string[];
  platform_skill_refs?: Array<{ skill_id: string; version: string; content_hash: string }>;
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
 * 可应用行业方案包（对齐 Pi-native SolutionPackage）。
 * 专家能力来自各自模板；方案只描述固定 roster、协调专家和协作说明。
 */
export interface SolutionPackage {
  solution_id: string;
  version: string;
  display_name: string;
  description?: string;
  icon?: string;
  coordinator_template_id?: string;
  coordinator_instructions?: string;
  workflow_skill_ref?: Record<string, unknown> | null;
  output_requirements?: string;
  experts?: SolutionPackageExpertSummary[];
  tags?: string[];
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
  /** Employee organizational departments; an empty list means 未设置. */
  department_ids?: string[];
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
  department_ids?: string[];
  member_ids?: string[];
}

/** 应用方案入参（对齐 ApplySolutionRequest）。 */
export interface ApplySolutionInput {
  solution_id: string;
  solution_version?: string | null;
  display_name_override?: string | null;
  department_ids?: string[];
  member_ids?: string[];
}

/** 本 tenant 的方案实例（对齐 Pi-native SolutionInstanceOut）。 */
export interface SolutionInstance {
  id: string;
  solution_id: string;
  solution_version: string;
  display_name: string;
  status: string;
  expert_employee_ids: string[];
  coordinator_employee_id?: string | null;
  coordinator_instructions?: string;
  workflow_skill_ref?: Record<string, unknown> | null;
  output_requirements?: string;
  config_version?: number;
  created_at: string | null;
  updated_at: string | null;
}

/** Department option used by recruitment and employee configuration dialogs. */
export interface Department {
  id: string;
  display_name: string;
}

/** Result of Manager solution expansion; employees are the tenant-owned targets for optional bindings. */
export interface ApplySolutionResult {
  solution_instance?: SolutionInstance;
  experts?: Array<{ employee_id: string }>;
  grants_applied?: boolean;
}
