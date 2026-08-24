/**
 * 目录治理（F03）——前端类型声明。
 *
 * 对齐后端 schema:
 *   - routes_catalog.py
 *   - catalog_schemas.py (RegisterExpertTemplateRequest /
 *     RegisterSolutionTemplateRequest / UpdateExpertTemplateRequest /
 *     UpdateSolutionTemplateRequest / CatalogEntryResponse /
 *     CatalogDetailView)
 *
 * 字段对齐 PRD-v2 S02/S03：
 *   - 专家: display_name / category / avatar_url / system_prompt /
 *     default_model / skill_ids / tags / description / initial_memories / sort_order
 *   - 行业方案: display_name / description / icon / expert_template_ids /
 *     expert_bindings / knowledge_refs / skill_refs / planner_prompt /
 *     subtask_prompt / aggregate_prompt / default_grants / tags
 */

/** 模板/方案类型（对齐 CatalogType enum）。 */
export type CatalogItemType = "expert_template" | "solution_template";

/** 模板/方案状态。 */
export type CatalogStatus = "draft" | "published" | "unpublished";

/** 前端可见范围简化表示（visible_scope dict 的前端投影）。 */
export type VisibilityLabel = "public" | "enterprise" | "hidden";

export interface PlatformSkillRef {
  skill_id: string;
  version: string;
  content_hash: string;
}

/** 方案内专家绑定（对齐后端 ExpertBinding schema）。 */
export interface ExpertBinding {
  template_id: string;
  sequence_no: number;
  enabled: boolean;
}

/** 目录项详情（对齐后端 CatalogDetailView）。 */
export interface CatalogItem {
  catalog_type: CatalogItemType;
  template_id: string;
  version: string;
  display_name: string;
  status: CatalogStatus;
  visible_scope: Record<string, unknown> | null;

  // ---- 专家模板字段 ----
  category?: string;
  avatar_url?: string;
  system_prompt?: string;
  default_model?: string;
  skill_ids?: string[];
  platform_skill_refs?: PlatformSkillRef[];
  tags?: string[];
  description?: string;
  initial_memories?: Record<string, unknown>[];
  sort_order?: number;

  // ---- 行业方案字段 ----
  icon?: string;
  expert_bindings?: ExpertBinding[];
  expert_template_ids?: string[];
  planner_template_id?: string;
  knowledge_refs?: string[];
  skill_refs?: string[];
  default_grants?: Record<string, unknown> | null;
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
}

/** 注册专家模板请求体（对齐 RegisterExpertTemplateRequest, PRD-v2 S02）。 */
export interface RegisterExpertTemplate {
  /** 可选。不填时服务端按 display_name 自动生成 slug + 随机后缀。 */
  template_id?: string;
  display_name: string;
  category?: string;
  avatar_url?: string;
  system_prompt?: string;
  default_model?: string;
  platform_skill_refs?: PlatformSkillRef[];
  description?: string;
}

/** 注册行业方案请求体（对齐 RegisterSolutionTemplateRequest）。 */
export interface RegisterSolutionTemplate {
  /** 可选。不填时服务端按 display_name 自动生成 slug + 随机后缀。 */
  solution_id?: string;
  display_name: string;
  description?: string;
  icon?: string;
  expert_template_ids?: string[];
  expert_bindings?: ExpertBinding[];
  planner_template_id?: string;
  knowledge_refs?: string[];
  skill_refs?: string[];
  default_grants?: Record<string, unknown> | null;
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
  tags?: string[];
}

/** 设可见范围请求体（对齐 SetVisibilityRequest）。 */
export interface SetVisibilityInput {
  catalog_type: CatalogItemType;
  template_id: string;
  visible_scope: Record<string, unknown>;
}

/** 前端用于区分 visible_scope dict 语义的辅助函数。 */
export function visibilityLabel(scope: Record<string, unknown> | null): VisibilityLabel {
  if (!scope || Object.keys(scope).length === 0) return "public";
  if (scope["enterprise_only"]) return "enterprise";
  if (scope["hidden"]) return "hidden";
  return "public";
}

export function labelToVisibleScope(label: VisibilityLabel): Record<string, unknown> {
  if (label === "enterprise") return { enterprise_only: true };
  if (label === "hidden") return { hidden: true };
  return {};
}
