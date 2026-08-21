/**
 * AITEAM-224 可复用 Playwright fixtures（最终执行 DAG §5.1 BE2E 基座）。
 *
 * 提供"已登录 page / 已登录 request"扩展 fixture：经 globalSetup 产出的 storageState
 * 注入，使各端 spec 免重复登录。无 storageState 时回退实时页面登录（首跑/凭据变更容错）。
 *
 * 用法（各端 spec）：
 *   import { authTest as test } from "../support/fixtures";
 *   test("...", async ({ authedPage, authedRequest, token }) => { ... });
 *
 * storageState 文件路径由 project 名推导（operation-smoke → operation），与
 * playwright.config.ts 的 project 命名对齐。
 */

import { test as base, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import {
  type Tier,
  apiLogin,
  buildStorageState,
  defaultCredentials,
  storageStatePath,
  TIER_API_ORIGIN,
  TIER_BASE_URL,
  TOKEN_STORAGE_KEY,
} from "./auth";
import { loginViaPage } from "./auth";

/** project 名 → tier 映射（对齐 playwright.config.ts projects[].name）。 */
const PROJECT_TO_TIER: Record<string, Tier> = {
  "operation-smoke": "operation",
  "manager-smoke": "manager",
  "agent-smoke": "agent",
};

/** 从当前 test project 名解析 tier。 */
export function tierFromProject(projectName: string | undefined): Tier {
  const tier = projectName ? PROJECT_TO_TIER[projectName] : undefined;
  if (!tier) {
    throw new Error(
      `无法从 project "${projectName}" 解析 tier；expected one of ${Object.keys(PROJECT_TO_TIER)}`,
    );
  }
  return tier;
}

/** 已登录 fixture 集合：扩展 Playwright 默认 page/request。 */
export interface AuthFixtures {
  /** 当前 tier（由 project 名推导）。 */
  tier: Tier;
  /** 已登录 page：经 storageState 注入，免登录直达受保护页面。 */
  authedPage: Page;
  /** 已登录 APIRequestContext：带 Bearer token，直达后端受保护 API。 */
  authedRequest: APIRequestContext;
  /** 当前会话 token（供 api-assertions 等显式带 header 场景）。 */
  token: string;
}

/**
 * 读取 globalSetup 产出的 storageState 文件路径（若存在）。
 * 不存在返回 undefined（fixtures 回退实时登录）。
 */
function maybeStorageState(tier: Tier): string | undefined {
  const p = storageStatePath(tier);
  return existsSync(p) ? p : undefined;
}

/**
 * 经 API 登录取得 token（无 storageState 时的回退路径）。
 * 用独立 request 上下文（无 storageState），直接打 login 端点。
 */
async function tokenViaApiLogin(request: APIRequestContext, tier: Tier): Promise<string> {
  const result = await apiLogin(request, tier, defaultCredentials(tier));
  return result.token;
}

export const authTest = base.extend<AuthFixtures>({
  tier: async ({ }, use, testInfo) => {
    await use(tierFromProject(testInfo.project.name));
  },

  token: async ({ request, tier }, use) => {
    // 优先读 storageState 文件里的 token（globalSetup 已产出）；否则 API 登录实时取。
    const statePath = maybeStorageState(tier);
    let token: string | undefined;
    if (statePath) {
      const raw = JSON.parse(readFileSync(statePath, "utf-8")) as {
        origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
      };
      const origin = raw.origins?.find((item) => item.origin === TIER_BASE_URL[tier]) ?? raw.origins?.[0];
      const entry = origin?.localStorage?.find((e) => e.name === TOKEN_STORAGE_KEY[tier]);
      token = entry?.value;
    }
    if (!token) {
      token = await tokenViaApiLogin(request, tier);
    }
    await use(token);
  },

  authedRequest: async ({ playwright, tier, token }, use) => {
    // 带 storageState 的 API 请求上下文（token 经 localStorage 注入，后端读 Bearer）。
    // APIRequestContext 不读 localStorage token，故显式拼 Authorization header 更可靠。
    const storageState = maybeStorageState(tier);
    const options: {
      baseURL: string;
      extraHTTPHeaders: { Authorization: string };
      storageState?: string;
    } = {
      baseURL: TIER_API_ORIGIN[tier],
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    };
    if (storageState) options.storageState = storageState;
    const request = await playwright.request.newContext(options);
    await use(request);
    await request.dispose();
  },

  authedPage: async ({ browser, tier, token }, use) => {
    // 优先用 storageState 注入（免登录）；否则实时页面登录。
    const storageState = maybeStorageState(tier);
    const context = await browser.newContext(
      storageState
        ? { storageState }
        : { storageState: buildStorageState(tier, token) },
    );
    const page = await context.newPage();
    // storageState 无效 / token 过期时回退实时登录（容错，不硬失败）。
    const hasStorageState = Boolean(storageState);
    if (!hasStorageState) {
      await loginViaPage(page, tier, defaultCredentials(tier));
    }
    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";
