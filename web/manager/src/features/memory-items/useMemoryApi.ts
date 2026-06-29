import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { MemoryItem, MemoryCreate } from "./types";

export interface MemoryApi {
  list: (params?: { employee_id?: string; keyword?: string }) => Promise<MemoryItem[]>;
  create: (body: MemoryCreate) => Promise<MemoryItem | null>;
  update: (id: string, body: Partial<MemoryItem>) => Promise<unknown>;
  delete: (id: string) => Promise<unknown>;
  bulkDelete: (ids: string[]) => Promise<unknown>;
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
      create(body) { return client.post<MemoryItem>("/api/manager/memories", { body }); },
      update(memory_id, body) { return client.patch(`/api/manager/memories/${memory_id}`, { body }); },
      delete(memory_id) { return client.delete(`/api/manager/memories/${memory_id}`); },
      bulkDelete(memory_ids) { return client.post("/api/manager/memories/bulk-delete", { body: { memory_ids } }); },
    };
  }, [token, onUnauthorized]);
}
