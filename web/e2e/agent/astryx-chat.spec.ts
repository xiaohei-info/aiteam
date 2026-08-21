import AxeBuilder from "@axe-core/playwright";
import { authTest, expect } from "../support/fixtures";
import { collectBrowserErrors, expectKeyboardFocusVisible } from "../support/smoke";

async function openChat(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
): Promise<{ id: string; title: string }> {
  const conversation = { id: `astryx-chat-${Date.now()}-${Math.random().toString(16).slice(2)}`, title: "Astryx 设计评审" };
  const response = await request.post("/api/agent/conversations", {
    data: {
      id: conversation.id,
      title: conversation.title,
      kind: "private",
      ...(process.env.E2E_AGENT_EMPLOYEE_ID ? { entry_employee_id: process.env.E2E_AGENT_EMPLOYEE_ID } : {}),
    },
  });
  expect(response.status()).toBe(201);
  await page.goto("/chat");
  await page.getByRole("button", { name: conversation.title }).click();
  await expect(page.getByRole("log", { name: "对话事件流" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  return conversation;
}

authTest.describe("Agent Astryx Chat", () => {
  authTest("light mode passes visual, accessibility, keyboard, and console gates", async ({ authedPage, authedRequest }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await openChat(authedPage, authedRequest);
    await expect(authedPage).toHaveScreenshot("agent-chat-light.png", { fullPage: true });
    const results = await new AxeBuilder({ page: authedPage }).analyze();
    expect(results.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
    await expectKeyboardFocusVisible(authedPage);
    expect(browserErrors).toEqual([]);
  });

  authTest("dark and reduced-motion modes remain usable", async ({ authedPage, authedRequest }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await openChat(authedPage, authedRequest);
    await expect(authedPage.getByRole("textbox", { name: "消息内容" })).toBeEditable();
    await authedPage.getByRole("link", { name: "工作台" }).focus();
    await expect(authedPage.getByRole("link", { name: "工作台" })).toBeFocused();
    expect(browserErrors).toEqual([]);
  });

  authTest("sending a prompt reaches the Node Agent prompt endpoint", async ({ authedPage, authedRequest }) => {
    const conversation = await openChat(authedPage, authedRequest);
    const promptResponse = authedPage.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith(`/conversations/${conversation.id}/prompt`),
    );
    const textbox = authedPage.getByRole("textbox", { name: "消息内容" });
    await textbox.fill("验证 Astryx 发送主链");
    await authedPage.getByRole("button", { name: "发送" }).click();
    expect((await promptResponse).status()).toBe(202);
    await expect(textbox).toHaveValue("");
  });
});
