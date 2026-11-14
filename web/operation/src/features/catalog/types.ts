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
 *   - 专家: display_name / category / avatar_url (local image data URL) / system_prompt /
 *     default_model / skill_ids / tags / description / initial_memories / sort_order
 *   - 行业方案: display_name / description / icon / expert_template_ids /
 *     expert_bindings / coordinator_template_id / coordinator_instructions / tags
 */

import type { ExpertTemplateProfile } from "./profile";

/** 模板/方案类型（对齐 CatalogType enum）。 */
export type CatalogItemType = "expert_template" | "solution_template";

/** 模板/方案状态。 */
export type CatalogStatus = "draft" | "published" | "unpublished";

/** 发布范围（对齐后端 VisibleScope）：全部企业；行业命中 / 任一标签命中；或暂不对任何企业开放。 */
export interface VisibleScope {
  mode: "all" | "limited" | "none";
  industries: string[];
  tags: string[];
}

export interface PlatformModelRef {
  provider_id: string;
  provider_version: number;
  model_id: string;
  model_version: number;
}

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

/** 目录项详情（对齐后端 CatalogDetailView）；人才市场展示字段仅专家模板有值，旧服务端可能缺省。 */
export interface CatalogItem extends Partial<ExpertTemplateProfile> {
  catalog_type: CatalogItemType;
  template_id: string;
  version: string;
  display_name: string;
  status: CatalogStatus;
  visible_scope: Record<string, unknown> | null;

  // ---- 专家模板字段 ----
  category?: string;
  /** Backward-compatible Catalog field; new values are validated local-image data URLs. */
  avatar_url?: string;
  system_prompt?: string;
  skill_ids?: string[];
  platform_skill_refs?: PlatformSkillRef[];
  tags?: string[];
  description?: string;
  initial_memories?: Record<string, unknown>[];
  sort_order?: number;
  /** 最近一次注册/编辑/发布时间；旧目录项为 null。 */
  updated_at?: string | null;

  // ---- 行业方案字段 ----
  icon?: string;
  expert_bindings?: ExpertBinding[];
  expert_template_ids?: string[];
  coordinator_template_id?: string;
  coordinator_instructions?: string;
}

/** 注册专家模板请求体（对齐 RegisterExpertTemplateRequest, PRD-v2 S02）；展示字段只带填写过的。 */
export interface RegisterExpertTemplate extends Partial<ExpertTemplateProfile> {
  /** 可选。不填时服务端按 display_name 自动生成 slug + 随机后缀。 */
  template_id?: string;
  display_name: string;
  category?: string;
  /** Optional local image encoded as a validated data URL for the legacy Catalog field. */
  avatar_url?: string;
  system_prompt?: string;
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
  coordinator_template_id?: string;
  coordinator_instructions?: string;
  tags?: string[];
}

/** 设可见范围请求体（对齐 SetVisibilityRequest）。 */
export interface SetVisibilityInput {
  catalog_type: CatalogItemType;
  template_id: string;
  visible_scope: VisibleScope;
}

/** 读取存量值：没有 mode 的旧数据一律视为全部企业。 */
export function normalizeScope(raw: unknown): VisibleScope {
  const value = (raw ?? {}) as Partial<VisibleScope>;
  if (value.mode === "none") return { mode: "none", industries: [], tags: [] };
  if (value.mode !== "limited") return { mode: "all", industries: [], tags: [] };
  return { mode: "limited", industries: value.industries ?? [], tags: value.tags ?? [] };
}

/** 新范围是否比原范围窄：全部企业改为指定范围、改为暂不开放，或去掉了原有的行业 / 标签。 */
export function scopeNarrowed(before: VisibleScope, after: VisibleScope): boolean {
  if (after.mode === "all" || before.mode === "none") return false;
  if (after.mode === "none" || before.mode === "all") return true;
  return before.industries.some((item) => !after.industries.includes(item))
    || before.tags.some((item) => !after.tags.includes(item));
}

export function scopeText(raw: unknown): string {
  const scope = normalizeScope(raw);
  if (scope.mode === "all") return "全部企业";
  if (scope.mode === "none") return "暂不开放";
  return `指定：${[...scope.industries, ...scope.tags].join("、")}`;
}

/** 从目录列表进入详情时携带的路由状态：列表网址上的搜索和筛选参数。 */
export interface CatalogDetailLocationState {
  listSearch?: string;
}
