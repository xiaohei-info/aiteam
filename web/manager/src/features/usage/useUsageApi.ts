import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { UsageGroupBy, UsageStatistics, UsageWindow } from "./types";

export interface UsageApi {
  /** signal 用于切换时间范围或离开页面时取消未返回的请求。 */
  getStatistics: (groupBy: UsageGroupBy, window: UsageWindow | null, signal?: AbortSignal) => Promise<UsageStatistics | null>;
}

export function useUsageApi(): UsageApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<UsageApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      getStatistics(groupBy, window, signal) {
        const query = new URLSearchParams({ group_by: groupBy, ...(window ?? {}) });
        return client.get<UsageStatistics>(`/api/manager/usage/statistics?${query.toString()}`, { signal });
      },
    };
  }, [token, onUnauthorized]);
}
