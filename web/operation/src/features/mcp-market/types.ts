/** 平台 MCP 目录条目（Operator `/api/operation/mcp-market`，设计 §11.3 / MCP鉴权 2026-11-18 §3.8）。 */
export type McpAuth = "none" | "oauth" | "bearer";

export interface PlatformMcpServer {
  server_id: string;
  ref: string;
  display_name: string;
  summary: string;
  url: string;
  tools: string[];
  /** none 无需鉴权；oauth 成员在服务方网页用自己的账号登录；bearer 成员填写服务方发的访问令牌。平台不保存成员令牌。 */
  auth: McpAuth;
  /** bearer：携带令牌的请求头名；空 = Authorization: Bearer。 */
  auth_header: string;
  oauth_scopes: string;
  timeout_ms: number;
  /** oauth：服务方发的应用编号；空 = 成员登录时自动注册。 */
  oauth_client_id: string;
  /** 应用密钥是否已设置；密钥本身只写不读。 */
  oauth_client_secret_set: boolean;
  revision: number;
  /** 展示前缀：平台 MCP 一律为 taiyim。 */
  namespace?: string;
  status: "draft" | "published" | "unpublished";
}

export interface PlatformMcpServerInput {
  ref: string;
  display_name: string;
  summary: string;
  url: string;
  tools: string[];
  auth: McpAuth;
  auth_header: string;
  oauth_scopes: string;
  timeout_ms: number;
  oauth_client_id: string;
  /** 不传 = 保持不变；"" = 清除；其它 = 替换。 */
  oauth_client_secret?: string;
}

export interface McpProbeInput {
  url: string;
  timeout_ms?: number;
  auth_header?: string;
  /** 只用于这一次探测，不保存。 */
  test_token?: string;
}

export interface McpProbeResult {
  status: "ok" | "needs_oauth" | "needs_token" | "unreachable";
  auth: McpAuth;
  tools: string[];
  scopes_supported: string[];
  scope: string;
  auth_host: string;
  dynamic_registration: boolean;
  server_name: string;
  token_rejected: boolean;
  detail: string;
}
