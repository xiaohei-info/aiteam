import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { McpProbeInput, McpProbeResult, PlatformMcpServer, PlatformMcpServerInput } from "./types";

const BASE = "/api/operation/mcp-market/servers";

export type McpMarketApi = ReturnType<typeof useMcpMarketApi>;

export function useMcpMarketApi() {
  const { token } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token });
    return {
      async list(): Promise<PlatformMcpServer[]> {
        const items = (await client.listGet<PlatformMcpServer>(BASE))?.items;
        return Array.isArray(items) ? items : [];
      },
      create(body: PlatformMcpServerInput) {
        return client.post<PlatformMcpServer>(BASE, { body });
      },
      update(serverId: string, body: PlatformMcpServerInput) {
        return client.put<PlatformMcpServer>(`${BASE}/${encodeURIComponent(serverId)}`, { body });
      },
      publish(serverId: string) {
        return client.post<PlatformMcpServer>(`${BASE}/${encodeURIComponent(serverId)}/publish`);
      },
      unpublish(serverId: string) {
        return client.post<PlatformMcpServer>(`${BASE}/${encodeURIComponent(serverId)}/unpublish`);
      },
      /** 连接一次读取鉴权方式与工具；不保存任何内容。 */
      probe(body: McpProbeInput) {
        return client.post<McpProbeResult>("/api/operation/mcp-market/probe", { body });
      },
    };
  }, [token]);
}
