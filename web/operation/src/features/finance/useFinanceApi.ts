/** S04 财务管理 — API hook。 */
import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";
import type { FinanceOverview, FinanceReport } from "./types.js";

export interface FinanceApi {
  getOverview: (period?: string) => Promise<FinanceOverview | null>;
  getReports: (period?: string) => Promise<FinanceReport | null>;
}

function createApi(client: ApiClient): FinanceApi {
  return {
    getOverview(period = "month") {
      return client.get<FinanceOverview>(`/api/operation/admin/finance/overview?period=${period}`);
    },
    getReports(period = "month") {
      return client.get<FinanceReport>(`/api/operation/admin/finance/reports?period=${period}`);
    },
  };
}

export function useFinanceApi(): FinanceApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token, onUnauthorized });
    return createApi(client);
  }, [token, onUnauthorized]);
}
