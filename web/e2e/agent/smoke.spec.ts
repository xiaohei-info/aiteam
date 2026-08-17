import { test, expect } from "@playwright/test";
import { authTest } from "../support/fixtures";
import { expectUnknownRouteProblemJson } from "../support/api-assertions";
import { apiLogin, defaultCredentials } from "../support/auth";
import { expectShellReady, collectBrowserErrors, expectLoginPageSmoke } from "../support/smoke";

const TIER = "agent" as const;
const conversationId = "e2e-pi-conversation";

// These are the only conversation endpoints owned by the refactored Node Agent.
test.describe("agent auth", () => {
  test("登录页 shell 与表单可见", async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);
    await expectLoginPageSmoke(page, { tier: TIER, loginText: /用户|Agent|登录/i });
    expect(browserErrors).toEqual([]);
  });

  test("API 登录返回 token + claims", async ({ request }) => {
    const result = await apiLogin(request, TIER, defaultCredentials(TIER));
    expect(result.claims).toBeTruthy();
  });
});

test.describe("agent api-contract", () => {
  test("未知 /api 路径返回 problem+json", async ({ request }) => {
    await expectUnknownRouteProblemJson(request, TIER);
  });

  test("Node Agent publishes the Pi conversation contract", async ({ request }) => {
    const response = await request.get("http://127.0.0.1:8180/openapi.json");
    expect(response.ok()).toBeTruthy();
    const openapi = (await response.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths)).toEqual(expect.arrayContaining([
      "/api/agent/conversations/{conversation_id}/prompt",
      "/api/agent/conversations/{conversation_id}/entries",
      "/api/agent/conversations/{conversation_id}/events",
      "/api/agent/conversations/{conversation_id}/abort",
      "/api/agent/conversations",
      "/api/agent/conversations/{conversation_id}",
      "/api/agent/conversations/{conversation_id}/state",
    ]));
    expect(Object.keys(openapi.paths).some((path) => /messages|runs|tasks|loops|timeline|group-dispatch|terminal-execute/.test(path))).toBe(false);
  });
});

authTest.describe("agent workspace", () => {
  authTest("workspace 页面 shell 就绪无 console error", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.goto("/workspace");
    await expectShellReady(authedPage);
    expect(browserErrors).toEqual([]);
  });
});

authTest.describe("agent Pi prompt", () => {
  authTest("prompt → entries and abort use the Node Agent endpoints", async ({ authedRequest }) => {
    const prompt = await authedRequest.post(`/api/agent/conversations/${conversationId}/prompt`, {
      data: { text: "e2e prompt" },
      headers: { "Idempotency-Key": `e2e-${Date.now()}` },
      failOnStatusCode: false,
    });
    expect(prompt.status()).toBe(202);
    expect(((await prompt.json()) as { data: { accepted: boolean } }).data.accepted).toBe(true);

    const entries = await authedRequest.get(`/api/agent/conversations/${conversationId}/entries`);
    expect(entries.ok()).toBeTruthy();
    expect(Array.isArray(((await entries.json()) as { data: { entries: unknown[] } }).data.entries)).toBe(true);

    const abort = await authedRequest.post(`/api/agent/conversations/${conversationId}/abort`);
    expect(abort.ok()).toBeTruthy();
  });
});
