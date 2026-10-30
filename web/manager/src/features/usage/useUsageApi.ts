import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { UsageGroupBy, UsageStatistics, UsageWindow } from "./types";

export interface UsageApi {
  getStatistics: (groupBy: UsageGroupBy, window: UsageWindow | null) => Promise<UsageStatistics | null>;
}

export function useUsageApi(): UsageApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<UsageApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      getStatistics(groupBy, window) {
        const query = new URLSearchParams({ group_by: groupBy, ...(window ?? {}) });
        return client.get<UsageStatistics>(`/api/manager/usage/statistics?${query.toString()}`);
      },
    };
  }, [token, onUnauthorized]);
}
