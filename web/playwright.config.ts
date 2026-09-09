import { defineConfig, devices } from "@playwright/test";
import { ARTIFACT_OUTPUT_DIR, artifactReporter, artifactUse } from "./e2e/support/artifacts";

const isCI = Boolean(process.env.CI);
const external = process.env.E2E_EXTERNAL === "true";

/**
 * AITEAM-224 三端 BE2E 基座配置（最终执行 DAG §5.1）。
 *
 * - globalSetup：seed E2E 租户 + 三端 API 登录产出 storageState（见 e2e/support/globalSetup.ts）。
 * - webServer：拉起三端后端（operation/manager/agent）+ 三端前端 dev server。
 *   manager 需 DB_URL/ADMIN_DB_URL（多租户 PG/RLS）；agent 需 MANAGER_URL（跨端登录）。
 *   env 默认值对齐 .env.example / 单机部署 SOP；经环境变量覆盖（CI/不同部署）。
 * - projects：三端单端 smoke（operation/manager/agent），testMatch 按目录隔离。
 */

// manager/agent 跨端依赖的 DB 与服务地址（dev 默认；env 可覆盖）。
const DB_URL = process.env.DB_URL ?? "postgresql://app_rw:aiteam_dev@127.0.0.1:5433/manager_control_db";
const ADMIN_DB_URL = process.env.ADMIN_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db";
const OPERATION_DB_URL = process.env.OPERATION_DB_URL ?? "postgresql://app_rw:aiteam_dev@127.0.0.1:5433/operation_control_db";
const OPERATION_ADMIN_DB_URL = process.env.OPERATION_ADMIN_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5433/operation_control_db";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "test-service-token";
const OPERATION_SYSTEM_USERNAME = process.env.OPERATION_SYSTEM_USERNAME ?? "sysadmin";
const OPERATION_SYSTEM_PASSWORD = process.env.OPERATION_SYSTEM_PASSWORD ?? "changeme-me";
const MANAGER_URL = process.env.MANAGER_URL ?? "http://127.0.0.1:8001";
const OPERATOR_URL = process.env.OPERATOR_URL ?? "http://127.0.0.1:8000";
const E2E_PYTHON = process.env.E2E_PYTHON ?? ".venv/bin/python";
const OPERATION_UI_ORIGIN = process.env.E2E_OPERATION_UI_ORIGIN ?? "http://127.0.0.1:5173";
const MANAGER_UI_ORIGIN = process.env.E2E_MANAGER_UI_ORIGIN ?? "http://localhost:5174";
const MANAGER_TENANT_ID = process.env.MANAGER_TENANT_ID ?? process.env.E2E_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";
const AGENT_UI_ORIGIN = process.env.E2E_AGENT_UI_ORIGIN ?? "http://127.0.0.1:5180";
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const pythonCommand = shellQuote(E2E_PYTHON);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // globalSetup：seed 租户 + 产出 storageState（在 webServer 起来后跑）。
  globalSetup: "./e2e/support/globalSetup.ts",
  // P1-F5 artifact 基线集中在 e2e/support/artifacts.ts（report/trace/screenshot/video）。
  reporter: artifactReporter(isCI),
  outputDir: ARTIFACT_OUTPUT_DIR,
  use: {
    ...artifactUse(),
  },
  projects: [
    {
      name: "harness",
      testMatch: /support\/__tests__\/.*\.test\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "operation-smoke",
      testMatch: /operation\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: OPERATION_UI_ORIGIN },
    },
    {
      name: "manager-smoke",
      testMatch: /manager\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: MANAGER_UI_ORIGIN },
    },
    {
      name: "agent-smoke",
      testMatch: /agent\/.*\.spec\.ts/,
      // Chat screenshots and local Agent SQLite state are shared by the Agent
      // smoke files; serialize them so earlier prompt tests cannot mutate the
      // conversation list while the visual fixture is captured.
      fullyParallel: false,
      workers: 1,
      use: { ...devices["Desktop Chrome"], baseURL: AGENT_UI_ORIGIN },
    },
    {
      name: "cross-tier",
      testMatch: /cross-tier\/.*\.spec\.ts/,
      // Cross-tier tests share one seeded PG/Agent projection and intentionally
      // exercise mutations (provision, grants, usage). Parallel workers make
      // those tests race and turn valid product behavior into stale 403/500s.
      fullyParallel: false,
      workers: 1,
      // Finish the standalone tier smoke projects first. They use the same
      // seeded Agent SQLite/Manager tenant; running cross-tier mutations while
      // Agent smoke prompts are still settling races the hourly usage outbox.
      dependencies: ["operation-smoke", "manager-smoke", "agent-smoke"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: external ? undefined : [
    {
      command: `cd .. && ${pythonCommand} server/run.py --tier operation --host 127.0.0.1 --port 8000`,
      env: {
        AITEAM_ENV: "test",
        OPERATION_SYSTEM_USERNAME,
        OPERATION_SYSTEM_PASSWORD,
        OPERATION_DB_URL,
        OPERATION_ADMIN_DB_URL,
        MANAGER_URL,
        SERVICE_TOKEN,
      },
      url: "http://127.0.0.1:8000/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: `cd .. && ${pythonCommand} server/run.py --tier manager --host 127.0.0.1 --port 8001`,
      env: {
        AITEAM_ENV: "test",
        MANAGER_PUBLIC_ORIGIN: MANAGER_UI_ORIGIN,
        MANAGER_TENANT_ID,
        DB_URL,
        ADMIN_DB_URL,
        SERVICE_TOKEN,
        OPERATOR_URL,
      },
      url: "http://127.0.0.1:8001/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "cd .. && pnpm --dir server/agent_service start",
      env: {
        PORT: "8180",
        HOST: "127.0.0.1",
        AITEAM_ENV: "development",
        AITEAM_PI_FAKE: "true",
        AITEAM_AGENT_DEV_AUTH: "true",
        AITEAM_MANAGER_URL: MANAGER_URL,
        AITEAM_AGENT_DATA_DIR: "./.state/e2e-agent",
      },
      url: "http://127.0.0.1:8180/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "pnpm --dir operation dev --host 127.0.0.1",
      env: { OPERATION_API_ORIGIN: "http://127.0.0.1:8000" },
      url: "http://127.0.0.1:5173/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "pnpm --dir manager dev --host 127.0.0.1",
      env: { MANAGER_API_ORIGIN: "http://127.0.0.1:8001" },
      url: `${MANAGER_UI_ORIGIN}/login`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: `pnpm --dir agent dev --host 127.0.0.1`,
      url: "http://127.0.0.1:5180/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
