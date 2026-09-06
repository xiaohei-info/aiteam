import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { MemoryAnalytics, MemoryItem, MemoryCreate, MemoryResult, MemoryUpdate, MemoryWriteAcknowledgement } from "./types";

export interface MemoryApi {
  list: (params: { employee_id: string; keyword?: string }) => Promise<MemoryItem[]>;
  /** Safe one-item list projection; optional keeps lightweight test fakes compatible. */
  getAnalytics?: () => Promise<MemoryAnalytics | null>;
  create: (body: MemoryCreate) => Promise<MemoryWriteAcknowledgement | null>;
  update: (id: string, body: MemoryUpdate, employee_id: string) => Promise<MemoryResult | null>;
  delete: (id: string, employee_id: string) => Promise<void>;
}

export function useMemoryApi(): MemoryApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<MemoryApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list(params) {
        const sp = new URLSearchParams();
        sp.set("employee_id", params.employee_id);
        if (params.keyword) sp.set("keyword", params.keyword);
        const qs = sp.toString();
        const r = await client.listGet<MemoryItem>(`/api/manager/memories${qs ? "?" + qs : ""}`);
        return r.items ?? [];
      },
      async getAnalytics() {
        return (await client.listGet<MemoryAnalytics>("/api/manager/memories/analytics")).items[0] ?? null;
      },
      create(body) { return client.post<MemoryWriteAcknowledgement>("/api/manager/memories", { body }); },
      update(memory_id, body, employee_id) {
        return client.patch<MemoryResult>(`/api/manager/memories/${memory_id}?employee_id=${encodeURIComponent(employee_id)}`, { body });
      },
      async delete(memory_id, employee_id) {
        await client.del(`/api/manager/memories/${memory_id}?employee_id=${encodeURIComponent(employee_id)}`);
      },
    };
  }, [token, onUnauthorized]);
}
