/** 平台 MCP 与本企业启用状态（Manager `/api/manager/mcp-market`，设计 §11.3）。 */
export interface McpMarketServer {
  server_id: string;
  ref: string;
  display_name: string;
  summary: string;
  url: string;
  tools: string[];
  requires_credentials: boolean;
  /** 平台当前修订号；已下架或平台不可达时为空。 */
  platform_revision: number | null;
  published: boolean;
  enabled: boolean;
  enabled_revision: number | null;
  update_available: boolean;
}

export interface McpMarket {
  platform_available: boolean;
  servers: McpMarketServer[];
}
