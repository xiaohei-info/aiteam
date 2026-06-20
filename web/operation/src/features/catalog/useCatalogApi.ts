/**
 * 目录治理 API hook（F03）。
 *
 * 封装 createOperationApiClient → 本端 /api/operation/catalog/* 调用。
 * 调用方只消费包装好的函数，不直接触碰 ApiClient 实例或 token。
 */
import { useState, useCallback, useMemo } from "react";
import { ApiError } from "@aiteam/shared";
import type { ListResult } from "@aiteam/shared";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  CatalogItem,
  RegisterExpertTemplate,
  RegisterSolutionTemplate,
  SetVisibilityInput,
} from "./types";

const BASE = "/api/operation/catalog";

export interface CatalogApi {
  /** 列表（cursor 分页：传 next_cursor 翻页，首次不传）。 */
  list: (cursor?: string) => Promise<ListResult<CatalogItem>>;
  /** 详情。 */
  get: (id: string) => Promise<CatalogItem | null>;
  /** 注册专家模板。 */
  registerExpert: (input: RegisterExpertTemplate) => Promise<CatalogItem | null>;
  /** 注册行业方案。 */
  registerSolution: (
    input: RegisterSolutionTemplate,
  ) => Promise<CatalogItem | null>;
  /** 发布。 */
  publish: (id: string) => Promise<CatalogItem | null>;
  /** 下架。 */
  unpublish: (id: string) => Promise<CatalogItem | null>;
  /** 设可见范围。 */
  setVisibility: (input: SetVisibilityInput) => Promise<CatalogItem | null>;
}

export function useCatalogApi(): CatalogApi {
  const { token } = useSession();
  const client = useMemo(
    () => createOperationApiClient({ getToken: () => token }),
    [token],
  );

  const list = useCallback(
    (cursor?: string): Promise<ListResult<CatalogItem>> =>
      client.listGet<CatalogItem>(`${BASE}/list`, {
        query: cursor ? { cursor } : undefined,
      }),
    [client],
  );

  const get = useCallback(
    (id: string): Promise<CatalogItem | null> =>
      client.get<CatalogItem>(`${BASE}/${id}`),
    [client],
  );

  const registerExpert = useCallback(
    (input: RegisterExpertTemplate): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/register-expert-template`, {
        body: input,
      }),
    [client],
  );

  const registerSolution = useCallback(
    (input: RegisterSolutionTemplate): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/register-solution-template`, {
        body: input,
      }),
    [client],
  );

  const publish = useCallback(
    (id: string): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/publish`, { body: { id } }),
    [client],
  );

  const unpublish = useCallback(
    (id: string): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/unpublish`, { body: { id } }),
    [client],
  );

  const setVisibility = useCallback(
    (input: SetVisibilityInput): Promise<CatalogItem | null> =>
      client.post<CatalogItem>(`${BASE}/set-visibility`, { body: input }),
    [client],
  );

  return useMemo<CatalogApi>(
    () => ({
      list,
      get,
      registerExpert,
      registerSolution,
      publish,
      unpublish,
      setVisibility,
    }),
    [list, get, registerExpert, registerSolution, publish, unpublish, setVisibility],
  );
}
