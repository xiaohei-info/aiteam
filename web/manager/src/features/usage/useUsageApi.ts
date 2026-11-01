import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { SegmentOutcomeStatistics, UsageGroupBy, UsageStatistics, UsageWindow } from "./types";

export interface UsageApi {
  /** signal 用于切换时间范围或离开页面时取消未返回的请求。 */
  getStatistics: (groupBy: UsageGroupBy, window: UsageWindow | null, signal?: AbortSignal) => Promise<UsageStatistics | null>;
  /** 全企业按员工的段落解决情况；与用量同一时间窗。 */
  getOutcomes: (window: UsageWindow | null, signal?: AbortSignal) => Promise<SegmentOutcomeStatistics | null>;
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
      getOutcomes(window, signal) {
        const query = window ? `?${new URLSearchParams({ ...window }).toString()}` : "";
        return client.get<SegmentOutcomeStatistics>(`/api/manager/usage/outcomes${query}`, { signal });
      },
    };
  }, [token, onUnauthorized]);
}
