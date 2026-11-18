/** 平台 MCP 目录条目（Operator `/api/operation/mcp-market`，设计 §11.3）。 */
export interface PlatformMcpServer {
  server_id: string;
  ref: string;
  display_name: string;
  summary: string;
  url: string;
  tools: string[];
  requires_credentials: boolean;
  revision: number;
  status: "draft" | "published" | "unpublished";
}

export type PlatformMcpServerInput = Omit<PlatformMcpServer, "server_id" | "revision" | "status">;
