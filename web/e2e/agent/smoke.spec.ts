/**
 * AITEAM-224 用户端（Agent）单端 smoke + API contract（最终执行 DAG §5.1 验收第 4 条）。
 *
 * 覆盖：auth / workspace / conversation / group / prompt / sync / api-contract。
 * 前端只调本端 /api/agent/* + /api/agent/login（08 §12.2），不跨端直调、不直绑 Pi SDK 内部对象。
 *
 * agent 是用户端本地优先单用户端（03 §9.4C）：登录经 Manager 校验凭据→缓存 token→本地验签；
 * 主链路（conversations/prompt/entries/...）无 Bearer 鉴权依赖（本地无入站、无多租户 RLS）。
 * 故 auth 覆盖=登录链贯通 + whoami 本地验签；api-contract=problem+json 守卫（非 SPA fallback）。
 *
 * 非目标：不重复 service 层业务断言、不测 LLM 文本质量、不绕过 Agent 会话 API 直连 Pi SDK。
 * 验证命令：npx playwright test --project=agent-smoke
 */

import { test, expect } from "@playwright/test";
import { authTest } from "../support/fixtures";
import {
  expectAuthenticatedEnvelope,
  expectListEnvelope,
  expectUnknownRouteProblemJson,
} from "../support/api-assertions";
import { apiLogin, defaultCredentials } from "../support/auth";
import { expectShellReady, collectBrowserErrors, expectLoginPageSmoke } from "../support/smoke";

const TIER = "agent" as const;

test.describe("agent auth", () => {
  test("登录页 shell 与表单可见", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await expectLoginPageSmoke(page, { tier: TIER, loginText: /用户|Agent|登录/i });
    expect(browserErrors).toEqual([]);
  });

  test("API 登录经 Manager 校验返回 token + claims（本地验签链贯通）", async ({ request }) => {
    const result = await apiLogin(request, TIER);
    expect(result.claims, "agent login 应返回 claims").toBeTruthy();
    // whoami 经本地缓存会话验签（登录后 whoami 可读）。
    await expectAuthenticatedEnvelope(request, TIER, result.token);
  });
});

test.describe("agent api-contract", () => {
  test("未知 /api 路径返回 404 problem+json（非 SPA fallback）", async ({ request }) => {
    await expectUnknownRouteProblemJson(request, TIER);
  });
});

authTest.describe("agent workspace（工作台）", () => {
  authTest("conversations 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/agent/conversations", token);
  });

  authTest("workspace 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/workspace");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("agent conversation（会话主链）", () => {
  authTest("建会话 → 列 Pi entries 的契约形状", async ({ authedRequest }) => {
    // 建会话（POST /api/agent/conversations）→ envelope.data.id
    const createResp = await authedRequest.post("/api/agent/conversations", {
      data: { title: "e2e-smoke" },
      failOnStatusCode: false,
    });
    expect(createResp.ok(), `create conversation failed: ${createResp.status()}`).toBeTruthy();
    const created = (await createResp.json()) as { data: { id: string } };
    expect(created.data?.id, "conversation envelope has id").toBeTruthy();
    const convId = created.data.id;

    // 列 Pi entries（GET /conversations/{id}/entries）→ envelope
    const msgResp = await authedRequest.get(`/api/agent/conversations/${convId}/entries`, {
      failOnStatusCode: false,
    });
    expect(msgResp.ok(), `list entries failed: ${msgResp.status()}`).toBeTruthy();
    const entriesBody = (await msgResp.json()) as { data: { entries: unknown[] } };
    expect(Array.isArray(entriesBody.data.entries)).toBeTruthy();
  });

  authTest("chat 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/chat");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("agent group（群聊）", () => {
  authTest("grants/experts 本地投影列表返回 list envelope", async ({ request, token }) => {
    // 群聊前端用 /api/agent/grants/experts 列已装载专家（useGroupApi）。
    await expectListEnvelope(request, TIER, "/api/agent/grants/experts", token);
  });

  authTest("group 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/group");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("agent prompt（Pi 会话）", () => {
  authTest("prompt 入口直接接受一次 Pi 会话输入", async ({ authedRequest }) => {
    const createResp = await authedRequest.post("/api/agent/conversations", {
      data: { title: "e2e-smoke-prompt" }, failOnStatusCode: false,
    });
    expect(createResp.ok()).toBeTruthy();
    const convId = ((await createResp.json()) as { data: { id: string } }).data.id;
    const promptResp = await authedRequest.post(`/api/agent/conversations/${convId}/prompt`, {
      data: { text: "e2e prompt" }, headers: { "Idempotency-Key": `e2e-${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(promptResp.status()).toBe(202);
    const body = (await promptResp.json()) as { data: { accepted: boolean; conversation_id: string } };
    expect(body.data.accepted).toBe(true);
    expect(body.data.conversation_id).toBe(convId);
  });
});

authTest.describe("agent sync（授权配置 pull）", () => {
  authTest("grants/snapshots 列表返回 list envelope", async ({ request, token }) => {
    // sync 页面用 /api/agent/grants/snapshots 列已冻结快照（useSyncApi）。
    await expectListEnvelope(request, TIER, "/api/agent/grants/snapshots", token);
  });

  authTest("usage/outbox 列表返回 list envelope", async ({ request, token }) => {
    await expectListEnvelope(request, TIER, "/api/agent/usage/outbox", token);
  });

  authTest("sync 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/sync");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});
