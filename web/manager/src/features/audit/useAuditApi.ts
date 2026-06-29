import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { AuditEvent } from "./types";

export interface AuditApi { list: (params?: { event_type?: string; page?: number }) => Promise<AuditEvent[]>; }

export function useAuditApi(): AuditApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<AuditApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list(params = {}) {
        const sp = new URLSearchParams();
        if (params.event_type) sp.set("event_type", params.event_type);
        if (params.page) sp.set("page", String(params.page));
        const r = await client.listGet<AuditEvent>(`/api/manager/audit-events${sp.toString() ? "?" + sp.toString() : ""}`);
        return r.items ?? [];
      },
    };
  }, [token, onUnauthorized]);
}
