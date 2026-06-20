/**
 * 目录治理（F03）——前端类型声明。
 *
 * 模板/方案目录项，与后端 /api/operation/catalog/* 返回口径对齐。
 * 本文件仅定义前端消费的类型，不重定义后端枚举值集。
 */

/** 模板/方案类型。 */
export type CatalogItemType = "expert_template" | "solution_template";

/** 模板/方案状态。 */
export type CatalogStatus = "draft" | "published" | "unpublished";

/** 可见范围。 */
export type Visibility = "public" | "enterprise" | "hidden";

/** 目录项——列表与详情共用。 */
export interface CatalogItem {
  id: string;
  type: CatalogItemType;
  name: string;
  description: string;
  status: CatalogStatus;
  visibility: Visibility;
  tags: string[];
  version: string;
  author: string;
  created_at: string;
  updated_at: string;
}

/** 注册请求体（专家模板）。 */
export interface RegisterExpertTemplate {
  name: string;
  description: string;
  tags: string[];
}

/** 注册请求体（行业方案）。 */
export interface RegisterSolutionTemplate {
  name: string;
  description: string;
  tags: string[];
}

/** 设可见范围请求体。 */
export interface SetVisibilityInput {
  id: string;
  visibility: Visibility;
}
