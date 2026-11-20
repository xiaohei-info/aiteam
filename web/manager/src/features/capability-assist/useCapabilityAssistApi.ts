import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { CapabilityAssistInput, CapabilityAssistResult } from "./types";

export function useCapabilityAssistApi() {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      /** 一次有界查找（最多约 90 秒）；只返回候选，不安装。 */
      find(input: CapabilityAssistInput) {
        return client.post<CapabilityAssistResult>("/api/manager/capability-assist", { body: input });
      },
    };
  }, [token, onUnauthorized]);
}

export type CapabilityAssistApi = ReturnType<typeof useCapabilityAssistApi>;
