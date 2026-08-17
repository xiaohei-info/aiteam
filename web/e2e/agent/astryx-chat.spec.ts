import AxeBuilder from "@axe-core/playwright";
import { authTest, expect } from "../support/fixtures";
import { collectBrowserErrors, expectKeyboardFocusVisible } from "../support/smoke";

const conversation = {
  id: "astryx-chat-benchmark",
  title: "Astryx 设计评审",
  state: "active",
  collaboration_mode: "free",
  last_read_at: null,
  last_read_message_id: null,
  created_at: "2026-07-11T08:00:00Z",
  updated_at: "2026-07-11T08:30:00Z",
};

async function seedConversation(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript((item) => {
    localStorage.setItem("aiteam.agent.conversations", JSON.stringify([item]));
  }, conversation);
}

async function openChat(page: import("@playwright/test").Page): Promise<void> {
  await seedConversation(page);
  await page.goto("/chat");
  await page.getByRole("button", { name: conversation.title }).click();
  await expect(page.getByRole("log", { name: "对话事件流" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
}

authTest.describe("Agent Astryx Chat", () => {
  authTest("light mode passes visual, accessibility, keyboard, and console gates", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await openChat(authedPage);
    await expect(authedPage).toHaveScreenshot("agent-chat-light.png", { fullPage: true });
    const results = await new AxeBuilder({ page: authedPage }).analyze();
    expect(results.violations.filter((item) => item.impact === "critical" || item.impact === "serious")).toEqual([]);
    await expectKeyboardFocusVisible(authedPage);
    expect(browserErrors).toEqual([]);
  });

  authTest("dark and reduced-motion modes remain usable", async ({ authedPage }) => {
    const browserErrors = collectBrowserErrors(authedPage);
    await authedPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await openChat(authedPage);
    await expect(authedPage.getByRole("textbox", { name: "消息内容" })).toBeEditable();
    await authedPage.getByRole("link", { name: "工作台" }).focus();
    await expect(authedPage.getByRole("link", { name: "工作台" })).toBeFocused();
    expect(browserErrors).toEqual([]);
  });

  authTest("sending a prompt reaches the Node Agent prompt endpoint", async ({ authedPage }) => {
    await openChat(authedPage);
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
