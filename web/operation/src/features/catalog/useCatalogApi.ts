/**
 * 目录治理 API hook（F03）。
 *
 * 路径已对齐后端 routes_catalog.py（prefix /api/operation/catalog）：
 *   GET ""                                          → 列表
 *   GET /{catalog_type}/{template_id}               → 详情
 *   POST /expert-templates                          → 注册专家模板（完整 payload）
 *   POST /solution-templates                        → 注册行业方案（完整 payload）
 *   POST /{catalog_type}/{template_id}/publish      → 发布
 *   POST /{catalog_type}/{template_id}/unpublish    → 下架
 *   PUT  /{catalog_type}/{template_id}/visibility   → 改可见范围
 *   PATCH /{catalog_type}/{template_id}             → 部分更新（含 payload）
 */
import { useCallback, useMemo } from "react";
import { ApiError } from "@aiteam/shared";
import type { ListResult } from "@aiteam/shared";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  CatalogItem,
  CatalogItemType,
  RegisterExpertTemplate,
  RegisterSolutionTemplate,
} from "./types";

/** 编辑请求体——对齐后端 UpdateExpertTemplateRequest | UpdateSolutionTemplateRequest。
 * 部分更新：调用方只填要改的字段，未出现的字段不参与 PATCH。 */
export type UpdateExpertTemplateChanges = {
  display_name?: string;
  persona?: string | null;
  recommended_config?: Record<string, unknown>;
  default_model_json?: Record<string, unknown>;
  default_binding_json?: Record<string, unknown>;
  prompt_pack_json?: Record<string, unknown>;
  category_code?: string;
  role_name?: string;
};

export type UpdateSolutionTemplateChanges = {
  display_name?: string;
  expert_template_ids?: string[];
  expert_bindings?: { template_id: string; sequence_no: number; enabled: boolean }[];
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
};

export type UpdateCatalogChanges =
  UpdateExpertTemplateChanges | UpdateSolutionTemplateChanges;

const BASE = "/api/operation/catalog";

export interface CatalogApi {
  list: (cursor?: string, catalog_type?: CatalogItemType) => Promise<ListResult<CatalogItem>>;
  get: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  registerExpert: (input: RegisterExpertTemplate) => Promise<CatalogItem | null>;
  registerSolution: (input: RegisterSolutionTemplate) => Promise<CatalogItem | null>;
  updateEntry: (
    catalog_type: CatalogItemType,
    template_id: string,
    changes: Record<string, unknown>,
  ) => Promise<CatalogItem | null>;
  publish: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  unpublish: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  setVisibility: (
    catalog_type: CatalogItemType,
    template_id: string,
    visible_scope: Record<string, unknown>,
  ) => Promise<CatalogItem | null>;
  save: (
    catalog_type: CatalogItemType,
    template_id: string,
    changes: UpdateCatalogChanges,
  ) => Promise<CatalogItem | null>;
}

export function useCatalogApi(): CatalogApi {
  const { token } = useSession();
  const client = useMemo(
    () => createOperationApiClient({ getToken: () => token }),
    [token],
  );

  const list = useCallback(
    (cursor?: string, catalog_type?: CatalogItemType): Promise<ListResult<CatalogItem>> => {
      const query: Record<string, string | undefined> = {};
      if (cursor) query.cursor = cursor;
      if (catalog_type) query.catalog_type = catalog_type;
      return client.listGet<CatalogItem>(BASE, {
        query: Object.keys(query).length ? query : undefined,
      });
    },
    [client],
  );

  const get = useCallback(
    (catalog_type: CatalogItemType, template_id: string): Promise<CatalogItem | null> =>
      client.get<CatalogItem>(`${BASE}/${catalog_type}/${template_id}`),
    [client],
  );

  const registerExpert = useCallback(
    (input: RegisterExpertTemplate): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/expert-templates`, { body: input }),
    [client],
  );

  const registerSolution = useCallback(
    (input: RegisterSolutionTemplate): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/solution-templates`, { body: input }),
    [client],
  );

  const updateEntry = useCallback(
    (
      catalog_type: CatalogItemType,
      template_id: string,
      changes: Record<string, unknown>,
    ): Promise<CatalogItem | null> =>
      client.patch<CatalogItem>(`${BASE}/${catalog_type}/${template_id}`, { body: changes }),
    [client],
  );

  const publish = useCallback(
    (catalog_type: CatalogItemType, template_id: string): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/${catalog_type}/${template_id}/publish`, {}),
    [client],
  );

  const unpublish = useCallback(
    (catalog_type: CatalogItemType, template_id: string): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/${catalog_type}/${template_id}/unpublish`, {}),
    [client],
  );

  const setVisibility = useCallback(
    (
      catalog_type: CatalogItemType,
      template_id: string,
      visible_scope: Record<string, unknown>,
    ): Promise<CatalogItem | null> =>
      client.put<CatalogItem>(`${BASE}/${catalog_type}/${template_id}/visibility`, {
        body: { visible_scope },
      }),
    [client],
  );

  const save = useCallback(
    (
      catalog_type: CatalogItemType,
      template_id: string,
      changes: UpdateCatalogChanges,
    ): Promise<CatalogItem | null> =>
      client.patch<CatalogItem>(`${BASE}/${catalog_type}/${template_id}`, { body: changes }),
    [client],
  );

  return useMemo<CatalogApi>(
    () => ({
      list,
      get,
      registerExpert,
      registerSolution,
      updateEntry,
      publish,
      unpublish,
      setVisibility,
      save,
    }),
    [list, get, registerExpert, registerSolution, updateEntry, publish, unpublish, setVisibility, save],
  );
}
