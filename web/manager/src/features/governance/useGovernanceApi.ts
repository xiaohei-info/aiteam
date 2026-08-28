/**
 * 企业治理 API hook（W-M.5）。
 *
 * 只调本端 /api/manager/usage/*、/audits、/quota-policies/*。
 * D24：配额为软治理（评估只产建议/告警，不阻断 run）。D13：只消费脱敏聚合摘要。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  AuditSummary,
  CreateQuotaInput,
  EnforcementAction,
  QuotaPolicy,
  UsageRollup,
} from "./types";

export interface GovernanceApi {
  listUsageRollups: () => Promise<UsageRollup[]>;
  listAudits: () => Promise<AuditSummary[]>;
  listEmployees?: () => Promise<Array<{ employee_id: string; display_name: string }>>;
  listMembers?: () => Promise<Array<{ id: string; display_name: string }>>;
  listQuotas: () => Promise<QuotaPolicy[]>;
  createQuota: (input: CreateQuotaInput) => Promise<QuotaPolicy | null>;
  deleteQuota: (policyId: string) => Promise<void>;
  evaluateQuota: (
    policyId: string,
    windowStart: string,
    windowEnd: string,
  ) => Promise<EnforcementAction | null>;
}

export function useGovernanceApi(): GovernanceApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<GovernanceApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listUsageRollups() {
        return (await client.listGet<UsageRollup>("/api/manager/usage/rollup/list")).items;
      },
      async listAudits() {
        return (await client.listGet<AuditSummary>("/api/manager/audits")).items;
      },
      async listEmployees() {
        return (await client.listGet<{ employee_id: string; display_name: string }>("/api/manager/employees")).items;
      },
      async listMembers() {
        return (await client.listGet<{ id: string; display_name: string }>("/api/manager/members")).items;
      },
      async listQuotas() {
        return (await client.listGet<QuotaPolicy>("/api/manager/quota-policies")).items;
      },
      createQuota(input) {
        return client.post<QuotaPolicy>("/api/manager/quota-policies", { body: input });
      },
      async deleteQuota(policyId) {
        await client.del(`/api/manager/quota-policies/${policyId}`);
      },
      evaluateQuota(policyId, windowStart, windowEnd) {
        return client.post<EnforcementAction>(
          `/api/manager/quota-policies/${policyId}/evaluate`,
          { query: { window_start: windowStart, window_end: windowEnd } },
        );
      },
    };
  }, [token, onUnauthorized]);
}
