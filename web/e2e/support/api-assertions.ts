/**
 * AITEAM-224 可复用 API 契约断言（最终执行 DAG §5.1 BE2E 基座 / §11 错误模型）。
 *
 * 单一事实源：三端北向 API 契约断言收敛于此，各端 spec 复用，避免每端各写一遍
 * problem+json / envelope / 鉴权 守卫断言导致口径漂移。
 *
 * 对齐 02 北向契约 + 03 §9.4 认证模型：
 * - 成功响应是 JSON envelope（{data} / {data,page}）。
 * - 错误响应是 application/problem+json（含 code/status），**不是 text/html SPA fallback**。
 * - operation/manager 受保护端点缺 token → 401 problem+json（require_claims 守卫）。
 * - agent 是用户端本地优先单用户（03 §9.4C）：whoami 读本地缓存会话、mainline 路由无
 *   Bearer 鉴权依赖（本地无入站、无多租户 RLS）；故 agent 端"受保护"语义=本地登录链贯通，
 *   不适用 operation/manager 的 401 守卫断言。
 * - 跨端路径由前端 client 层拦截（此处只验后端契约，不重复前端 client 单测）。
 *
 * 非目标（DAG §10）：不重复 service 层业务断言、不测 LLM 文本质量、不绕过 Team Panel 直连 Runtime。
 */

import { expect, type APIRequestContext } from "@playwright/test";
import { TIER_API_ORIGIN, type Tier } from "./auth";

/** 受保护端点探测路径（各端真实存在的 whoami，对齐 server app.py）。 */
const WHOAMI_PATH: Record<Tier, string> = {
  operation: "/api/operation/whoami",
  manager: "/api/manager/whoami",
  agent: "/api/agent/whoami",
};

/**
 * 哪些 tier 的受保护端点用 Bearer token 鉴权（require_claims 守卫，缺 token → 401）。
 * agent 是本地优先单用户端，whoami 读缓存会话、mainline 无 Bearer 鉴权——不在此列。
 */
const BEARER_GUARDED_TIERS: ReadonlySet<Tier> = new Set(["operation", "manager"]);

/** 断言某路径返回 application/problem+json 错误，且不是 text/html SPA fallback。 */
export async function expectProblemJson(
  request: APIRequestContext,
  tier: Tier,
  path: string,
  options: { expectedStatus?: number; expectAuthHeader?: boolean } = {},
): Promise<void> {
  const origin = TIER_API_ORIGIN[tier];
  const response = await request.get(`${origin}${path}`, { failOnStatusCode: false });
  const contentType = response.headers()["content-type"] ?? "";

  expect(
    response.ok() === false,
    `${tier} ${path} should be an error response, got ${response.status()}`,
  ).toBeTruthy();
  if (options.expectedStatus !== undefined) {
    expect(response.status(), `${tier} ${path} status`).toBe(options.expectedStatus);
  }

  // 错误响应必须是 problem+json，绝不是 text/html SPA fallback（验收第 5 条）。
  expect(contentType, `${tier} ${path} content-type`).toContain("application/problem+json");
  expect(contentType, `${tier} ${path} must not be text/html`).not.toContain("text/html");

  const text = await response.text();
  expect(text.toLowerCase(), `${tier} ${path} must not be SPA html`).not.toContain("<!doctype html");

  // problem+json 必含 code + status（02 §11.2 统一错误模型）。
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body, `${tier} ${path} problem body has code`).toHaveProperty("code");
  expect(body, `${tier} ${path} problem body has status`).toHaveProperty("status");
}

/**
 * 断言未知 /api 路径返回 404 problem+json，不是 SPA fallback。
 * 这是"三端 API contract 均断言错误响应不是 text/html SPA fallback"的统一出口（适用三端）。
 */
export async function expectUnknownRouteProblemJson(
  request: APIRequestContext,
  tier: Tier,
): Promise<void> {
  await expectProblemJson(request, tier, `/api/${tier}/__missing_route__`, {
    expectedStatus: 404,
  });
}

/**
 * 断言受保护端点（whoami）缺 token 时返回 401 problem+json（鉴权守卫不静默放行）。
 * 仅 operation/manager 适用（Bearer token + require_claims 守卫，03 §9.6）。
 * agent 端本地优先单用户，whoami 读缓存会话、无 Bearer 401 守卫——不适用本断言。
 */
export async function expectProtectedEndpointRequiresAuth(
  request: APIRequestContext,
  tier: Tier,
): Promise<void> {
  if (!BEARER_GUARDED_TIERS.has(tier)) {
    // agent：本地优先单用户端无 Bearer 401 守卫，跳过（非目标：不绕过 Team Panel）。
    return;
  }
  // 新建一个无 token 的请求上下文，确保不带 storageState 的 Bearer。
  await expectProblemJson(request, tier, WHOAMI_PATH[tier], { expectedStatus: 401 });
}

/**
 * 断言带 token 访问受保护端点（whoami）返回 200 envelope（鉴权链贯通）。
 * operation/manager：Bearer token 鉴权。agent：本地缓存会话（登录后 whoami 可读）。
 * token 由调用方传入（经 auth.apiLogin 取得，或从 storageState 注入）。
 */
export async function expectAuthenticatedEnvelope(
  request: APIRequestContext,
  tier: Tier,
  token: string,
): Promise<void> {
  const origin = TIER_API_ORIGIN[tier];
  const response = await request.get(`${origin}${WHOAMI_PATH[tier]}`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  expect(response.ok(), `${tier} whoami with token failed: ${response.status()}`).toBeTruthy();
  expect(response.headers()["content-type"] ?? "", `${tier} whoami content-type`).toContain(
    "application/json",
  );
  const body = (await response.json()) as { data: unknown };
  expect(body, `${tier} whoami envelope has data`).toHaveProperty("data");
}

/**
 * 断言列表端点返回 envelope 列表形状 {data:[], page:{...}}（02 §10.3.7 分页）。
 * 用真实业务只读列表端点（GET），只验契约形状，不验业务数据（非目标）。
 */
export async function expectListEnvelope(
  request: APIRequestContext,
  tier: Tier,
  path: string,
  token: string,
): Promise<void> {
  const origin = TIER_API_ORIGIN[tier];
  const response = await request.get(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  expect(response.ok(), `${tier} list ${path} failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { data: unknown[]; page?: unknown };
  expect(Array.isArray(body.data), `${tier} list ${path} data is array`).toBeTruthy();
  expect(body, `${tier} list ${path} has page`).toHaveProperty("page");
}

/**
 * 断言端点返回成功 envelope {data: ...}（02 §10.3.4）。
 * 用于单对象 / 无分页列表端点（如 operation catalog=Envelope[list]、rollups/board=Envelope[object]）。
 * 只验契约形状（data 存在 + content-type json），不验业务数据（非目标）。
 */
export async function expectEnvelope(
  request: APIRequestContext,
  tier: Tier,
  path: string,
  token: string,
  options: { dataIsArray?: boolean } = {},
): Promise<void> {
  const origin = TIER_API_ORIGIN[tier];
  const response = await request.get(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  expect(response.ok(), `${tier} ${path} failed: ${response.status()}`).toBeTruthy();
  expect(response.headers()["content-type"] ?? "").toContain("application/json");
  const body = (await response.json()) as { data: unknown };
  expect(body, `${tier} ${path} envelope has data`).toHaveProperty("data");
  if (options.dataIsArray) {
    expect(Array.isArray(body.data), `${tier} ${path} data is array`).toBeTruthy();
  }
}
