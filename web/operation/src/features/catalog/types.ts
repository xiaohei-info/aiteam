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
 * 涉及运营端"专家 / 行业方案"的完整配置能力对齐:
 *   - 专家: persona / 推荐模型 / prompt_pack / skills / knowledge / memory / tags
 *   - 行业方案: expert_picks / knowledge_refs / skill_refs / prompts / grants / kb / skills
 */

/** 模板/方案类型（对齐 CatalogType enum）。 */
export type CatalogItemType = "expert_template" | "solution_template";

/** 模板/方案状态。 */
export type CatalogStatus = "draft" | "published" | "unpublished";

/** 前端可见范围简化表示（visible_scope dict 的前端投影）。 */
export type VisibilityLabel = "public" | "enterprise" | "hidden";

/** 推荐模型引用（对齐 recommended_config.default_model_ref 片段）。 */
export interface ModelRef {
  provider_key?: string;
  model_id?: string;
  model_name?: string;
  provider_name?: string;
  model_uid?: string;
}

/** 专家模板中 persona + 复杂配置的统一容器(对齐 recommended_config)。 */
export interface ExpertRecommendedConfig {
  prompt_pack?: Record<string, unknown>;
  default_model_ref?: ModelRef;
  default_binding?: Record<string, unknown>;
  default_skill_bundle?: Record<string, unknown>;
  default_skills?: string[];
  knowledge_bindings?: string[];
  connector_requirements?: unknown[];
  memory_config?: Record<string, unknown>;
  role_name?: string;
  category_code?: string;
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

  // ---- payload 顶层字段（对齐后端 CatalogEntryResponse + CatalogDetailView）----
  default_model_json?: Record<string, unknown>;
  default_binding_json?: Record<string, unknown>;
  prompt_pack_json?: Record<string, unknown>;
  category_code?: string;
  role_name?: string;
  persona?: string | null;
  recommended_config?: ExpertRecommendedConfig | Record<string, unknown> | null;
  expert_bindings?: ExpertBinding[];
  expert_template_ids?: string[];
  knowledge_refs?: string[];
  skill_refs?: string[];
  default_grants?: Record<string, unknown> | null;
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
  default_kb_blueprint?: Record<string, unknown>;
  default_skill_bundle?: Record<string, unknown>;
  default_collaboration_template_ref?: string | null;
  tags?: string[];
}

/** 注册专家模板请求体（对齐 RegisterExpertTemplateRequest）。 */
export interface RegisterExpertTemplate {
  template_id: string;
  display_name: string;
  persona?: string;
  recommended_config?: ExpertRecommendedConfig;
}

/** 注册行业方案请求体（对齐 RegisterSolutionTemplateRequest）。 */
export interface RegisterSolutionTemplate {
  solution_id: string;
  display_name: string;
  expert_template_ids?: string[];
  knowledge_refs?: string[];
  skill_refs?: string[];
  default_grants?: Record<string, unknown> | null;
  planner_prompt?: string;
  subtask_prompt?: string;
  aggregate_prompt?: string;
  default_kb_blueprint?: Record<string, unknown>;
  default_skill_bundle?: Record<string, unknown>;
  default_collaboration_template_ref?: string | null;
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
