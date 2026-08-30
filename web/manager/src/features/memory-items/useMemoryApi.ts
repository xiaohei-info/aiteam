import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { MemoryAnalytics, MemoryItem, MemoryCreate } from "./types";

export interface MemoryApi {
  list: (params?: { employee_id?: string; keyword?: string }) => Promise<MemoryItem[]>;
  /** Safe one-item list projection; optional keeps lightweight test fakes compatible. */
  getAnalytics?: () => Promise<MemoryAnalytics | null>;
  create: (body: MemoryCreate) => Promise<MemoryItem | null>;
  update: (id: string, body: Partial<MemoryItem>, employee_id?: string) => Promise<unknown>;
  delete: (id: string, employee_id?: string) => Promise<unknown>;
}

export function useMemoryApi(): MemoryApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<MemoryApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list(params = {}) {
        const sp = new URLSearchParams();
        if (params.employee_id) sp.set("employee_id", params.employee_id);
        if (params.keyword) sp.set("keyword", params.keyword);
        const qs = sp.toString();
        const r = await client.listGet<MemoryItem>(`/api/manager/memories${qs ? "?" + qs : ""}`);
        return r.items ?? [];
      },
      async getAnalytics() {
        return (await client.listGet<MemoryAnalytics>("/api/manager/memories/analytics")).items[0] ?? null;
      },
      create(body) { return client.post<MemoryItem>("/api/manager/memories", { body }); },
      update(memory_id, body, employee_id) {
        const suffix = employee_id ? `?employee_id=${encodeURIComponent(employee_id)}` : "";
        return client.patch(`/api/manager/memories/${memory_id}${suffix}`, { body });
      },
      delete(memory_id, employee_id) {
        const suffix = employee_id ? `?employee_id=${encodeURIComponent(employee_id)}` : "";
        return client.del(`/api/manager/memories/${memory_id}${suffix}`);
      },
    };
  }, [token, onUnauthorized]);
}
