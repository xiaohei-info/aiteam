/**
 * AgentApiClient —— 用户端本端 API 客户端（08 §12.2）。
 *
 * 基于 @aiteam/shared 的 ApiClient 基类（tier=agent），**只调本端** `/api/agent/*`
 * 与 `/api/auth/*`（同 origin）。跨端直调由基类的 `assertOwnTierPath` 拦截并抛
 * ApiError(cross_tier_call_forbidden)——这是本卡红线（D3/D15）的代码层保障。
 *
 * 不重定义契约：响应类型来自 @aiteam/shared/contracts；本文件只补 agent 端
 * 专属端点的请求/响应形状（登录入参等，shared 未镜像，属本端 API 边界）。
 */

import { ApiClient, type ApiClientConfig, type TokenProvider } from "@aiteam/shared/api-client";
import type { TokenClaims } from "@aiteam/shared/contracts";

/** 本地登录入参（对齐 server agent_service/auth/local_login.py:LoginRequest）。 */
export interface AgentLoginRequest {
  account: string;
  password: string;
  tenant_hint?: string | null;
}

/** 登录返回（对齐 server LoginResult）。token + 解出的 claims。 */
export interface AgentLoginResult {
  token: string;
  claims: TokenClaims;
}

export interface AgentClientOptions {
  /** 同 origin 部署留空；测试时显式给 origin。 */
  baseUrl?: string;
  /** 取当前 token（注入 Authorization）。 */
  getToken?: TokenProvider;
  /** 收到 401 回调（触发重新登录跳转，不在 client 内跳）。 */
  onUnauthorized?: ApiClientConfig["onUnauthorized"];
  /** 注入 fetch（测试 mock）。 */
  fetch?: typeof fetch;
}

export class AgentApiClient extends ApiClient {
  constructor(options: AgentClientOptions = {}) {
    super({
      tier: "agent",
      baseUrl: options.baseUrl,
      getToken: options.getToken,
      fetch: options.fetch,
      onUnauthorized: options.onUnauthorized,
    });
  }

  /** liveness ping（演示 envelope，对齐 server /api/agent/ping）。 */
  async ping(): Promise<{ pong: boolean } | null> {
    return this.get<{ pong: boolean }>("/api/agent/ping");
  }

  /** 本地登录（对齐 server /api/agent/login，公开端点）。 */
  async login(req: AgentLoginRequest): Promise<AgentLoginResult> {
    const result = await this.post<AgentLoginResult>("/api/agent/login", { body: req });
    if (result === null) {
      // 不应发生：登录端点约定返回 envelope.data；防御性兜底，消除「null 当结果用」。
      throw new Error("login: empty envelope");
    }
    return result;
  }

  /** 解出当前身份（对齐 server /api/agent/whoami，受保护）。 */
  async whoami(): Promise<TokenClaims | null> {
    return this.get<TokenClaims>("/api/agent/whoami");
  }
}
