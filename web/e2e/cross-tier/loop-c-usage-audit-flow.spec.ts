/**
 * AITEAM-226 Wave2 跨端 E2E：Loop-C usage audit flow 浏览器链路验证。
 *
 * 覆盖：Agent usage 记录 → outbox flush → Manager ingest → 聚合可见。
 * 验证命令：
 *   E2E_PROVIDER_ENDPOINT=https://<test-relay>/v1 E2E_PROVIDER_SECRET="$E2E_TEST_SECRET" \
 *   MANAGER_CREDENTIAL_KEY="$MANAGER_CREDENTIAL_KEY" \
 *   npx playwright test e2e/cross-tier/loop-c-usage-audit-flow.spec.ts --project=cross-tier
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
  seededEmployeeId,
  TIER_API_ORIGIN,
} from "../support/auth";
import {
  expectListEnvelope,
} from "../support/api-assertions";

type UsageOutboxItem = {
  summary_id?: string;
  kind?: string;
  member_id?: string;
  tenant_id?: string;
  employee_id?: string;
  status?: string;
  attempts?: number;
  last_error?: string | null;
};

function usageOutboxItems(data: unknown): UsageOutboxItem[] {
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is UsageOutboxItem => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as UsageOutboxItem;
    return record.kind === "usage" && typeof record.summary_id === "string";
  });
}

function summaryId(item: UsageOutboxItem): string | undefined {
  return typeof item.summary_id === "string" ? item.summary_id : undefined;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, message: string): Promise<T> {
  let latest: T | undefined;
  await expect.poll(async () => {
    latest = await read();
    return ready(latest) ? 1 : 0;
  }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(1);
  if (latest === undefined) throw new Error(`${message}: no response`);
  return latest;
}

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

test.describe("Pi prompt usage outbox flush → Manager rollup 跨端数据传播", () => {
  test("Agent Conversation prompt → 捕获 outbox summary_id → flush sent>0 → Manager rollup 按 summary_id 可见", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    // 单 test 内完成全链路（避免 fullyParallel 下测试间顺序依赖）：
    // Agent Conversation prompt → outbox summary 写入/更新 → flush sent>0 →
    // 用 outbox/rollup 共享的 summary_id 在 Manager rollup 中验证可见性。

    const agentLogin = await apiLogin(request, "agent", defaultCredentials("agent"));
    const mgrLogin = await apiLogin(request, "manager", defaultCredentials("manager"));
    const agentOrigin = TIER_API_ORIGIN.agent;
    const mgrOrigin = TIER_API_ORIGIN.manager;

    // ── 阶段 1/6: 以 Agent 当前认证 caller 为 owner，准备可执行 employee + snapshot ──
    // Login response claims are only a handoff hint.  whoami is the identity actually
    // accepted by this Agent process and is the sole owner source for this flow.
    const whoamiResp = await request.get(`${agentOrigin}/api/agent/whoami`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
    expect(whoamiResp.ok(), `agent whoami: ${whoamiResp.status()}`).toBe(true);
    const whoamiBody = (await whoamiResp.json()) as {
      data?: { tenant_id?: string; user_id?: string; sub?: string };
    };
    const ownerTenantId = String(whoamiBody.data?.tenant_id ?? "");
    const ownerMemberId = String(whoamiBody.data?.user_id ?? whoamiBody.data?.sub ?? "");
    expect(ownerTenantId, "Authenticated Agent caller must identify tenant").not.toBe("");
    expect(ownerMemberId, "Authenticated Agent caller must identify member").not.toBe("");

    const readRoster = async () => {
      const response = await request.get(`${agentOrigin}/api/agent/grants/experts`, {
        headers: { Authorization: `Bearer ${agentLogin.token}` },
        failOnStatusCode: false,
      });
      expect(response.ok(), `agent roster: ${response.status()}`).toBe(true);
      return (await response.json()) as {
        data?: Array<{
          employee_id?: string;
          member_id?: string;
          version?: string | number;
          revoked?: boolean;
          status?: string;
          model_policy?: { model?: string; provider_ref?: string };
        }>;
      };
    };
    const readSnapshots = async () => {
      const response = await request.get(`${agentOrigin}/api/agent/grants/snapshots`, {
        headers: { Authorization: `Bearer ${agentLogin.token}` },
        failOnStatusCode: false,
      });
      expect(response.ok(), `agent snapshots: ${response.status()}`).toBe(true);
      return (await response.json()) as {
        data?: Array<{
          employee_id?: string;
          member_id?: string;
          version?: string | number;
          snapshot_version?: string;
          model_policy?: { model?: string; provider_ref?: string };
        }>;
      };
    };
    const configuredEmployeeId = process.env.E2E_AGENT_EMPLOYEE_ID ?? seededEmployeeId();
    let rosterBody = await readRoster();
    let snapshotsBody = await readSnapshots();
    const hasExecutableEmployee = () => {
      const candidates = rosterBody.data ?? [];
      return candidates.find((item) => {
        if (!item.employee_id || item.revoked || item.status !== "active" || (configuredEmployeeId && item.employee_id !== configuredEmployeeId)) return false;
        const policy = item.model_policy ?? {};
        if (!policy.model || !policy.provider_ref) return false;
        return (snapshotsBody.data ?? []).some((snapshot) =>
          snapshot.employee_id === item.employee_id
          && String(snapshot.version) === String(item.version)
          && snapshot.member_id === ownerMemberId
          && Boolean(snapshot.snapshot_version),
        );
      })?.employee_id;
    };
    let employeeId = hasExecutableEmployee();
    if (!employeeId) {
      // A clean Agent DB may have a roster projection without a frozen snapshot yet.
      // Sync must either succeed with a real Manager response or fail with the formal
      // 503 problem contract; do not turn an offline response into a fake success.
      const syncResp = await request.post(`${agentOrigin}/api/agent/grants/sync`, {
        data: { tenant_id: ownerTenantId, member_id: ownerMemberId },
        headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
        failOnStatusCode: false,
      });
      if (syncResp.status() === 503) {
        const contentType = syncResp.headers()["content-type"] ?? "";
        expect(contentType, "offline usage sync must be problem+json").toContain("application/problem+json");
        const problem = (await syncResp.json()) as { code?: string; status?: number };
        expect(problem.code).toBe("manager_unavailable");
        expect(problem.status).toBe(503);
        throw new Error("Usage flow requires an online Manager to obtain an executable employee snapshot");
      }
      expect(syncResp.status(), `usage employee sync: ${syncResp.status()}`).toBe(200);
      const syncBody = (await syncResp.json()) as { data?: { ok?: boolean } };
      expect(syncBody.data?.ok, "usage employee sync must be a real successful pull").toBe(true);
      rosterBody = await readRoster();
      snapshotsBody = await readSnapshots();
      employeeId = hasExecutableEmployee();
    }
    expect(employeeId, "Usage prompt requires a current caller-owned executable employee").toBeTruthy();
    if (!employeeId) throw new Error("Usage prompt requires a current caller-owned executable employee");

    // Conversation creation is the ownership boundary; prompt must not invent an owner.
    const traceId = `e2e-loopc-${Date.now()}`;
    const convId = `e2e-usage-${traceId}`;
    const createResp = await request.post(`${agentOrigin}/api/agent/conversations`, {
      data: {
        id: convId,
        title: `E2E usage ${traceId}`,
        kind: "private",
        entry_employee_id: employeeId,
      },
      headers: {
        Authorization: `Bearer ${agentLogin.token}`,
        "Content-Type": "application/json",
      },
      failOnStatusCode: false,
    });
    expect(createResp.status(), `create conversation: ${createResp.status()}`).toBe(201);
    const createBody = (await createResp.json()) as {
      data?: { id?: string; tenant_id?: string; member_id?: string; entry_employee_id?: string };
    };
    expect(createBody.data?.id).toBe(convId);
    expect(createBody.data?.tenant_id).toBe(ownerTenantId);
    expect(createBody.data?.member_id).toBe(ownerMemberId);
    expect(createBody.data?.entry_employee_id).toBe(employeeId);
    // The Agent outbox exposes the public aggregate summary_id. Capture the
    // summary produced by this prompt instead of duplicating its pricing-aware hash.
    const promptResp = await request.post(`${agentOrigin}/api/agent/conversations/${convId}/prompt`, {
      data: { text: `E2E usage cross-tier: ${traceId}` },
      headers: {
        Authorization: `Bearer ${agentLogin.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": traceId,
      },
      failOnStatusCode: false,
    });
    expect(promptResp.status(), `submit prompt: ${promptResp.status()}`).toBe(202);

    // ── 阶段 3/6: 等待真实异步 prompt entry 与 pending usage summary ──
    const entriesBody = await waitFor(
      async () => {
        const response = await request.get(`${agentOrigin}/api/agent/conversations/${convId}/entries`, {
          headers: { Authorization: `Bearer ${agentLogin.token}` }, failOnStatusCode: false,
        });
        expect(response.ok(), `entries read: ${response.status()}`).toBe(true);
        return await response.json() as { data?: { conversation_id?: string; entries?: unknown[] } };
      },
      (body) => body.data?.conversation_id === convId && (body.data.entries ?? []).some((entry) => {
        const message = (entry as { type?: string; message?: { role?: string; stopReason?: string } }).message;
        return entry.type === "message" && message?.role === "assistant" && message.stopReason === "stop";
      }),
      `prompt ${traceId} entries`,
    );
    expect(entriesBody.data?.conversation_id).toBe(convId);
    expect(entriesBody.data?.entries?.length ?? 0).toBeGreaterThan(0);

    const afterPromptBody = await waitFor(
      async () => {
        const response = await request.get(`${agentOrigin}/api/agent/usage/outbox`, {
          headers: { Authorization: `Bearer ${agentLogin.token}` }, failOnStatusCode: false,
        });
        expect(response.ok(), `outbox read after prompt: ${response.status()}`).toBe(true);
        return await response.json() as { data: unknown[] };
      },
      (body) => usageOutboxItems(body.data).some((item) => {
        const id = summaryId(item);
        return id !== undefined
          && item.tenant_id === ownerTenantId
          && item.member_id === ownerMemberId
          && item.employee_id === employeeId
          && (item.status === "pending" || item.status === "failed");
      }),
      `prompt ${traceId} usage outbox`,
    );
    const pendingAfterPrompt = Array.isArray(afterPromptBody.data) ? afterPromptBody.data.length : 0;
    const changedUsageItems = usageOutboxItems(afterPromptBody.data).filter((item) => {
      const id = summaryId(item);
      return id !== undefined
        && item.tenant_id === ownerTenantId
        && item.member_id === ownerMemberId
        && item.employee_id === employeeId;
    });
    const flushedSummaryIds = new Set(
      changedUsageItems.map((item) => summaryId(item)).filter((id): id is string => Boolean(id)),
    );
    expect(flushedSummaryIds.size, `prompt ${traceId} 应产生 usage summary`).toBeGreaterThan(0);
    for (const item of changedUsageItems) {
      expect(item.tenant_id, "usage outbox tenant owner").toBe(ownerTenantId);
      expect(item.member_id, "usage outbox member owner").toBe(ownerMemberId);
      expect(["pending", "failed"], "usage summary must remain flushable").toContain(item.status);
    }

    // ── 阶段 4/6: Flush → 断言 sent > 0（实际有数据发送到 Manager，非空 flush）──
    const flushResp = await request.post(`${agentOrigin}/api/agent/usage/flush`, {
      headers: { Authorization: `Bearer ${agentLogin.token}`, "Content-Type": "application/json" },
      failOnStatusCode: false,
    });
    expect(flushResp.ok(), `flush: ${flushResp.status()}`).toBe(true);
    const flushBody = (await flushResp.json()) as {
      data: { sent: string[]; failed: string[] };
    };
    expect(flushBody, "flush envelope has data").toHaveProperty("data");

    // UsageFlushService returns the real summary IDs, not synthetic counters/batches.
    // A failed upload is an observable failure and must never be treated as success.
    const { sent, failed } = flushBody.data;
    expect(Array.isArray(sent), "flush.sent must be summary id array").toBe(true);
    expect(Array.isArray(failed), "flush.failed must be summary id array").toBe(true);
    expect(failed, "flush must not report a failed Manager upload").toHaveLength(0);
    expect(
      sent.filter((id) => flushedSummaryIds.has(id)),
      "flush must send the summary created by this prompt",
    ).not.toHaveLength(0);

    // ── 阶段 5/6: Flush 后本轮 summary 不再 pending（sent 出队）──
    const afterFlushResp = await request.get(`${agentOrigin}/api/agent/usage/outbox`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
    expect(afterFlushResp.ok(), `outbox read after flush: ${afterFlushResp.status()}`).toBe(true);
    const afterFlushBody = (await afterFlushResp.json()) as { data: unknown[] };
    const pendingAfterFlush = Array.isArray(afterFlushBody.data) ? afterFlushBody.data.length : -1;
    expect(
      pendingAfterFlush <= pendingAfterPrompt,
      `flush 后 pending 应 ≤ prompt 后 (afterPrompt=${pendingAfterPrompt}, afterFlush=${pendingAfterFlush})`,
    ).toBe(true);
    const remainingFlushedIds = usageOutboxItems(afterFlushBody.data)
      .filter((item) => item.status !== "sent")
      .map((item) => summaryId(item))
      .filter((id): id is string => Boolean(id) && flushedSummaryIds.has(id));
    expect(
      remainingFlushedIds,
      `flush sent 后本轮 summary_id 不应继续 pending: ${remainingFlushedIds.join(", ")}`,
    ).toHaveLength(0);

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

    // 按 outbox/Manager 共享的 summary_id 精确定位本次 flush 发送的 records（非任意历史数据）。
    const matchingRecords = rollupBody.data.filter((r) => {
      return typeof r.summary_id === "string" && flushedSummaryIds.has(r.summary_id);
    });
    expect(
      matchingRecords.length,
      `Manager rollup 中应含本轮 flush 的 summary_id: ${[...flushedSummaryIds].join(", ")}`,
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
    await request.delete(`${agentOrigin}/api/agent/conversations/${convId}`, {
      headers: { Authorization: `Bearer ${agentLogin.token}` },
      failOnStatusCode: false,
    });
  });
});
