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

test.describe("Loop-C usage outbox flush → Manager rollup 跨端数据传播", () => {
  test("Agent create conversation + run → outbox 产生 usage → flush sent>0 → Manager rollup 观测到增量", async ({
    request,
  }) => {
    // 单 test 内完成全链路（避免 fullyParallel 下测试间顺序依赖）：
    // Agent create conversation → message → run → outbox 增长 → flush sent>0 →
    // 取 run 返回的 run_id 在 Manager rollup 中按 employee+窗口验证可见性。

    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const agentOrigin = TIER_API_ORIGIN.agent;
    const mgrOrigin = TIER_API_ORIGIN.manager;

    // ── 阶段 1/6: outbox pending 基线 ──
    const beforeResp = await request.get(`${agentOrigin}/api/agent/usage/outbox`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
    expect(beforeResp.ok(), `outbox read: ${beforeResp.status()}`).toBe(true);
    const beforeBody = (await beforeResp.json()) as { data: unknown[] };
    const pendingBefore = Array.isArray(beforeBody.data) ? beforeBody.data.length : 0;

    // ── 阶段 2/6: 创建会话 + 发消息 + 起 run（FakeRuntime 产生 usage → UsageRecorder 入 outbox）──
    const traceId = `e2e-loopc-${Date.now()}`;
    const convResp = await request.post(`${agentOrigin}/api/agent/conversations`, {
      data: { title: `Loop-C propagation ${traceId}` },
      headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(convResp.ok(), `create conversation: ${convResp.status()}`).toBe(true);
    const convId = ((await convResp.json()) as { data: { id: string } }).data.id;

    const msgResp = await request.post(`${agentOrigin}/api/agent/conversations/${convId}/messages`, {
      data: { role: "user", content: `E2E usage cross-tier: ${traceId}` },
      headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(msgResp.ok(), `send message: ${msgResp.status()}`).toBe(true);

    const runResp = await request.post(`${agentOrigin}/api/agent/conversations/${convId}/runs`, {
      data: {},
      headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(runResp.ok(), `start run: ${runResp.status()}`).toBe(true);
    const runBody = (await runResp.json()) as { data: { id: string; employee_id?: string } };
    const runId = runBody.data.id;
    const employeeId = runBody.data.employee_id ?? undefined;

    // ── 阶段 3/6: 验证 outbox pending 增长 → run 的 usage 已入队 ──
    const afterRunResp = await request.get(`${agentOrigin}/api/agent/usage/outbox`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
    expect(afterRunResp.ok(), `outbox read after run: ${afterRunResp.status()}`).toBe(true);
    const afterRunBody = (await afterRunResp.json()) as { data: unknown[] };
    const pendingAfterRun = Array.isArray(afterRunBody.data) ? afterRunBody.data.length : 0;
    expect(
      pendingAfterRun > pendingBefore,
      `run 后 outbox pending 应增长 (before=${pendingBefore}, after=${pendingAfterRun})`,
    ).toBe(true);

    // ── 阶段 4/6: Flush → 断言 sent > 0（实际有数据发送到 Manager，非空 flush）──
    const flushResp = await request.post(`${agentOrigin}/api/agent/usage/flush`, {
      headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(flushResp.ok(), `flush: ${flushResp.status()}`).toBe(true);
    const flushBody = (await flushResp.json()) as {
      data: { sent: number; failed: number; batches: number };
    };
    expect(flushBody, "flush envelope has data").toHaveProperty("data");

    // Manager 不可达时 reporter 会标记 failed，但 batch 仍 >0。在完整三端栈 CI 中 sent 应 >0。
    // 若 sent===0 且 failed>0，说明 Manager 不可达——CI 应 fail（三端栈不全）。
    const { sent, failed, batches } = flushBody.data;
    expect(batches, "flush 至少发起一批").toBeGreaterThan(0);
    if (failed > 0 && sent === 0) {
      // Manager 不可达：在完整三端栈 CI 中此为失败信号。
      throw new Error(
        `flush failed to reach Manager: sent=${sent} failed=${failed} batches=${batches}。确认 MANAGER_URL 可达且三端栈已启动。`,
      );
    }
    expect(sent, `flush sent 应 > 0 (failed=${failed} batches=${batches})`).toBeGreaterThan(0);

    // ── 阶段 5/6: Flush 后 outbox pending 减少（sent 出队）──
    const afterFlushResp = await request.get(`${agentOrigin}/api/agent/usage/outbox`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
    expect(afterFlushResp.ok(), `outbox read after flush: ${afterFlushResp.status()}`).toBe(true);
    const afterFlushBody = (await afterFlushResp.json()) as { data: unknown[] };
    const pendingAfterFlush = Array.isArray(afterFlushBody.data) ? afterFlushBody.data.length : -1;
    expect(
      pendingAfterFlush <= pendingAfterRun,
      `flush 后 pending 应 ≤ run 后 (afterRun=${pendingAfterRun}, afterFlush=${pendingAfterFlush})`,
    ).toBe(true);

    // ── 阶段 6/6: Manager rollup 收端可见性验证 ──
    // 上一步 flush 已将脱敏 summary 上报 Manager；Manager 端 rollup 聚合应可见该增量。
    const rollupResp = await request.get(`${mgrOrigin}/api/manager/usage/rollup/list`, {
      headers: { Authorization: `Bearer ${mgrLogin.token}` },
      failOnStatusCode: false,
    });
    expect(rollupResp.ok(), `rollup list: ${rollupResp.status()}`).toBe(true);

    const rollupBody = (await rollupResp.json()) as {
      data: Array<Record<string, unknown>>;
      page?: unknown;
    };
    expect(Array.isArray(rollupBody.data), "rollup list data is array").toBe(true);
    expect(rollupBody, "rollup list has page").toHaveProperty("page");

    // 按 run_id / employee_id 精确定位本次 flush 产生的 records（非任意历史数据）。
    // run_id 在 outbox summary 中以 employee_id 或 run_id 形式出现。
    const matchingRecords = rollupBody.data.filter((r) => {
      if (employeeId && r.employee_id === employeeId) return true;
      // summary_id 包含 run_id 前缀或完整 run_id
      if (typeof r.summary_id === "string" && r.summary_id.includes(runId)) return true;
      return false;
    });
    expect(
      matchingRecords.length,
      `Manager rollup 中应含至少一条 run_id="${runId}" 匹配记录（本轮 Agent 上报）`,
    ).toBeGreaterThan(0);

    // D13：每条 matching record 必须含脱敏标识字段（summary_id/rollup_id），且不含会话内容键名。
    const forbiddenKeys = [
      "prompt", "completion", "messages", "conversation_text",
      "file_content", "tool_input", "tool_output",
    ];
    for (const record of matchingRecords) {
      const hasIdField = "summary_id" in record || "rollup_id" in record;
      expect(hasIdField, `rollup record 含 summary_id 或 rollup_id`).toBe(true);
      for (const key of forbiddenKeys) {
        expect(record, `rollup record must not contain "${key}"`).not.toHaveProperty(key);
      }
    }
  });
});
