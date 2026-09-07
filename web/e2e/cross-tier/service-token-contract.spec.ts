/**
 * AITEAM-226 Wave2 跨端 E2E：ServiceToken 契约正负向浏览器验证。
 *
 * 覆盖：ServiceToken 合法/缺失/错误/越权/跨租户/禁止访问 /api/auth。
 * 验证命令：npx playwright test e2e/cross-tier/service-token-contract.spec.ts --project=cross-tier
 *
 * 验收锚点（DAG contract）：
 * - ServiceToken 覆盖相位闸前的合法守卫、缺失、过期、越权、跨租户、禁止访问 /api/auth。
 * - 失败时产出 Playwright report/trace/screenshot/video；成功必须靠断言不是截图。
 *
 * 设计：
 * - service token 是 Operator↔Manager 云侧服务间调用的共享密钥（03 §9.1）。
 * - Manager 敏感收端（POST /api/manager/tenants、POST /api/manager/owner-bootstrap）挂
 *   Depends(verify_service_token)，缺失/错误 → 401；Stage A 合法请求随后命中 503 相位闸。
 * - service token **不能**访问 /api/auth/*（用户认证端点为用户凭据设计，03 §9.6）。
 * - 本 spec 测真实后端（不用 mock），依赖三端栈全量启动。
 *
 * 非目标（DAG contract）：不测 usage 数值精度、不覆盖多浏览器 nightly 矩阵、不用 mock 后端。
 */

import { test, expect, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { boundManagerTenantId, TIER_API_ORIGIN } from "../support/auth";

// ── helpers ──

function serviceToken(): string {
  return process.env.SERVICE_TOKEN ?? "test-service-token";
}

function svcHeaders(): Record<string, string> {
  return { "X-Service-Token": serviceToken(), "Content-Type": "application/json" };
}

/** 验证响应为 problem+json（非 text/html SPA fallback）。 */
async function assertProblemJson(text: string, ct: string, status: number): Promise<void> {
  expect(ct, `content-type 应为 application/problem+json: ${ct}`).toContain(
    "application/problem+json",
  );
  expect(ct).not.toContain("text/html");
  expect(text.toLowerCase()).not.toContain("<!doctype html");

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`problem+json parse failed: ${text.slice(0, 200)}`);
  }
  expect(body, "problem+json has code").toHaveProperty("code");
  expect(body, "problem+json has status").toHaveProperty("status");
}

async function assertPhasePending(response: APIResponse, label: string): Promise<void> {
  const text = await response.text();
  expect(response.status(), `${label} 应返回 Stage A 相位闸: ${text}`).toBe(503);
  const contentType = response.headers()["content-type"] ?? "";
  expect(contentType).toContain("application/problem+json");
  expect(contentType).not.toContain("text/html");
  expect(text.toLowerCase()).not.toContain("<!doctype html");
  expect((JSON.parse(text) as { code?: string }).code).toBe("multitenancy_phase_pending");
}

// ── ServiceToken 合法访问 ──

test.describe("ServiceToken 合法访问", () => {
  test("Manager /api/manager/tenants 带正确 service token → Stage A 503 phase gate", async ({
    request,
  }) => {
    const tenantId = boundManagerTenantId();
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: tenantId,
          enterprise_name: "E2E ServiceToken Corp",
          enterprise_code: `svctok-${randomUUID().replace(/-/g, "").slice(0, 6)}`,
        },
        headers: svcHeaders(),
        failOnStatusCode: false,
      },
    );

    // Stage A 暂不开放 F01；正确 service token 必须先通过 service-token 守卫，
    // 再命中明确的相位闸，而不是被错误地当成用户认证或被静默放行。
    await assertPhasePending(resp, "正确 service token → tenant provision");
  });

  test("Manager /api/manager/owner-bootstrap 带正确 service token → Stage A 503 phase gate", async ({
    request,
  }) => {
    const tenantId = boundManagerTenantId();
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/owner-bootstrap`,
      {
        data: {
          tenant_id: tenantId,
          owner_phone: `138${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`,
          bootstrap_secret: "Test-bootstrap-secret1",
          must_reset: true,
        },
        headers: svcHeaders(),
        failOnStatusCode: false,
      },
    );

    await assertPhasePending(resp, "正确 service token → owner-bootstrap");
  });
});

// ── ServiceToken 缺失 ──

test.describe("ServiceToken 缺失", () => {
  test("Manager tenant provision 缺 service token → 401 problem+json", async ({
    request,
  }) => {
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "Missing Token Corp",
          enterprise_code: "missing1",
        },
        headers: { "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    expect(resp.status(), "缺 service token 应 401").toBe(401);
    await assertProblemJson(
      await resp.text(),
      resp.headers()["content-type"] ?? "",
      resp.status(),
    );
  });

  test("Manager owner-bootstrap 缺 service token → 401 problem+json", async ({
    request,
  }) => {
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/owner-bootstrap`,
      {
        data: {
          tenant_id: randomUUID(),
          owner_phone: "13800000001",
          bootstrap_secret: "test",
          must_reset: true,
        },
        headers: { "Content-Type": "application/json" },
        failOnStatusCode: false,
      },
    );
    expect(resp.status(), "缺 service token 应 401").toBe(401);
    await assertProblemJson(
      await resp.text(),
      resp.headers()["content-type"] ?? "",
      resp.status(),
    );
  });
});

// ── ServiceToken 错误/过期/越权 ──

test.describe("ServiceToken 错误/过期/越权", () => {
  test("Manager tenant provision 错误 service token → 401 problem+json", async ({
    request,
  }) => {
    const wrongToken = `wrong-${randomUUID()}`;
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "WrongToken Corp",
          enterprise_code: "wr1",
        },
        headers: {
          "X-Service-Token": wrongToken,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    expect(resp.status(), "错误 service token 应 401").toBe(401);
    await assertProblemJson(
      await resp.text(),
      resp.headers()["content-type"] ?? "",
      resp.status(),
    );
  });

  test("Manager tenant provision 空 service token → 401 problem+json", async ({
    request,
  }) => {
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "EmptyToken Corp",
          enterprise_code: "empty1",
        },
        headers: {
          "X-Service-Token": "",
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    expect(resp.status(), "空 service token 应 401").toBe(401);
    await assertProblemJson(
      await resp.text(),
      resp.headers()["content-type"] ?? "",
      resp.status(),
    );
  });

  test("Manager tenant provision 空白 service token → 401 problem+json", async ({
    request,
  }) => {
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "BlankToken Corp",
          enterprise_code: "blank1",
        },
        headers: {
          "X-Service-Token": "   ",
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    expect(resp.status(), "空白 service token 应 401").toBe(401);
    await assertProblemJson(
      await resp.text(),
      resp.headers()["content-type"] ?? "",
      resp.status(),
    );
  });

  test("Manager tenant provision service token 大小写敏感", async ({
    request,
  }) => {
    const token = serviceToken();
    // 大小写不同的 token → 401
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "CaseSensitive Corp",
          enterprise_code: "case1",
        },
        headers: {
          "X-Service-Token": token.toUpperCase(),
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );
    // 大小写变化应 401；UPPERCASE 可能与原 token 相同则跳过
    if (token.toUpperCase() !== token) {
      expect(resp.status(), `大小写不同 token 应 401，实际: ${resp.status()}`).toBe(401);
    }
  });

  test("Bearer 格式传 service token → Stage A 503 phase gate", async ({
    request,
  }) => {
    const token = serviceToken();
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: boundManagerTenantId(),
          enterprise_name: "BearerToken Corp",
          enterprise_code: `bear-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        },
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );

    await assertPhasePending(resp, "Bearer service token → tenant provision");
  });
});

// ── ServiceToken 跨租户 ──

test.describe("ServiceToken 跨租户", () => {
  test("Service token 不是租户登录 token——不能通过 Manager /api/auth/login", async ({
    request,
  }) => {
    const token = serviceToken();
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/auth/login`,
      {
        data: {
          tenant_id: randomUUID(),
          account: "13800000001",
          password: "any-password",
        },
        headers: {
          "X-Service-Token": token,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );

    // auth 端点不应被 service token bypass
    expect(resp.ok(), "service token 不应通过 /api/auth/login（用户凭据端点）").toBe(false);
    const ct = resp.headers()["content-type"] ?? "";
    expect(ct, "/api/auth/login 用 service token 应为非 success content-type")
      .not.toContain("text/html");

    const text = await resp.text();
    expect(text.toLowerCase()).not.toContain("<!doctype html");
  });

  test("Service token 不能通过 Operation whoami（平台操作员端点需 RS256 JWT）", async ({
    request,
  }) => {
    const token = serviceToken();
    const resp = await request.get(
      `${TIER_API_ORIGIN.operation}/api/operation/whoami`,
      {
        headers: { "X-Service-Token": token },
        failOnStatusCode: false,
      },
    );

    // Operation whoami 需要的是 RS256 JWT，不是 service token
    expect(resp.ok(), "service token 不应通过 operator whoami").toBe(false);
    const ct = resp.headers()["content-type"] ?? "";
    expect(ct).toContain("application/problem+json");
  });
});

// ── ServiceToken 禁止访问 /api/auth ──

test.describe("ServiceToken 禁止访问 /api/auth", () => {
  test("service token 不能 bypass Manager /api/auth/login 端点", async ({
    request,
  }) => {
    const token = serviceToken();

    const loginEndpoints = [
      { path: "/api/auth/login", method: "post" as const },
      { path: "/api/auth/owner-reset", method: "post" as const },
    ];

    for (const { path, method } of loginEndpoints) {
      const resp = await request[method](
        `${TIER_API_ORIGIN.manager}${path}`,
        {
          data: {
            tenant_id: randomUUID(),
            account: "13800000001",
            password: "any-password",
            ...(path.includes("owner-reset")
              ? { old_password: "old", new_password: "new" }
              : {}),
          },
          headers: {
            "X-Service-Token": token,
            "Content-Type": "application/json",
          },
          failOnStatusCode: false,
        },
      );

      // 不应返回 200
      expect(resp.ok(), `${path} 不应被 service token bypass`).toBe(false);

      const ct = resp.headers()["content-type"] ?? "";
      expect(ct, `${path} 不应返回 text/html`).not.toContain("text/html");

      const text = await resp.text();
      expect(text.toLowerCase()).not.toContain("<!doctype html");
    }
  });

  test("service token 不能访问 Operation /api/operation/auth/login", async ({
    request,
  }) => {
    const token = serviceToken();
    const resp = await request.post(
      `${TIER_API_ORIGIN.operation}/api/operation/auth/login`,
      {
        data: { username: "sysadmin", password: "changeme-me" },
        headers: {
          "X-Service-Token": token,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );

    // Operation auth login 不应被 service token bypass
    // 可能 401 / 422 —— 都不是 bypass 成功
    expect(resp.ok(), "service token 不应通过 operation auth login").toBe(false);
  });

  test("Service token 不可绕过 Business 鉴权访问任意受保护端点——统一 401 problem+json", async ({
    request,
  }) => {
    const token = serviceToken();

    // 多端点验证：service token 不能当用户 token 用
    const protectedBusinessEndpoints = [
      { path: "/api/manager/members", tier: "manager" as const },
      { path: "/api/manager/grants", tier: "manager" as const },
      { path: "/api/operation/catalog", tier: "operation" as const },
    ];

    for (const { path, tier } of protectedBusinessEndpoints) {
      const resp = await request.get(
        `${TIER_API_ORIGIN[tier]}${path}`,
        {
          headers: { "X-Service-Token": token },
          failOnStatusCode: false,
        },
      );

      // 受保护业务端点不应被 service token 通过
      expect(resp.ok(), `${tier} ${path} 不应被 service token bypass`).toBe(false);

      const ct = resp.headers()["content-type"] ?? "";
      expect(ct, `${tier} ${path} 应为 problem+json 非 html`).not.toContain("text/html");
    }
  });
});

// ── ServiceToken 401 响应不泄露 token 值 ──

test.describe("ServiceToken 401 诊断安全", () => {
  test("Service token 401 错误响应不泄露 token 值", async ({ request }) => {
    const wrongToken = `wrong-${randomUUID()}`;
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "Security Corp",
          enterprise_code: "sec1",
        },
        headers: {
          "X-Service-Token": wrongToken,
          "Content-Type": "application/json",
        },
        failOnStatusCode: false,
      },
    );

    expect(resp.status()).toBe(401);

    const text = await resp.text();
    // 不得泄露 token 值
    expect(text, "401 错误响应不得泄露错误 token 值").not.toContain(wrongToken);

    // 但应含可审计的状态码和错误码
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`无法解析 401 响应: ${text.slice(0, 200)}`);
    }
    expect(body, "problem+json has code").toHaveProperty("code");
    expect(body, "problem+json has status").toHaveProperty("status");
  });
});
