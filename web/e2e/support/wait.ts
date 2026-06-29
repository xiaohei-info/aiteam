/**
 * AITEAM-224 可复用等待 helpers（最终执行 DAG §5.1 BE2E 基座）。
 *
 * 替代脆弱的固定 sleep / networkidle（dev server HMR、SSE 长连接会让 networkidle 永不触发）。
 * 收敛三端 spec 共用的"等 SPA 挂载 / 等导航就绪 / 等 API 响应落定"模式。
 */

import { expect, type Page, type Response } from "@playwright/test";

/**
 * 等待前端 SPA 首屏挂载就绪：DOM 已加载 + body 有内容（React 已 render）。
 * 不依赖 networkidle（dev server / SSE 会让它永不满足）。
 */
export async function waitForShell(page: Page, opts: { timeout?: number } = {}): Promise<void> {
  await page.waitForLoadState("domcontentloaded", opts);
  await expect(page.locator("body")).not.toBeEmpty({ timeout: opts.timeout ?? 15_000 });
}

/**
 * 等待导航到某路径并就绪：goto 后等 SPA 挂载。
 * 用于"已登录后直接访问受保护页面"场景（storageState 注入后免登录）。
 */
export async function waitForRoute(page: Page, path: string, opts: { timeout?: number } = {}): Promise<void> {
  await page.goto(path);
  await waitForShell(page, opts);
}

/**
 * 等待某 API 请求落定并返回其响应（按 URL 子串匹配）。
 * 用于"触发 UI 动作后等对应后端调用返回"——比 sleep 更可靠。
 * waitForResponse 在调用前已发出的请求会错过，故调用方应在触发动作前 setup。
 */
export async function waitForApiCall(
  page: Page,
  urlSubstring: string,
  trigger: () => Promise<void>,
  opts: { timeout?: number } = {}): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(urlSubstring),
      { timeout: opts.timeout ?? 15_000 },
    ),
    trigger(),
  ]);
  return response;
}
