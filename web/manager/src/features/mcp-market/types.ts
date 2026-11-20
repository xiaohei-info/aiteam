/** 平台 MCP 与本企业启用状态（Manager `/api/manager/mcp-market`，设计 §11.3）。 */
export interface McpMarketServer {
  server_id: string;
  ref: string;
  display_name: string;
  summary: string;
  url: string;
  tools: string[];
  /** none 无需；oauth 成员在服务方网页登录；bearer 成员填写访问令牌。凭据由成员本机保存，企业端不保存（MCP鉴权 2026-11-18）。 */
  auth: "none" | "oauth" | "bearer";
  auth_header: string;
  oauth_scopes: string;
  timeout_ms: number;
  /** oauth：preregistered 平台已登记应用；dynamic 成员登录时自动注册。 */
  oauth_client: "preregistered" | "dynamic";
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
