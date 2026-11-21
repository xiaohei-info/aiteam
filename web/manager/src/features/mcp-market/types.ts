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

export type McpAuth = McpMarketServer["auth"];

/** 企业自建 MCP（设计 2026-11-20 §4.4）。应用密钥只写不读。 */
export interface EnterpriseMcpServer {
  /** `ent-` 前缀。 */
  server_id: string;
  /** 成员本机安装标识；创建后不能修改。 */
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
  oauth_client_secret_set: boolean;
  /** 每次修改加 1，成员本机据此提示更新。 */
  revision: number;
}

/** 新建 / 修改企业 MCP。oauth_client_secret：不传保持不变，空字符串清除，其它替换。 */
export interface EnterpriseMcpServerInput {
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
  oauth_client_secret?: string;
}

/** 检查地址：判断鉴权方式、读取工具（不保存任何内容；test_token 只用于这一次）。 */
export interface McpProbeInput {
  url: string;
  timeout_ms?: number;
  auth_header?: string;
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

export interface McpMarket {
  platform_available: boolean;
  servers: McpMarketServer[];
  /** 企业自建 MCP；旧版企业端不返回。 */
  enterprise?: EnterpriseMcpServer[];
  /** 展示前缀（设计「技能MCP命名空间出处与更新提示」§4.1）：平台为 taiyim，企业为企业名称（未设置时企业代码）。 */
  platform_namespace?: string;
  enterprise_namespace?: string;
}
