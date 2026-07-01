/**
 * SolutionApplyRecord 追踪 API hook（AITEAM-266）。
 *
 * 只调本端 /api/manager/recruit/*（跨端由基类拦截）。租户边界完全由后端经 TenantContext 裁决（D22），
 * 前端不拼 tenant 过滤、不跨端直调。
 *
 * 数据来源（两路只读）：
 * - 已落地方案实例 GET /solutions —— 列表态锚点
 * - 某方案的方案应用历史 GET /solutions/{solution_id}/apply-records —— 审计追溯
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { SolutionApplyRecord, SolutionInstanceSummary } from "./types";

export interface SolutionApplyApi {
  listSolutionInstances: () => Promise<SolutionInstanceSummary[]>;
  listApplyRecords: (solutionId: string) => Promise<SolutionApplyRecord[]>;
}

export function useSolutionApplyApi(): SolutionApplyApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<SolutionApplyApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listSolutionInstances() {
        const r = await client.listGet<SolutionInstanceSummary>(
          "/api/manager/recruit/solutions",
        );
        return r.items ?? [];
      },
      async listApplyRecords(solutionId: string) {
        const r = await client.listGet<SolutionApplyRecord>(
          `/api/manager/recruit/solutions/${encodeURIComponent(solutionId)}/apply-records`,
        );
        return r.items ?? [];
      },
    };
  }, [token, onUnauthorized]);
}
