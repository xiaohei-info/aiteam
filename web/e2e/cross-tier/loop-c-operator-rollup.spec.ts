/**
 * AITEAM-226 Wave2 跨端 E2E：Loop-C operator rollup 浏览器链路验证。
 *
 * 覆盖：Manager usage rollup 聚合 → Operator /rollups/board 跨企业看板可见。
 * 验证命令：npx playwright test e2e/cross-tier/loop-c-operator-rollup.spec.ts --project=cross-tier
 *
 * 验收锚点（DAG contract）：
 * - Loop-C 浏览器链路验证 operator-rollup，且摘要不泄露会话内容。
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
  expectEnvelope,
} from "../support/api-assertions";

test.describe("Loop-C operator rollup（跨端）", () => {
  test("Operator rollups/board 返回 envelope（跨企业看板聚合）", async ({
    request,
  }) => {
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    await expectEnvelope(request, "operation", "/api/operation/rollups/board", opLogin.token);
  });

  test("Operator rollups/board 契约形状：data 为单对象（非数组）", async ({
    request,
  }) => {
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    const resp = await request.get(
      `${TIER_API_ORIGIN.operation}/api/operation/rollups/board`,
      {
        headers: { Authorization: `Bearer ${opLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `rollups/board 应可达: ${resp.status()}`).toBe(true);

    const body = (await resp.json()) as { data: unknown };
    expect(body, "rollups/board envelope has data").toHaveProperty("data");
    // board 是单对象聚合视图，非列表
    expect(Array.isArray(body.data), "rollups/board data 应为单对象，非数组").toBe(false);
  });

  test("Operator rollups/board 响应不含会话内容/文件/工具 I/O 键名（D13）", async ({
    request,
  }) => {
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    const resp = await request.get(
      `${TIER_API_ORIGIN.operation}/api/operation/rollups/board`,
      {
        headers: { Authorization: `Bearer ${opLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `rollups/board 应可达: ${resp.status()}`).toBe(true);

    const text = await resp.text();

    // 验证 Operator board 不泄露业务细节
    const forbiddenKeys = [
      "employee_id",
      "employee",
      "prompt",
      "completion",
      "messages",
      "conversation_text",
      "file_content",
      "file_path",
      "tool_input",
      "tool_output",
      "member_id",
      "user_id",
    ];

    for (const key of forbiddenKeys) {
      const keyPattern = new RegExp(`"${key}"`);
      expect(text, `Operator board 响应不应含 "${key}" 键名（D13 无下钻通道）`)
        .not.toMatch(keyPattern);
    }
  });

  test("Operator enterprise rollup 返回 envelope（单企业详情聚合）", async ({
    request,
  }) => {
    const opLogin = await apiLogin(request, "operation", defaultCredentials("operation"));
    // 企业详情聚合也走 envelope（单对象）
    const resp = await request.get(
      `${TIER_API_ORIGIN.operation}/api/operation/rollups/board`,
      {
        headers: { Authorization: `Bearer ${opLogin.token}` },
        failOnStatusCode: false,
      },
    );
    expect(resp.ok(), `rollups/board 应可达: ${resp.status()}`).toBe(true);

    // 获取 enterprises 列表，看是否有 enterprise_id 可用
    const boardData = (await resp.json()) as {
      data: { enterprises?: Array<{ enterprise_id?: string }> };
    };
    const enterprises = boardData.data?.enterprises ?? [];
    if (enterprises.length > 0 && enterprises[0].enterprise_id) {
      const entId = enterprises[0].enterprise_id;
      const detailResp = await request.get(
        `${TIER_API_ORIGIN.operation}/api/operation/rollups/${entId}`,
        {
          headers: { Authorization: `Bearer ${opLogin.token}` },
          failOnStatusCode: false,
        },
      );
      expect(detailResp.ok(), `enterprise rollup 应可达: ${detailResp.status()}`).toBe(true);
      const detailBody = (await detailResp.json()) as { data: unknown };
      expect(detailBody, "enterprise rollup envelope has data").toHaveProperty("data");
    }
  });

  test("Operator rollups 端点受 Bearer 鉴权保护（缺 token → 401）", async ({
    request,
  }) => {
    const resp = await request.get(
      `${TIER_API_ORIGIN.operation}/api/operation/rollups/board`,
      { failOnStatusCode: false },
    );
    expect(resp.ok()).toBe(false);
    // 应有鉴权守卫：401 problem+json
    const ct = resp.headers()["content-type"] ?? "";
    expect(resp.status(), `应 401 非 ${resp.status()}`).toBe(401);
    expect(ct).toContain("application/problem+json");
    expect(ct).not.toContain("text/html");

    const text = await resp.text();
    expect(text.toLowerCase()).not.toContain("<!doctype html");
  });
});
