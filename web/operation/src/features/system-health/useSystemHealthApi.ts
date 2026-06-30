import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";
import type { SystemHealth } from "./types.js";

export interface SystemHealthApi {
  getHealth: () => Promise<SystemHealth | null>;
}

function createApi(client: ApiClient): SystemHealthApi {
  return {
    getHealth() { return client.get<SystemHealth>("/api/operation/admin/health"); },
  };
}

export function useSystemHealthApi(): SystemHealthApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token, onUnauthorized });
    return createApi(client);
  }, [token, onUnauthorized]);
}
