/**
 * AITEAM-224 三端 smoke 共享 helper（P1 基座 + Wave2 扩展，最终执行 DAG §5.1）。
 *
 * 单一事实源：三端 spec 共用的"登录页 smoke / 浏览器错误采集 / API problem+json 守卫"
 * 收敛于此，避免每端各写一遍导致口径漂移。Wave2 新增 expectShellReady（替代脆弱 sleep）。
 */

import { expect, type Page, type APIRequestContext } from "@playwright/test";

export type TierSmoke = {
  tier: "operation" | "manager" | "agent";
  loginText: RegExp;
};

/**
 * 前端 SPA 首屏就绪等待：DOM 加载 + body 有内容（React 已 render）。
 * 替代脆弱的固定 sleep / networkidle（dev server HMR、SSE 长连接会让 networkidle 永不触发）。
 */
export async function expectShellReady(page: Page, opts: { timeout?: number } = {}): Promise<void> {
  await page.waitForLoadState("domcontentloaded", opts);
  await expect(page.locator("body")).not.toBeEmpty({ timeout: opts.timeout ?? 15_000 });
}

export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}

/**
 * 登录页 smoke：标题文案可见 + 登录表单可见。
 * 三端 LoginPage 结构有差异：operation/manager 用 data-testid="login-form"，
 * agent 用裸 <form>（无 testid）。这里按 testid 优先、回退 form 元素，保证三端通用。
 */
export async function expectLoginPageSmoke(page: Page, smoke: TierSmoke): Promise<void> {
  await page.goto("/login");
  await expect(page.getByText(smoke.loginText).first()).toBeVisible();
  const form = page.getByTestId("login-form").or(page.locator("form"));
  await expect(form.first()).toBeVisible();
}

/**
 * 断言未知 /api 路径返回 404 problem+json，不是 text/html SPA fallback（验收第 5 条）。
 * 保留 P1 基座口径；Wave2 更细粒度的 contract 断言见 e2e/support/api-assertions.ts。
 */
export async function expectApiProblemJson(request: APIRequestContext, tier: TierSmoke["tier"]): Promise<void> {
  const response = await request.get(`/api/${tier}/__missing_route__`);
  const contentType = response.headers()["content-type"] ?? "";
  expect(response.status()).toBe(404);
  expect(contentType).toContain("application/problem+json");
  expect(contentType).not.toContain("text/html");
  expect((await response.text()).toLowerCase()).not.toContain("<!doctype html");
}
