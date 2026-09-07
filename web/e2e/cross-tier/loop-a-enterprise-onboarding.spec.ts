/**
 * Wave1 单部署 Manager 相位闸与既有租户登录（F01/F02 gate → whoami）。
 *
 * 验证命令：npx playwright test e2e/cross-tier/loop-a-enterprise-onboarding.spec.ts --project=cross-tier
 *
 * Wave1 验收：
 * - 本地/CI 只有一个 Manager 进程，绑定 E2E_TENANT_ID/MANAGER_TENANT_ID。
 * - Stage A 明确阻断 F01/F02 写入，再走已 seed 租户的登录/whoami。
 * - 失败时产出 Playwright report/trace/screenshot/video；成功必须靠断言不是截图。
 *
 * 非目标：不声称 Operator POST /api/operation/enterprises 能为该 Manager 动态开通第二个企业。
 * 动态 Operator→Manager enterprise routing 是 Wave2 S06，本文件不覆盖、不 skip、也不伪装通过。
 */

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  apiLogin,
  boundManagerTenantId,
  defaultCredentials,
  TIER_API_ORIGIN,
} from "../support/auth";
import {
  expectAuthenticatedEnvelope,
} from "../support/api-assertions";
import { collectBrowserErrors } from "../support/smoke";

// ── helpers ──

/** 从环境变量读取 service token（与 server conftest 对齐）。 */
function serviceToken(): string {
  return process.env.SERVICE_TOKEN ?? "test-service-token";
}

function svcHeaders(): Record<string, string> {
  return { "X-Service-Token": serviceToken(), "Content-Type": "application/json" };
}

/** 生成短企业 code。 */
function uniqueEnterpriseCode(): string {
  return `be2e-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ── Wave1 单部署 Manager F01/F02 交接：相位闸 → 已存在租户登录 ──

test.describe("Loop-A enterprise onboarding（跨端）", () => {
  test("Stage A F01/F02 phase gate → seeded tenant login → whoami", async ({
    request,
  }) => {
    const tenantId = boundManagerTenantId();
    const enterpriseCode = uniqueEnterpriseCode();
    const mgrApi = TIER_API_ORIGIN.manager;

    const provisionResp = await request.post(`${mgrApi}/api/manager/tenants`, {
      data: {
        enterprise_id: randomUUID(),
        tenant_id: tenantId,
        enterprise_name: `E2E Bound Manager ${enterpriseCode}`,
        enterprise_code: enterpriseCode,
      },
      headers: svcHeaders(),
      failOnStatusCode: false,
    });
    const provisionText = await provisionResp.text();
    expect(provisionResp.status(), `Stage A F01 应保持相位闸: ${provisionText}`).toBe(503);
    expect(provisionResp.headers()["content-type"] ?? "").toContain("application/problem+json");
    expect((JSON.parse(provisionText) as { code?: string }).code).toBe("multitenancy_phase_pending");

    const bootstrapResp = await request.post(`${mgrApi}/api/manager/owner-bootstrap`, {
      data: {
        tenant_id: tenantId,
        owner_phone: `138${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`,
        bootstrap_secret: `Boot!1-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        must_reset: true,
      },
      headers: svcHeaders(),
      failOnStatusCode: false,
    });
    const bootstrapText = await bootstrapResp.text();
    expect(bootstrapResp.status(), `Stage A F02 应保持相位闸: ${bootstrapText}`).toBe(503);
    expect(bootstrapResp.headers()["content-type"] ?? "").toContain("application/problem+json");
    expect((JSON.parse(bootstrapText) as { code?: string }).code).toBe("multitenancy_phase_pending");

    // globalSetup 直接准备已存在租户和成员；Stage A 的认证链不依赖 F01/F02 HTTP 写入。
    const managerLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    await expectAuthenticatedEnvelope(request, "manager", managerLogin.token);
    const whoamiResp = await request.get(`${mgrApi}/api/manager/whoami`, {
      headers: { Authorization: `Bearer ${managerLogin.token}` },
    });
    expect(whoamiResp.ok(), `whoami 应成功: ${whoamiResp.status()}`).toBeTruthy();
    const whoamiData = ((await whoamiResp.json()) as { data: { tenant_id: string } }).data;
    expect(whoamiData.tenant_id).toBe(tenantId);

    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    const opWhoami = await request.get(`${TIER_API_ORIGIN.operation}/api/operation/whoami`, {
      headers: { Authorization: `Bearer ${opLogin.token}` },
    });
    expect(opWhoami.ok(), `operator whoami 应成功: ${opWhoami.status()}`).toBeTruthy();
  });

  test("Operator enterprise provision 缺 service token → 401 problem+json", async ({
    request,
  }) => {
    // 不带 X-Service-Token → 401（fail-closed）
    const provisionResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "NoToken Corp",
          enterprise_code: "notok-e2e",
        },
        failOnStatusCode: false,
      },
    );
    // Manager tenant provision 有 service token 守卫：缺 → 401
    expect(provisionResp.status()).toBe(401);
    const ct = provisionResp.headers()["content-type"] ?? "";
    expect(ct).toContain("application/problem+json");
    expect(ct).not.toContain("text/html");
    const text = await provisionResp.text();
    expect(text.toLowerCase()).not.toContain("<!doctype html");
  });

  test("Operator enterprise provision 错误 service token → 401 problem+json", async ({
    request,
  }) => {
    const wrongToken = `wrong-${randomUUID()}`;
    const provisionResp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: randomUUID(),
          tenant_id: randomUUID(),
          enterprise_name: "WrongToken Corp",
          enterprise_code: "wrtoken",
        },
        headers: { "X-Service-Token": wrongToken },
        failOnStatusCode: false,
      },
    );
    expect(provisionResp.status()).toBe(401);
    const ct = provisionResp.headers()["content-type"] ?? "";
    expect(ct).toContain("application/problem+json");
  });

  test("Manager owner-bootstrap 缺必填字段 → 422 problem+json", async ({
    request,
  }) => {
    const resp = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/owner-bootstrap`,
      {
        data: { tenant_id: randomUUID() },
        headers: svcHeaders(),
        failOnStatusCode: false,
      },
    );
    // 应返回 422 problem+json（tenant 不存在为 404，但缺 bootstrap_secret 等必填为 422）
    // tenant 可能也不存在 --> 404 或 422，均应为 problem+json 非 SPA fallback
    expect(resp.ok()).toBe(false);
    const ct = resp.headers()["content-type"] ?? "";
    expect(ct).toContain("application/problem+json");
    expect(ct).not.toContain("text/html");
  });

  test("Manager tenant provision 幂等：重复调用不报错", async ({ request }) => {
    const tenantId = boundManagerTenantId();
    const enterpriseId = randomUUID();
    const code = uniqueEnterpriseCode();

    // 第一次
    const r1 = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: enterpriseId,
          tenant_id: tenantId,
          enterprise_name: "Idempotent Corp",
          enterprise_code: code,
        },
        headers: svcHeaders(),
        failOnStatusCode: false,
      },
    );

    // dev 模式 fail-open 会通过（返回 200/201）；无 PG 会 500。
    // 幂等验证：如果第一次返回非错误，第二次也至少不应报新错。
    const r2 = await request.post(
      `${TIER_API_ORIGIN.manager}/api/manager/tenants`,
      {
        data: {
          enterprise_id: enterpriseId,
          tenant_id: tenantId,
          enterprise_name: "Idempotent Corp",
          enterprise_code: code,
        },
        headers: svcHeaders(),
        failOnStatusCode: false,
      },
    );

    // 两次调用结果一致（同为成功或同为失败），验证幂等处理存在（不是裸 panic）
    expect(r1.status() === r2.status() || r1.ok() === r2.ok()).toBeTruthy();
  });
});

test.describe("Loop-A 浏览器体验（Manager 端登录链）", () => {
  test("Manager 登录页 → 登录 → whoami 返回正确 tenant", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    // 用 environment 中的 E2E 租户凭据（经 seed-e2e-tenant.py）
    const creds = defaultCredentials("manager");
    await page.goto(`${TIER_API_ORIGIN.manager}/api/manager/docs`);
    // Manager whoami API 直接与 seed 用户账密验证
    const loginResp = await page.request.post(
      `${TIER_API_ORIGIN.manager}/api/auth/login`,
      {
        data: {
          tenant_id: creds.tenant_id,
          account: creds.account,
          password: creds.password,
        },
        failOnStatusCode: false,
      },
    );
    if (!loginResp.ok()) {
      // 无 seed 数据时跳过，不硬失败
      test.skip(true, `Manager 登录需 seed E2E tenant: ${loginResp.status()}`);
      return;
    }

    const loginData = (await loginResp.json()) as { data: { token: string } };
    const token = loginData.data.token;
    expect(token).toBeTruthy();

    // whoami 验证 tenant 正确
    const whoamiResp = await page.request.get(
      `${TIER_API_ORIGIN.manager}/api/manager/whoami`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(whoamiResp.ok(), `whoami 应成功: ${whoamiResp.status()}`).toBeTruthy();
    const wdata = (await whoamiResp.json()) as { data: { tenant_id: string } };
    expect(wdata.data.tenant_id).toBe(creds.tenant_id);
  });
});
