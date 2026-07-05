import { defineConfig, devices } from "@playwright/test";
import { ARTIFACT_OUTPUT_DIR, artifactReporter, artifactUse } from "./e2e/support/artifacts";

const isCI = Boolean(process.env.CI);

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
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "test-service-token";
const OPERATION_SYSTEM_USERNAME = process.env.OPERATION_SYSTEM_USERNAME ?? "sysadmin";
const OPERATION_SYSTEM_PASSWORD = process.env.OPERATION_SYSTEM_PASSWORD ?? "changeme-me";
const MANAGER_URL = process.env.MANAGER_URL ?? "http://127.0.0.1:8001";
const OPERATOR_URL = process.env.OPERATOR_URL ?? "http://127.0.0.1:8000";

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
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5173" },
    },
    {
      name: "manager-smoke",
      testMatch: /manager\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5174" },
    },
    {
      name: "agent-smoke",
      testMatch: /agent\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5180" },
    },
    {
      name: "cross-tier",
      testMatch: /cross-tier\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command:
        `cd .. && OPERATION_SYSTEM_USERNAME=${OPERATION_SYSTEM_USERNAME} OPERATION_SYSTEM_PASSWORD=${OPERATION_SYSTEM_PASSWORD} MANAGER_URL=${MANAGER_URL} SERVICE_TOKEN=${SERVICE_TOKEN} .venv/bin/python server/run.py --tier operation --host 127.0.0.1 --port 8000`,
      url: "http://127.0.0.1:8000/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command:
        `cd .. && DB_URL=${DB_URL} ADMIN_DB_URL=${ADMIN_DB_URL} SERVICE_TOKEN=${SERVICE_TOKEN} OPERATOR_URL=${OPERATOR_URL} .venv/bin/python server/run.py --tier manager --host 127.0.0.1 --port 8001`,
      url: "http://127.0.0.1:8001/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command:
        `cd .. && MANAGER_URL=${MANAGER_URL} SERVICE_TOKEN=${SERVICE_TOKEN} .venv/bin/python server/run.py --tier agent --host 127.0.0.1 --port 8180`,
      url: "http://127.0.0.1:8180/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: `OPERATION_API_ORIGIN=http://127.0.0.1:8000 pnpm --dir operation dev --host 127.0.0.1`,
      url: "http://127.0.0.1:5173/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: `MANAGER_API_ORIGIN=http://127.0.0.1:8001 pnpm --dir manager dev --host 127.0.0.1`,
      url: "http://127.0.0.1:5174/login",
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
