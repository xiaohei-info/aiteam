import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { SolutionStat } from "./types";

export interface SolutionsApi {
  getStats: () => Promise<SolutionStat[]>;
}

export function useSolutionsApi(): SolutionsApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<SolutionsApi>(() => {
    const client = createOperationApiClient({ getToken: () => token, onUnauthorized });
    return {
      async getStats() {
        const r = await client.listGet<SolutionStat>("/api/operation/admin/solutions/stats");
        return r.items;
      },
    };
  }, [token, onUnauthorized]);
}
