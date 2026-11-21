import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { EnterpriseMcpServer, EnterpriseMcpServerInput, McpMarket, McpProbeInput, McpProbeResult } from "./types";

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
      /** 停用平台 MCP，或删除企业自建 MCP。 */
      disable(serverId: string) {
        return client.del(`${BASE}/${encodeURIComponent(serverId)}`);
      },
      probe(input: McpProbeInput) {
        return client.post<McpProbeResult>(`${BASE}/probe`, { body: input });
      },
      createCustom(input: EnterpriseMcpServerInput) {
        return client.post<EnterpriseMcpServer>(`${BASE}/custom`, { body: input });
      },
      updateCustom(serverId: string, input: EnterpriseMcpServerInput) {
        return client.put<EnterpriseMcpServer>(`${BASE}/custom/${encodeURIComponent(serverId)}`, { body: input });
      },
    };
  }, [token, onUnauthorized]);
}
