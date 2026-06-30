/**
 * api-client 基类（08 §12.2）。各端在此基类上构造本端 client，**只调本端 `/api/<tier>/*`**（同 origin）。
 *
 * 对齐 02 北向契约：
 * - envelope：成功响应自动 unwrap `{data}` / `{data,page}`（§10.3.4）。
 * - 错误：非 2xx 统一解码 application/problem+json → ApiError（§11.2）。
 * - 分页：listGet 返回 {items,page}，page.next_cursor / has_more（§10.3.7）。
 * - 幂等：写方法支持 `idempotencyKey` → `Idempotency-Key` header（§10.3 入参规范）。
 * - 版本：v1 首版路径不加 /v1 前缀（§10 版本策略）；不在 client 拼版本。
 *
 * 不重定义契约：所有响应类型来自 ../contracts（server 契约镜像）。
 */

import type {
  Envelope,
  ListEnvelope,
  Page,
  Problem,
} from "../contracts/envelope.js";
import { ApiError } from "./errors.js";

/** 跨系统访问不能由浏览器直调（08 §12.2）：tier 仅限本端三选一。 */
export type Tier = "operation" | "manager" | "agent";

export type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

export interface ApiClientConfig {
  /** 本端服务前缀对应的 tier；client 只允许访问 `/api/<tier>/*` 与 `/api/auth/*`。 */
  tier: Tier;
  /** 同 origin 部署留空；测试或显式指定时给 origin（不含末尾斜杠）。 */
  baseUrl?: string;
  /** 取当前 access token（注入 Authorization: Bearer）。 */
  getToken?: TokenProvider;
  /** 注入用的 fetch（默认全局 fetch，便于测试 mock）。 */
  fetch?: typeof fetch;
  /** 收到 401 时的回调（如触发重新登录），不在 client 内做跳转。 */
  onUnauthorized?: (problem: Problem | undefined) => void;
}

export interface RequestOptions {
  /** query 参数；undefined/null 值自动跳过。 */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body（写方法）。 */
  body?: unknown;
  /** 幂等键 → Idempotency-Key header（02 §10.3）。 */
  idempotencyKey?: string;
  /** 透传额外 header（不覆盖内部托管的 Authorization / Content-Type）。 */
  headers?: Record<string, string>;
  /** 取消信号。 */
  signal?: AbortSignal;
}

export interface ListResult<T> {
  items: T[];
  page: Page;
  meta?: Record<string, unknown> | null;
}

const ALLOWED_PREFIXES: Record<Tier, string> = {
  operation: "/api/operation",
  manager: "/api/manager",
  agent: "/api/agent",
};

/** 校验路径只落在本端前缀或 /api/auth（02 §10.1 各端只调本端 API）。 */
function assertOwnTierPath(tier: Tier, path: string): void {
  if (path.startsWith(`${ALLOWED_PREFIXES[tier]}/`) || path === ALLOWED_PREFIXES[tier]) {
    return;
  }
  if (path.startsWith("/api/auth/") || path === "/api/auth") {
    return;
  }
  throw new ApiError(
    `path '${path}' 越权：${tier} 端只能访问 ${ALLOWED_PREFIXES[tier]}/* 或 /api/auth/*`,
    0,
    "cross_tier_call_forbidden",
  );
}

function buildQuery(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class ApiClient {
  protected readonly tier: Tier;
  protected readonly baseUrl: string;
  private readonly getToken?: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: (problem: Problem | undefined) => void;

  constructor(config: ApiClientConfig) {
    this.tier = config.tier;
    this.baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "");
    if (config.getToken) this.getToken = config.getToken;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    if (config.onUnauthorized) this.onUnauthorized = config.onUnauthorized;
  }

  /** GET 单对象，自动 unwrap envelope.data。data 为 null 时返回 null。 */
  async get<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const env = await this.request<Envelope<T>>("GET", path, options);
    return env.data;
  }

  /** GET 列表，返回 {items,page,meta}（cursor 分页）。 */
  async listGet<T>(path: string, options: RequestOptions = {}): Promise<ListResult<T>> {
    const env = await this.request<ListEnvelope<T>>("GET", path, options);
    return { items: env.data, page: env.page, meta: env.meta ?? null };
  }

  async post<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const env = await this.request<Envelope<T>>("POST", path, options);
    return env.data;
  }

  async put<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const env = await this.request<Envelope<T>>("PUT", path, options);
    return env.data;
  }

  async patch<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const env = await this.request<Envelope<T>>("PATCH", path, options);
    return env.data;
  }

  async del<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const env = await this.request<Envelope<T>>("DELETE", path, options);
    return env.data;
  }

  /** 底层请求：拼 URL、注入 header、发请求、按状态码归一为 envelope 或抛 ApiError。 */
  protected async request<TEnvelope>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<TEnvelope> {
    assertOwnTierPath(this.tier, path);

    const url = `${this.baseUrl}${path}${buildQuery(options.query)}`;
    const headers = await this.buildHeaders(options);

    let response: Response;
    try {
      const init: RequestInit = { method, headers };
      if (options.body instanceof FormData) {
        init.body = options.body;
      } else if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }
      if (options.signal) init.signal = options.signal;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw ApiError.network(err instanceof Error ? err.message : "network error");
    }

    return this.decode<TEnvelope>(response);
  }

  private async buildHeaders(options: RequestOptions): Promise<Headers> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

    const token = this.getToken ? await this.getToken() : null;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }

  private async decode<TEnvelope>(response: Response): Promise<TEnvelope> {
    if (response.status === 204) {
      // 空成功：归一为 Envelope{data:null}；ListEnvelope 调用方不会走 204。
      return { data: null } as TEnvelope;
    }

    const text = await response.text();
    const parsed = text ? safeJsonParse(text) : null;

    if (response.ok) {
      if (parsed === null || typeof parsed !== "object") {
        throw ApiError.malformed(response.status, "成功响应不是合法 JSON envelope");
      }
      return parsed as TEnvelope;
    }

    // 非 2xx：期望 application/problem+json
    if (parsed && typeof parsed === "object" && "code" in parsed && "status" in parsed) {
      const problem = parsed as Problem;
      if (response.status === 401) this.onUnauthorized?.(problem);
      throw ApiError.fromProblem(problem);
    }

    if (response.status === 401) this.onUnauthorized?.(undefined);
    throw ApiError.malformed(
      response.status,
      `HTTP ${response.status}：错误响应不是 problem+json`,
    );
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
