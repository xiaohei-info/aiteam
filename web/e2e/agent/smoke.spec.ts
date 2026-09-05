import { test, expect } from "@playwright/test";
import { authTest } from "../support/fixtures";
import { expectUnknownRouteProblemJson } from "../support/api-assertions";
import { apiLogin, defaultCredentials, seededEmployeeId, TIER_API_ORIGIN } from "../support/auth";
import { expectShellReady, collectBrowserErrors, expectLoginPageSmoke } from "../support/smoke";

const TIER = "agent" as const;

// Pi execution stays prompt-based; local read views do not restore legacy write APIs.
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
    const response = await request.get(`${TIER_API_ORIGIN.agent}/openapi.json`);
    expect(response.ok()).toBeTruthy();
    const openapi = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
    const localReadPaths = [
      "/api/agent/conversations/{conversation_id}/participants",
      "/api/agent/messages/search",
      "/api/agent/work-records",
      "/api/agent/work-records/changes",
      "/api/agent/usage/statistics",
    ];
    const paths = Object.keys(openapi.paths);
    expect(paths).toEqual(expect.arrayContaining([
      "/api/agent/conversations/{conversation_id}/prompt",
      "/api/agent/conversations/{conversation_id}/entries",
      "/api/agent/conversations/{conversation_id}/events",
      "/api/agent/conversations/{conversation_id}/abort",
      "/api/agent/conversations",
      "/api/agent/conversations/{conversation_id}",
      "/api/agent/conversations/{conversation_id}/state",
      ...localReadPaths,
    ]));
    for (const path of localReadPaths) {
      const methods = Object.keys(openapi.paths[path]).filter((key) =>
        ["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(key));
      expect(methods).toEqual(["get"]);
      expect(openapi.paths[path].get).toMatchObject({ security: [{ bearerAuth: [] }] });
    }
    expect(paths.filter((path) => path !== "/api/agent/messages/search")
      .some((path) => /messages|runs|tasks|loops|timeline|group-dispatch|terminal-execute/.test(path))).toBe(false);
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
    const conversationId = `e2e-pi-conversation-${Date.now()}`;
    const employeeId = process.env.E2E_AGENT_EMPLOYEE_ID ?? seededEmployeeId();
    const created = await authedRequest.post("/api/agent/conversations", {
      data: {
        id: conversationId,
        title: "E2E Pi conversation",
        kind: "private",
        ...(employeeId ? { entry_employee_id: employeeId } : {}),
      },
    });
    expect(created.status()).toBe(201);
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
    const deleted = await authedRequest.delete(`/api/agent/conversations/${conversationId}`);
    expect(deleted.ok()).toBeTruthy();
  });
});
