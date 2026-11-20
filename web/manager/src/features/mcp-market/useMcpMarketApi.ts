import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { McpMarket } from "./types";

const BASE = "/api/manager/mcp-market";

export function useMcpMarketApi() {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list(): Promise<McpMarket> {
        return (await client.get<McpMarket>(BASE)) ?? { platform_available: false, servers: [] };
      },
      enable(serverId: string) {
        return client.post(`${BASE}/${encodeURIComponent(serverId)}/enable`);
      },
      disable(serverId: string) {
        return client.del(`${BASE}/${encodeURIComponent(serverId)}`);
      },
    };
  }, [token, onUnauthorized]);
}
