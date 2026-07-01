/**
 * 目录治理（F03）——前端类型声明。
 *
 * 对齐后端 CatalogEntryResponse schema（routes_catalog.py / catalog_schemas.py）。
 */

/** 模板/方案类型（对齐 CatalogType enum）。 */
export type CatalogItemType = "expert_template" | "solution_template";

/** 模板/方案状态。 */
export type CatalogStatus = "draft" | "published" | "unpublished";

/** 前端可见范围简化表示（visible_scope dict 的前端投影）。 */
export type VisibilityLabel = "public" | "enterprise" | "hidden";

/** 目录项——对齐后端 CatalogEntryResponse。 */
export interface CatalogItem {
  catalog_type: CatalogItemType;
  template_id: string;
  version: string;
  display_name: string;
  status: CatalogStatus;
  visible_scope: Record<string, unknown> | null;
  persona?: string | null;
  recommended_config?: Record<string, unknown>;
  expert_bindings?: ExpertBinding[];
  knowledge_refs?: string[];
  skill_refs?: string[];
  default_grants?: Record<string, unknown> | null;
}

/** 方案内专家绑定（对齐后端 ExpertBinding schema）。 */
export interface ExpertBinding {
  template_id: string;
  sequence_no: number;
  enabled: boolean;
}

/** 注册专家模板请求体（对齐 RegisterExpertTemplateRequest）。 */
export interface RegisterExpertTemplate {
  template_id: string;
  display_name: string;
  persona?: string;
}

/** 注册行业方案请求体（对齐 RegisterSolutionTemplateRequest）。 */
export interface RegisterSolutionTemplate {
  solution_id: string;
  display_name: string;
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
