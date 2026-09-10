/**
 * AITEAM-224 可复用认证 harness（最终执行 DAG §5.1 BE2E 基座）。
 *
 * 三端登录收敛到本模块：凭据来源、storageState 路径、页面登录 / API 登录统一出口。
 * 各端前端只调本端 `/api/<tier>/*` 与 `/api/auth/*`（08 §12.2），不跨端直调、不直绑
 * Hermes Runtime 内部对象——本 harness 经前端真实登录链拿 token，复现用户路径。
 *
 * storageState：globalSetup 用本模块的 API 登录产出 `storageState.<tier>.json`，
 * 各端 spec 经 fixtures 注入后即"已登录"，跳过每用例重复登录（Playwright 官方模式）。
 * 本地无 storageState（首跑 / 凭据变更）时，fixtures 回退到页面登录实时产出。
 */

import { type APIRequestContext, type Page, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 三端 tier（对齐 @aiteam/shared ApiClient.Tier / 后端 §4 命名映射）。 */
export type Tier = "operation" | "manager" | "agent";

/** 前端 dev server 基址（对齐 playwright.config.ts projects.use.baseURL）。 */
const origin = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export const TIER_BASE_URL: Record<Tier, string> = {
  operation: origin("E2E_OPERATION_UI_ORIGIN", "http://127.0.0.1:5173"),
  manager: origin("E2E_MANAGER_UI_ORIGIN", "http://localhost:5174"),
  agent: origin("E2E_AGENT_UI_ORIGIN", "http://127.0.0.1:5180"),
};

/** 后端服务 origin（本地 webServer 或 E2E_EXTERNAL 部署 profile）。 */
export const TIER_API_ORIGIN: Record<Tier, string> = {
  operation: origin("E2E_OPERATION_API_ORIGIN", "http://127.0.0.1:8000"),
  manager: origin("E2E_MANAGER_API_ORIGIN", "http://127.0.0.1:8001"),
  agent: origin("E2E_AGENT_API_ORIGIN", "http://127.0.0.1:8180"),
};

/**
 * 前端 localStorage token key（对齐各端 AppProviders / token-store）。
 * storageState 只需持久化本 key（+ agent 端 claims key），其余为浏览器运行态。
 */
export const TOKEN_STORAGE_KEY: Record<Tier, string> = {
  operation: "aiteam.operation.token",
  manager: "aiteam.manager.token",
  agent: "aiteam.agent.token",
};

/** agent 端额外持久化的 claims key（对齐 agent/src/lib/token-store.ts）。 */
export const AGENT_CLAIMS_STORAGE_KEY = "aiteam.agent.claims";

/** storageState 落盘根目录（gitignored 临时态，不入仓）。 */
export const STORAGE_STATE_DIR = join(process.cwd(), ".auth");

/** storageState 文件路径：globalSetup 产出 / fixtures 注入的单一事实源。 */
export function storageStatePath(tier: Tier): string {
  return join(STORAGE_STATE_DIR, `storageState.${tier}.json`);
}

/** 各端默认凭据（dev/单机部署 SOP 口径，对齐 .env.example 与 conftest）。 */
export interface TierCredentials {
  /** operation: username + password；manager/agent: account(phone) + password + optional tenant_id。 */
  username?: string;
  account?: string;
  password: string;
  tenant_id?: string;
}

/**
 * 默认凭据。operation 取 env（与 server/conftest 同源默认）。
 * manager/agent 取 globalSetup 写入的本次运行租户成员账号（见 globalSetup.ts）；无 seed handoff
 * 时回退到 env/default。operation 凭据经 env 覆盖，便于不同部署复用同一 harness。
 */
interface SeedMetadata {
  tenant_id?: unknown;
  account?: unknown;
  password?: unknown;
  employee_id?: unknown;
}

/**
 * Read the run-scoped seed written by globalSetup. Workers do not reliably inherit
 * process.env mutations made by globalSetup, so this file is the worker handoff.
 */
function seedMetadata(): SeedMetadata {
  try {
    const value = JSON.parse(readFileSync(join(STORAGE_STATE_DIR, "e2e-tenant.json"), "utf-8")) as SeedMetadata;
    return value;
  } catch {
    return {};
  }
}

/** Run-scoped employee handoff written by globalSetup after Manager seed. */
export function seededEmployeeId(): string | undefined {
  const value = seedMetadata().employee_id;
  if (typeof value === "string" && value.trim()) return value.trim();
  const external = process.env.E2E_AGENT_EMPLOYEE_ID?.trim();
  return external || undefined;
}

/** Non-production synthetic UUID used by local/CI Playwright Manager seed. */
export const DEFAULT_E2E_TENANT_ID = "00000000-0000-4000-8000-000000000001";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one Manager deployment tenant for local/CI E2E.
 *
 * Wave1 binds a single Manager process to this UUID. Positive F01/F02
 * requests must target it; inventing a second tenant is a binding mismatch,
 * not a provisioning success. Dynamic Operator→Manager routing is Wave2 S06.
 */
export function boundManagerTenantId(): string {
  const raw = (
    process.env.E2E_TENANT_ID?.trim() ||
    process.env.MANAGER_TENANT_ID?.trim() ||
    DEFAULT_E2E_TENANT_ID
  );
  if (!UUID_RE.test(raw)) {
    throw new Error("E2E_TENANT_ID/MANAGER_TENANT_ID must be a UUID");
  }
  return raw.toLowerCase();
}

export function defaultCredentials(tier: Tier): TierCredentials {
  const seed = seedMetadata();
  const seededTenantId = typeof seed.tenant_id === "string" && seed.tenant_id.trim()
    ? seed.tenant_id.trim()
    : process.env.E2E_TENANT_ID?.trim();
  const seededAccount = typeof seed.account === "string" && seed.account.trim()
    ? seed.account.trim()
    : process.env.E2E_MEMBER_ACCOUNT;
  const seededPassword = typeof seed.password === "string" && seed.password
    ? seed.password
    : process.env.E2E_MEMBER_PASSWORD;

  if (tier === "operation") {
    return {
      username: process.env.E2E_OPERATION_USERNAME ?? "sysadmin",
      password: process.env.E2E_OPERATION_PASSWORD ?? "changeme-me",
    };
  }
  const tenantId = seededTenantId ?? "00000000-0000-0000-0000-00000000e2e0";
  const phone = seededAccount ?? "13800000001";
  const password = seededPassword ?? "E2e-Pass-2024";
  return { account: phone, password, tenant_id: tenantId };
}

/** operation 登录入参（对齐 server SystemLoginInput）。 */
interface OperationLoginInput {
  username: string;
  password: string;
}
/** manager 登录入参（对齐 server LoginInput，extra="forbid"）。 */
interface ManagerLoginInput {
  tenant_id: string;
  account: string;
  password: string;
}
/** agent 登录入参（对齐 server LoginRequest）。 */
interface AgentLoginInput {
  account: string;
  password: string;
  tenant_id?: string;
}

/** 各端登录返回 envelope.data 的最小形状（只需 token，agent 额外 claims）。 */
interface LoginResult {
  token: string;
  claims?: Record<string, unknown>;
}

/** 各端登录 API 路径（对齐前端 LoginPage 真实调用）。 */
const LOGIN_PATH: Record<Tier, string> = {
  operation: "/api/operation/auth/login",
  manager: "/api/auth/login",
  agent: "/api/agent/login",
};

/**
 * API 登录（不经浏览器，直接打后端 login 端点）。globalSetup 用它产出 storageState。
 * 返回 token（agent 连同 claims）。凭据错误抛非 2xx（由调用方断言）。
 */
export async function apiLogin(
  request: APIRequestContext,
  tier: Tier,
  creds: TierCredentials = defaultCredentials(tier),
): Promise<LoginResult> {
  const origin = TIER_API_ORIGIN[tier];
  let body: OperationLoginInput | ManagerLoginInput | AgentLoginInput;
  if (tier === "operation") {
    body = { username: creds.username ?? "", password: creds.password };
  } else if (tier === "manager") {
    body = { tenant_id: creds.tenant_id ?? "", account: creds.account ?? "", password: creds.password };
  } else {
    body = { account: creds.account ?? "", password: creds.password, tenant_id: creds.tenant_id };
  }
  const response = await request.post(`${origin}${LOGIN_PATH[tier]}`, {
    data: body,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  expect(response.ok(), `${tier} api login failed: ${response.status()}`).toBeTruthy();
  const payload = (await response.json()) as { data: LoginResult };
  expect(payload.data?.token, `${tier} login envelope missing token`).toBeTruthy();
  return payload.data;
}

/**
 * 页面登录（经前端真实 LoginPage 表单）。复现用户真实路径，验证前端登录链贯通。
 * 登录成功后 token 自动写入 localStorage（由前端 AppProviders/signIn 负责）。
 */
export async function loginViaPage(
  page: Page,
  tier: Tier,
  creds: TierCredentials = defaultCredentials(tier),
): Promise<void> {
  await page.goto("/login");
  const form = page.getByTestId("login-form").or(page.locator("form"));
  await expect(form.first()).toBeVisible();

  // 三端 LoginPage 字段结构有差异（operation/manager 用 Field+Input，agent 用裸 label+input）。
  // 按 input 元素类型与顺序稳健定位，不依赖 testid / htmlFor / getByLabel。
  const textInputs = form.locator("input[type=text], input:not([type])");
  const passwordInput = form.locator("input[type=password]");

  // Manager 保持 tenant_id 输入框；Agent 改由同源 Node Agent 按 account/enterprise 解析租户。
  if (tier === "manager" && creds.tenant_id) {
    await textInputs.first().fill(creds.tenant_id);
  }
  // 账号/用户名：operation/agent 是第一个 text input，manager 是第二个。
  const accountIndex = tier === "manager" ? 1 : 0;
  await textInputs.nth(accountIndex).fill(creds.username ?? creds.account ?? "");
  await passwordInput.first().fill(creds.password);
  await form.locator("button[type=submit]").first().click();

  // 登录成功后前端跳离 /login（RequireAuth 放行）；失败留在 /login。
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * 构造某 tier 已登录的 storageState 对象（内存态，供 APIRequestContext.storageState 直接用）。
 * 只持久化 token（+ agent claims），不带无关浏览器态——最小必要。
 */
export function buildStorageState(
  tier: Tier,
  token: string,
  claims?: Record<string, unknown>,
): {
  cookies: never[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
  const origin = TIER_BASE_URL[tier];
  const localStorage: Array<{ name: string; value: string }> = [
    { name: TOKEN_STORAGE_KEY[tier], value: token },
  ];
  if (tier === "agent" && claims) {
    localStorage.push({ name: AGENT_CLAIMS_STORAGE_KEY, value: JSON.stringify(claims) });
  }
  return { cookies: [], origins: [{ origin, localStorage }] };
}
