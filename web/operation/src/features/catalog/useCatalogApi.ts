/**
 * 目录治理 API hook（F03）。
 *
 * 路径已对齐后端 routes_catalog.py（prefix /api/operation/catalog）：
 *   GET ""                                          → 列表
 *   GET /{catalog_type}/{template_id}               → 详情
 *   POST /expert-templates                          → 注册专家模板
 *   POST /solution-templates                        → 注册行业方案
 *   POST /{catalog_type}/{template_id}/publish      → 发布
 *   POST /{catalog_type}/{template_id}/unpublish    → 下架
 *   PUT  /{catalog_type}/{template_id}/visibility   → 改可见范围
 */
import { useState, useCallback, useMemo } from "react";
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

const BASE = "/api/operation/catalog";

export interface CatalogApi {
  list: (cursor?: string) => Promise<ListResult<CatalogItem>>;
  get: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  registerExpert: (input: RegisterExpertTemplate) => Promise<CatalogItem | null>;
  registerSolution: (input: RegisterSolutionTemplate) => Promise<CatalogItem | null>;
  publish: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  unpublish: (catalog_type: CatalogItemType, template_id: string) => Promise<CatalogItem | null>;
  setVisibility: (catalog_type: CatalogItemType, template_id: string, visible_scope: Record<string, unknown>) => Promise<CatalogItem | null>;
}

export function useCatalogApi(): CatalogApi {
  const { token } = useSession();
  const client = useMemo(
    () => createOperationApiClient({ getToken: () => token }),
    [token],
  );

  const list = useCallback(
    (cursor?: string): Promise<ListResult<CatalogItem>> =>
      client.listGet<CatalogItem>(BASE, {
        query: cursor ? { cursor } : undefined,
      }),
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
    (catalog_type: CatalogItemType, template_id: string, visible_scope: Record<string, unknown>): Promise<CatalogItem | null> =>
      client.put<CatalogItem>(`${BASE}/${catalog_type}/${template_id}/visibility`, { body: { visible_scope } }),
    [client],
  );

  return useMemo<CatalogApi>(
    () => ({ list, get, registerExpert, registerSolution, publish, unpublish, setVisibility }),
    [list, get, registerExpert, registerSolution, publish, unpublish, setVisibility],
  );
}
