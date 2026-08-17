import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import { authTest, expect } from "../support/fixtures";
import {
  collectBrowserErrors,
  expectKeyboardFocusVisible,
} from "../support/smoke";

const conversationId = "astryx-chat-benchmark";
const fixedConversation = {
  id: conversationId,
  title: "Astryx 设计评审",
  state: "active",
  collaboration_mode: "free",
  entry_employee_id: null,
  last_read_at: null,
  last_read_message_id: null,
  created_at: "2026-07-11T08:00:00Z",
  updated_at: "2026-07-11T08:30:00Z",
};

const emptyPage = { data: [], page: { next_cursor: null, has_more: false } };

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({ json: value });
}

async function installDeterministicChatData(page: Page): Promise<void> {
  await page.route("**/api/agent/conversations**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/agent/conversations") {
      await fulfillJson(route, {
        data: [fixedConversation],
        page: { next_cursor: null, has_more: false },
      });
      return;
    }
    if (path.endsWith("/entries")) {
      await fulfillJson(route, {
        data: [
          {
            cursor: 1,
            run_id: "run-astryx-001",
            conversation_id: conversationId,
            type: "answer",
            payload: { text: "重构方案已准备好，可以开始逐端迁移。" },
            created_at: "2026-07-11T08:30:00Z",
          },
        ],
        page: { next_cursor: null, has_more: false },
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/agent/grants/experts**", (route) => fulfillJson(route, emptyPage));
}

async function openChatBenchmark(page: Page): Promise<void> {
  await installDeterministicChatData(page);
  await page.goto("/chat");
  await page.getByRole("button", { name: "Astryx 设计评审" }).click();
  await expect(page.getByRole("log", { name: "对话时间线" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
}

authTest.describe("Agent Astryx Chat benchmark", () => {
  authTest("light mode passes visual, accessibility, keyboard, and console gates", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await openChatBenchmark(authedPage);

    await expect(authedPage).toHaveScreenshot("agent-chat-light.png", { fullPage: true });
    const results = await new AxeBuilder({ page: authedPage }).analyze();
    expect(
      results.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
    ).toEqual([]);
    await expectKeyboardFocusVisible(authedPage);
    expect(browserErrors).toEqual([]);
  });

  authTest("dark and reduced-motion modes remain immediately usable", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await openChatBenchmark(authedPage);

    await expect(authedPage).toHaveScreenshot("agent-chat-dark.png", { fullPage: true });
    await expect(authedPage.getByRole("textbox", { name: "消息内容" })).toBeEditable();
    await authedPage.getByRole("link", { name: "工作台" }).focus();
    await expect(authedPage.getByRole("link", { name: "工作台" })).toBeFocused();
    expect(browserErrors).toEqual([]);
  });

  authTest("sending a prompt still reaches the direct Pi session API", async ({ authedPage, authedRequest }) => {
    const createResponse = await authedRequest.post("/api/agent/conversations", {
      data: { title: "astryx-e2e-mainline" },
      failOnStatusCode: false,
    });
    expect(createResponse.ok(), `create conversation failed: ${createResponse.status()}`).toBeTruthy();
    const created = (await createResponse.json()) as { data: typeof fixedConversation };
    const createdConversation = created.data;

    await authedPage.route("**/api/agent/conversations**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" && path === "/api/agent/conversations") {
        await fulfillJson(route, {
          data: [createdConversation],
          page: { next_cursor: null, has_more: false },
        });
        return;
      }
      await route.continue();
    });

    const promptResponse = authedPage.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith(`/conversations/${createdConversation.id}/prompt`),
    );

    await authedPage.goto("/chat");
    await authedPage.getByRole("button", { name: "astryx-e2e-mainline" }).click();
    const textbox = authedPage.getByRole("textbox", { name: "消息内容" });
    await textbox.fill("验证 Astryx 发送主链");
    await authedPage.getByRole("button", { name: "发送" }).click();

    expect((await promptResponse).status()).toBe(202);
    await expect(textbox).toHaveText("");
  });
});
