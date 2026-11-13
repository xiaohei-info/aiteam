/** S01 账号管理 — API hook（只调本端 /api/operation/admin/*）。 */
import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";
import type {
  EnterpriseAccount,
  EnterpriseAccountDetail,
  EnterpriseActionBody,
  EnterpriseStats,
  EnterpriseModelAccess,
  EnrichedAudit,
  LifecycleCommand,
  OwnerResetResult,
  QuotaSnapshot,
} from "./types.js";

export interface QuotaChangePayload {
  employee_limit?: number | null;
  storage_limit_mb?: number | null;
  api_rate_limit?: number | null;
  token_quota_limit?: number | null;
}

export interface LifecycleStatusResponse {
  org_id: string;
  operation_status: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  banned_at: string | null;
  banned_reason: string | null;
  closed_at: string | null;
}

export interface EnrichedAuditList {
  total: number;
  items: EnrichedAudit[];
  next_cursor: number | null;
}

export interface AccountsApi {
  list: (params?: {
    keyword?: string;
    status?: string;
    page?: number;
    page_size?: number;
  }) => Promise<EnterpriseAccount[]>;
  getDetail: (orgId: string) => Promise<EnterpriseAccountDetail | null>;
  exportAll: () => Promise<{ export_url: string; total: number }>;
  doAction: (orgId: string, body: EnterpriseActionBody) => Promise<unknown>;
  getStats: () => Promise<EnterpriseStats | null>;
  // issue #413 additions
  getLifecycleStatus: (orgId: string) => Promise<LifecycleStatusResponse | null>;
  changeLifecycle: (
    orgId: string,
    body: LifecycleCommand,
  ) => Promise<{ org_id: string; action: string; operation_status: string; detail: string } | null>;
  /** 重置企业管理员密码；同一个 idempotencyKey 的重试返回同一份结果（24 小时内）。 */
  resetOwnerBootstrap: (orgId: string, idempotencyKey: string) => Promise<OwnerResetResult>;
  /** 删除已注销企业（仅 system_admin）；confirmName 必须与企业名称一致。 */
  deleteEnterprise: (orgId: string, confirmName: string) => Promise<unknown>;
  restoreEnterprise: (orgId: string) => Promise<unknown>;
  purgeEnterprise: (orgId: string) => Promise<unknown>;
  getQuota: (orgId: string) => Promise<QuotaSnapshot | null>;
  setQuota: (orgId: string, body: QuotaChangePayload) => Promise<QuotaSnapshot | null>;
  /** Optional for older injected test clients; production hook always provides both. */
  getModelAccess?: (orgId: string) => Promise<EnterpriseModelAccess | null>;
  setModelAccess?: (orgId: string, allowedModelRefs: EnterpriseModelAccess["allowed_model_refs"]) => Promise<EnterpriseModelAccess | null>;
  getProfile?: (orgId: string) => Promise<{ enterprise_id: string; industry: string | null; tags: string[] } | null>;
  setProfile?: (orgId: string, body: { industry: string | null; tags: string[] }) => Promise<unknown>;
  listAudits: (params: {
    enterpriseId?: string;
    severity?: string;
    action?: string;
    cursor?: number;
    limit?: number;
  }) => Promise<EnrichedAuditList>;
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
      const r = await client.listGet<EnterpriseAccount>(
        `/api/operation/admin/enterprises${qs ? "?" + qs : ""}`,
      );
      return r.items ?? [];
    },
    getDetail(orgId) {
      return client.get<EnterpriseAccountDetail>(
        `/api/operation/admin/enterprises/${orgId}`,
      );
    },
    async exportAll() {
      return (
        (await client.get<{ export_url: string; total: number }>(
          "/api/operation/admin/enterprises/export/all",
        )) ?? { export_url: "", total: 0 }
      );
    },
    doAction(orgId, body) {
      return client.post(`/api/operation/admin/enterprises/${orgId}/actions`, {
        body,
      });
    },
    getStats() {
      return client.get<EnterpriseStats>("/api/operation/admin/stats");
    },
    // ---- issue #413 ----
    getLifecycleStatus(orgId) {
      return client.get<LifecycleStatusResponse>(
        `/api/operation/admin/enterprises/${orgId}/lifecycle`,
      );
    },
    changeLifecycle(orgId, body) {
      return client.post<{
        org_id: string;
        action: string;
        operation_status: string;
        detail: string;
      }>(`/api/operation/admin/enterprises/${orgId}/lifecycle`, { body });
    },
    async resetOwnerBootstrap(orgId, idempotencyKey) {
      const data = await client.post<OwnerResetResult>(
        `/api/operation/enterprises/${orgId}/owner-bootstrap/reset`,
        { idempotencyKey },
      );
      if (!data) throw new Error("服务端返回了空结果");
      return data;
    },
    deleteEnterprise(orgId, confirmName) {
      return client.post(`/api/operation/admin/enterprises/${orgId}/delete`, { body: { confirm_name: confirmName } });
    },
    restoreEnterprise(orgId) {
      return client.post(`/api/operation/admin/enterprises/${orgId}/restore`);
    },
    purgeEnterprise(orgId) {
      return client.post(`/api/operation/admin/enterprises/${orgId}/purge`);
    },
    getQuota(orgId) {
      return client.get<QuotaSnapshot>(`/api/operation/admin/enterprises/${orgId}/quota`);
    },
    setQuota(orgId, body) {
      return client.patch<QuotaSnapshot>(
        `/api/operation/admin/enterprises/${orgId}/quota`,
        { body },
      );
    },
    getModelAccess(orgId) {
      return client.get<EnterpriseModelAccess>(
        `/api/operation/admin/enterprises/${orgId}/model-access`,
      );
    },
    setModelAccess(orgId, allowedModelRefs) {
      return client.patch<EnterpriseModelAccess>(
        `/api/operation/admin/enterprises/${orgId}/model-access`,
        { body: { allowed_model_refs: allowedModelRefs } },
      );
    },
    getProfile(orgId) {
      return client.get<{ enterprise_id: string; industry: string | null; tags: string[] }>(
        `/api/operation/enterprises/${orgId}/profile`,
      );
    },
    setProfile(orgId, body) {
      return client.put(`/api/operation/enterprises/${orgId}/profile`, { body });
    },
    async listAudits(params) {
      const sp = new URLSearchParams();
      if (params.enterpriseId) sp.set("enterprise_id", params.enterpriseId);
      if (params.severity) sp.set("severity", params.severity);
      if (params.action) sp.set("action", params.action);
      if (typeof params.cursor === "number") sp.set("cursor", String(params.cursor));
      if (typeof params.limit === "number") sp.set("limit", String(params.limit));
      const qs = sp.toString();
      return (
        (await client.get<EnrichedAuditList>(
          `/api/operation/admin/audit-events${qs ? "?" + qs : ""}`,
        )) ?? { total: 0, items: [], next_cursor: null }
      );
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
