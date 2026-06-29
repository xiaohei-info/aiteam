/** S01 账号管理 — API hook（只调本端 /api/operation/admin/*）。 */
import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";
import type { EnterpriseAccount, EnterpriseAccountDetail, EnterpriseStats, EnterpriseActionBody } from "./types.js";

export interface AccountsApi {
  list: (params?: { keyword?: string; status?: string; page?: number; page_size?: number }) => Promise<EnterpriseAccount[]>;
  getDetail: (orgId: string) => Promise<EnterpriseAccountDetail | null>;
  exportAll: () => Promise<{ export_url: string; total: number }>;
  doAction: (orgId: string, body: EnterpriseActionBody) => Promise<unknown>;
  getStats: () => Promise<EnterpriseStats | null>;
}

function createApi(client: ApiClient): AccountsApi {
  return {
    async list(params = {}) {
      const sp = new URLSearchParams();
      if (params.keyword) sp.set("keyword", params.keyword);
      if (params.status) sp.set("status", params.status);
      if (params.page) sp.set("page", String(params.page));
      if (params.page_size) sp.set("page_size", String(params.page_size));
      const qs = sp.toString();
      const r = await client.listGet<EnterpriseAccount>(`/api/operation/admin/enterprises${qs ? "?" + qs : ""}`);
      return r.items ?? [];
    },
    getDetail(orgId) {
      return client.get<EnterpriseAccountDetail>(`/api/operation/admin/enterprises/${orgId}`);
    },
    exportAll() {
      return client.get<{ export_url: string; total: number }>("/api/operation/admin/enterprises/export/all") ?? Promise.resolve({ export_url: "", total: 0 });
    },
    doAction(orgId, body) {
      return client.post(`/api/operation/admin/enterprises/${orgId}/actions`, { body });
    },
    getStats() {
      return client.get<EnterpriseStats>("/api/operation/admin/stats");
    },
  };
}

export function useAccountsApi(): AccountsApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token, onUnauthorized });
    return createApi(client);
  }, [token, onUnauthorized]);
}
