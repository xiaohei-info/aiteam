import { defineConfig, devices } from "@playwright/test";
import { ARTIFACT_OUTPUT_DIR, artifactReporter, artifactUse } from "./e2e/support/artifacts";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // P1-F5 artifact 基线集中在 e2e/support/artifacts.ts（report/trace/screenshot/video）。
  reporter: artifactReporter(isCI),
  outputDir: ARTIFACT_OUTPUT_DIR,
  use: {
    ...artifactUse(),
  },
  projects: [
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
  ],
  webServer: [
    {
      command:
        "cd .. && OPERATION_SYSTEM_USERNAME=sysadmin OPERATION_SYSTEM_PASSWORD=changeme-me .venv/bin/python server/run.py --tier operation --host 127.0.0.1 --port 8000",
      url: "http://127.0.0.1:8000/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "cd .. && .venv/bin/python server/run.py --tier manager --host 127.0.0.1 --port 8001",
      url: "http://127.0.0.1:8001/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "cd .. && .venv/bin/python server/run.py --tier agent --host 127.0.0.1 --port 8180",
      url: "http://127.0.0.1:8180/healthz",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "OPERATION_API_ORIGIN=http://127.0.0.1:8000 pnpm --dir operation dev --host 127.0.0.1",
      url: "http://127.0.0.1:5173/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "MANAGER_API_ORIGIN=http://127.0.0.1:8001 pnpm --dir manager dev --host 127.0.0.1",
      url: "http://127.0.0.1:5174/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: "pnpm --dir agent dev --host 127.0.0.1",
      url: "http://127.0.0.1:5180/login",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
