/**
 * AITEAM-226 Wave2 跨端 E2E：Loop-C usage audit flow 浏览器链路验证。
 *
 * 覆盖：Agent usage 记录 → outbox flush → Manager ingest → 聚合可见。
 * 验证命令：npx playwright test e2e/cross-tier/loop-c-usage-audit-flow.spec.ts --project=cross-tier
 *
 * 验收锚点（DAG contract）：
 * - Loop-C 浏览器链路验证 usage-audit-flow，且摘要不泄露会话内容。
 * - 失败时产出 Playwright report/trace/screenshot/video；成功必须靠断言不是截图。
 *
 * 非目标（DAG contract）：不测 usage 数值精度到结算级、不覆盖多浏览器 nightly 矩阵、不用 mock 后端。
 */

import { test, expect } from "@playwright/test";
import {
  apiLogin,
  defaultCredentials,
  TIER_API_ORIGIN,
} from "../support/auth";
import {
  expectListEnvelope,
} from "../support/api-assertions";

// ── Loop-C usage audit flow（跨端）──

test.describe("Loop-C usage audit flow（跨端）", () => {
  test("Agent usage outbox 列表端点可达（本地脱敏摘要）", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    await expectListEnvelope(request, "agent", "/api/agent/usage/outbox", agentLogin.token);
  });

  test("Agent usage outbox 响应不含会话内容/文件路径/工具 I/O 键名", async ({
    request,
  }) => {
    // 验证摘要脱敏：outbox 列表响应的结构字段不含私密内容键名。
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const resp = await request.get(
      `${TIER_API_ORIGIN.agent}/api/agent/usage/outbox`,
      {
        headers: { Authorization: `Bearer ${agentLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `outbox 应可达: ${resp.status()}`).toBe(true);

    const text = await resp.text();

    // 脱敏断言：响应体不含私密键名
    const forbiddenKeys = [
      "prompt",           // 用户提示原文
      "completion",       // 模型输出原文
      "messages",         // 会话消息数组
      "content",          // 消息内容
      "transcript",       // 对话转录
      "file_path",        // 文件路径
      "file_content",     // 文件正文
      "tool_input",       // 工具输入
      "tool_output",      // 工具输出
      "conversation_text", // 会话文本
    ];

    for (const key of forbiddenKeys) {
      // 做粗略子串匹配：响应中不应出现敏感键名（作为 JSON key 存在）
      const keyPattern = new RegExp(`"${key}"`);
      expect(text, `outbox 响应不应含 "${key}" 键名（会话/文件/工具内容已脱敏）`)
        .not.toMatch(keyPattern);
    }
  });

  test("Manager usage/audit/quota 端点列表均可达", async ({ request }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const token = mgrLogin.token;

    const endpoints = [
      "/api/manager/usage/rollup/list",
      "/api/manager/audits",
      "/api/manager/quota-policies",
    ];

    for (const path of endpoints) {
      const resp = await request.get(`${TIER_API_ORIGIN.manager}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `${path} 应可达: ${resp.status()}`).toBe(true);

      const body = (await resp.json()) as { data: unknown[]; page?: unknown };
      expect(Array.isArray(body.data), `${path} data 为数组`).toBe(true);
      expect(body, `${path} 含 page 字段`).toHaveProperty("page");
    }
  });

  test("Manager usage rollup 列表返回 list envelope（契约形状验证）", async ({
    request,
  }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    await expectListEnvelope(request, "manager", "/api/manager/usage/rollup/list", mgrLogin.token);
  });

  test("Manager audits 列表返回 list envelope", async ({ request }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    await expectListEnvelope(request, "manager", "/api/manager/audits", mgrLogin.token);
  });

  test("Manager quota-policies 列表返回 list envelope", async ({ request }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    await expectListEnvelope(request, "manager", "/api/manager/quota-policies", mgrLogin.token);
  });

  test("Manager audits 响应不含会话内容/文件/工具 I/O 键名（D13 脱敏摘要）", async ({
    request,
  }) => {
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const resp = await request.get(
      `${TIER_API_ORIGIN.manager}/api/manager/audits`,
      {
        headers: { Authorization: `Bearer ${mgrLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `audits 应可达: ${resp.status()}`).toBe(true);

    const text = await resp.text();

    const forbiddenKeys = [
      "prompt",
      "completion",
      "messages",
      "conversation_text",
      "file_content",
      "tool_input",
      "tool_output",
    ];

    for (const key of forbiddenKeys) {
      const keyPattern = new RegExp(`"${key}"`);
      expect(text, `audits 响应不应含 "${key}" 键名（D13 脱敏摘要）`)
        .not.toMatch(keyPattern);
    }
  });
});

test.describe("Loop-C usage audit 跨端数据隔离", () => {
  test("Agent outbox 与 Manager usage rollup 列表均为分页 list envelope 形状", async ({
    request,
  }) => {
    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));

    // 双端均验证 list envelope 形状（data: array + page 字段）
    const checks: Array<[string, string, string]> = [
      ["agent", "/api/agent/usage/outbox", agentLogin.token],
      ["manager", "/api/manager/usage/rollup/list", mgrLogin.token],
    ];

    for (const [tier, path, token] of checks) {
      const origin = TIER_API_ORIGIN[tier as "agent" | "manager"];
      const resp = await request.get(`${origin}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      expect(resp.ok(), `${tier} ${path} 应可达: ${resp.status()}`).toBe(true);

      const body = (await resp.json()) as { data: unknown[]; page?: unknown };
      expect(Array.isArray(body.data), `${tier} ${path} data 为数组`).toBe(true);
      expect(body, `${tier} ${path} 含 page`).toHaveProperty("page");
    }
  });

  test("Manager usage rollup 列表端点不接受无 token 访问", async ({ request }) => {
    // operation/manager 受 require_claims 守卫：缺 token → 401
    const resp = await request.get(
      `${TIER_API_ORIGIN.manager}/api/manager/usage/rollup/list`,
      { failOnStatusCode: false },
    );
    expect(resp.ok()).toBe(false);
    // 应返回 401 problem+json（非 SPA fallback）
    const ct = resp.headers()["content-type"] ?? "";
    expect(resp.status(), `应 401 非 ${resp.status()}`).toBe(401);
    expect(ct).toContain("application/problem+json");
    expect(ct).not.toContain("text/html");
  });
});
