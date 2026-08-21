/**
 * AITEAM-224 Playwright globalSetup（最终执行 DAG §5.1 BE2E 基座）。
 *
 * 在 webServers 起来后、用例跑前执行一次：
 * 1. seed E2E 租户 + 成员账号（manager/agent 登录所需；operation 用系统账号免 seed）。
 * 2. 经 API 登录三端，产出 storageState.<tier>.json，供 fixtures 注入（免每用例登录）。
 *
 * 设计取舍：
 * - seed 用独立 Python 子进程（直接读写控制面/业务 DB，幂等），不依赖跨端 bootstrap 流程，
 *   保证 globalSetup 确定性（不依赖 operation→manager 服务间调用已就绪）。
 * - storageState 只持久化 token（+ agent claims），最小必要。
 * - 任一端登录失败不硬中断：让对应 spec 自行回退页面登录并报具体错误（更可诊断）。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "@playwright/test";
import {
  type Tier,
  STORAGE_STATE_DIR,
  TIER_API_ORIGIN,
  TOKEN_STORAGE_KEY,
  AGENT_CLAIMS_STORAGE_KEY,
  TIER_BASE_URL,
  defaultCredentials,
  storageStatePath,
} from "./auth";

const TIERS: Tier[] = ["operation", "manager", "agent"];

/** 登录 API 路径（对齐前端 LoginPage 真实调用）。 */
const LOGIN_PATH: Record<Tier, string> = {
  operation: "/api/operation/auth/login",
  manager: "/api/auth/login",
  agent: "/api/agent/login",
};

/**
 * seed E2E 租户 + 成员账号。调 e2e/support/seed-e2e-tenant.py（Python 子进程）。
 * 无 DB 配置时脚本自身 skip（operation 端不依赖）；返回 seed stdout JSON。
 */
function seedE2eTenant(): { tenant_id?: string; account?: string; skipped?: string } | null {
  if (process.env.E2E_EXTERNAL === "true" && process.env.E2E_EXTERNAL_SEED !== "true") {
    const tenant_id = process.env.E2E_TENANT_ID?.trim();
    if (!tenant_id) throw new Error("E2E_EXTERNAL requires E2E_TENANT_ID");
    return { tenant_id, skipped: "external deployment" };
  }
  const script = join(process.cwd(), "e2e", "support", "seed-e2e-tenant.py");
  const py = process.env.E2E_PYTHON ?? join(process.cwd(), "..", ".venv", "bin", "python");
  const res = spawnSync(py, [script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      // PYTHONPATH 指向 server/ 包根，使 import shared / manager_service 可用。
      PYTHONPATH: join(process.cwd(), "..", "server"),
    },
    timeout: 30_000,
  });
  if (res.error || res.status !== 0) {
        const msg = res.error?.message ?? res.stderr ?? res.stdout ?? "unknown";
    console.error(`[globalSetup] seed-e2e-tenant FAILED: ${msg}`);
    throw new Error(`seed-e2e-tenant failed: ${msg}`);
  }
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    return null;
  }
}

/** 经 API 登录某 tier，返回 envelope.data（token + agent claims）。 */
async function loginTier(tier: Tier, tenantId?: string): Promise<{ token: string; claims?: Record<string, unknown> } | null> {
  const ctx = await request.newContext({ baseURL: TIER_API_ORIGIN[tier] });
  try {
    const creds = defaultCredentials(tier);
    // seed 产出的 tenant_id 注入 creds（manager/agent 登录需固定 tenant_id）。
    if (tenantId && tier !== "operation") creds.tenant_id = tenantId;
    let body: Record<string, unknown>;
    if (tier === "operation") {
      body = { username: creds.username ?? "", password: creds.password };
    } else if (tier === "manager") {
      body = { tenant_id: creds.tenant_id ?? "", account: creds.account ?? "", password: creds.password };
    } else {
      body = { account: creds.account ?? "", password: creds.password, tenant_id: creds.tenant_id };
    }
    const response = await ctx.post(LOGIN_PATH[tier], { data: body, failOnStatusCode: false });
    if (!response.ok()) {
      console.warn(`[globalSetup] ${tier} api login 失败: ${response.status()}（spec 将回退页面登录）`);
      return null;
    }
    const payload = (await response.json()) as { data: { token: string; claims?: Record<string, unknown> } };
    if (!payload.data?.token) {
      console.warn(`[globalSetup] ${tier} login envelope 缺 token`);
      return null;
    }
    return payload.data;
  } finally {
    await ctx.dispose();
  }
}

/** 写某 tier 的 storageState 文件（只持久化 token + agent claims）。 */
function writeStorageState(tier: Tier, token: string, claims?: Record<string, unknown>): void {
  const origin = TIER_BASE_URL[tier];
  const localStorage: Array<{ name: string; value: string }> = [
    { name: TOKEN_STORAGE_KEY[tier], value: token },
  ];
  if (tier === "agent" && claims) {
    localStorage.push({ name: AGENT_CLAIMS_STORAGE_KEY, value: JSON.stringify(claims) });
  }
  const state = { cookies: [], origins: [{ origin, localStorage }] };
  writeFileSync(storageStatePath(tier), JSON.stringify(state, null, 2), "utf-8");
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(STORAGE_STATE_DIR, { recursive: true });

  // 0. 构建共享包（@aiteam/shared），确保前端 dev server 可解析。
  console.log("[globalSetup] building @aiteam/shared ...");
  const buildShared = spawnSync("pnpm", ["--filter", "@aiteam/shared", "run", "build"], {
    encoding: "utf-8", timeout: 60_000, cwd: process.cwd(),
  });
  if (buildShared.error || buildShared.status !== 0) {
    throw new Error(`@aiteam/shared build failed: ${buildShared.error?.message ?? buildShared.stderr ?? buildShared.stdout}`);
  }
  console.log("[globalSetup] @aiteam/shared built");

  // 1. seed E2E 租户（manager/agent 登录前置）。tenant_id 注入 env 供 defaultCredentials 复用。
  const seed = seedE2eTenant();
  if (seed?.tenant_id) {
    process.env.E2E_TENANT_ID = seed.tenant_id;
  }

  // 2. 三端 API 登录产出 storageState。
  await Promise.all(
    TIERS.map(async (tier) => {
      const result = await loginTier(tier, seed?.tenant_id);
      if (result?.token) {
        writeStorageState(tier, result.token, result.claims);
        console.log(`[globalSetup] ${tier} storageState 已产出`);
      }
    }),
  );
}
