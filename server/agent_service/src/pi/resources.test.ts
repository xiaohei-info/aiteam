import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createMemoryLifecycle } from "@luxusai/pi-hindsight/extensions/lifecycle/memory-lifecycle.js";
import { resolveConfig } from "@luxusai/pi-hindsight/extensions/config/config.js";
import { createAgentControlledReloadConfig, createControlledResourceLoader, hindsightConfigPath, hindsightStateDir, isMemoryPolicyEnabled, memoryToolNames, removeHindsightState, withAgentHindsightEnvironment } from "./resources.js";
import type { SessionAuthorization } from "./session-host.js";

function authorization(memberId: string, employeeId: string, memory_policy?: Record<string, unknown>): SessionAuthorization {
  return {
    caller: { callerId: memberId, userId: memberId, tenantId: "tenant-1", accessToken: "test" },
    employeeId,
    snapshot: {
      employee_id: employeeId,
      version: "1",
      snapshot_version: "snapshot-1",
      display_name: employeeId,
      memory_policy,
      tool_policy: { allowed_tools: ["memory_recall", "memory_retain"] },
    },
  };
}

test("controlled loader keeps ambient resources out and loads only approved Hindsight tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-loader-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-agent-"));
  const previousUrl = process.env.AITEAM_HINDSIGHT_URL;
  const previousConfigBaseUrl = process.env.HINDSIGHT_BASE_URL;
  const hindsightOverrides = ["PI_HINDSIGHT_ENABLED", "PI_HINDSIGHT_PROJECT_BANK_ID", "PI_HINDSIGHT_USER_BANK_ID", "PI_HINDSIGHT_GLOBAL_BANK_ID"] as const;
  const previousOverrides = hindsightOverrides.map((name) => [name, process.env[name]] as const);
  process.env.AITEAM_HINDSIGHT_URL = "http://hindsight.test";
  process.env.HINDSIGHT_BASE_URL = "http://ambient-hindsight.test";
  process.env.PI_HINDSIGHT_ENABLED = "false";
  process.env.PI_HINDSIGHT_PROJECT_BANK_ID = "ambient-project-bank";
  process.env.PI_HINDSIGHT_USER_BANK_ID = "ambient-user-bank";
  process.env.PI_HINDSIGHT_GLOBAL_BANK_ID = "ambient-global-bank";
  try {
    mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
    const auth = authorization("member-1", "employee-1", { enabled: true });
    const loader = createControlledResourceLoader("product prompt", undefined, auth, workspace, agentDir);
    await loader.reload();
    const extensions = loader.getExtensions().extensions;
    assert.equal(extensions.length, 1);
    const names = [...extensions[0]!.tools.keys()];
    assert.deepEqual(names, ["hindsight_recall", "hindsight_retain"]);
    assert.deepEqual(loader.getPrompts().prompts, []);
    assert.deepEqual(loader.getThemes().themes, []);
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.equal(loader.getSystemPrompt(), "product prompt");
    assert.equal(names.includes("hindsight_bank"), false);
    assert.equal(names.includes("hindsight_retain_global"), false);
    assert.equal(memoryToolNames(auth.snapshot).join(","), "hindsight_recall,hindsight_retain");
    const recallOnly = authorization("member-1", "employee-1", { enabled: true, allowed_operations: ["recall"] });
    assert.deepEqual(memoryToolNames(recallOnly.snapshot), ["hindsight_recall"]);

    const configPath = hindsightConfigPath(agentDir, workspace);
    const configDir = join(hindsightStateDir(agentDir, workspace), "config");
    assert.equal(configPath, join(configDir, ".pi", "hindsight.json"));
    assert.equal(configPath.startsWith(workspace), false);
    assert.equal(existsSync(join(workspace, ".pi", "hindsight.json")), false);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    assert.equal(config.setupComplete, true);
    assert.equal(config.banks.project.enabled, true);
    assert.equal(config.banks.project.derive, "manual");
    assert.equal(config.banks.user.enabled, false);
    assert.equal(config.banks.global?.enabled ?? false, false);
    assert.match(config.banks.project.bankId, /^aiteam-[0-9a-f]{32}$/);
    assert.equal(config.hindsight.baseUrl, "http://hindsight.test");
    assert.equal(config.hindsight.apiKey, undefined);
    assert.equal(isAbsolute(config.retain.queuePath), true);
    assert.equal(config.retain.queuePath, join(hindsightStateDir(agentDir, workspace), "retain-queue.jsonl"));
    writeFileSync(config.retain.queuePath, "retry\n");

    const resolved = withAgentHindsightEnvironment(() => resolveConfig(configDir, process.env));
    const lifecycle = withAgentHindsightEnvironment(() => createMemoryLifecycle(configDir));
    for (const loaded of [resolved, lifecycle.deps.getConfig()]) {
      assert.equal(loaded.setupComplete, true);
      assert.equal(loaded.banks.project.bankId, config.banks.project.bankId);
      assert.equal(loaded.hindsight.baseUrl, "http://hindsight.test");
    }
    await loader.shutdown();
    await loader.shutdown();
    assert.equal(existsSync(configPath), false);
    assert.equal(readFileSync(config.retain.queuePath, "utf8"), "retry\n");
  } finally {
    if (previousUrl === undefined) delete process.env.AITEAM_HINDSIGHT_URL;
    else process.env.AITEAM_HINDSIGHT_URL = previousUrl;
    if (previousConfigBaseUrl === undefined) delete process.env.HINDSIGHT_BASE_URL;
    else process.env.HINDSIGHT_BASE_URL = previousConfigBaseUrl;
    for (const [name, value] of previousOverrides) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("controlled loader defaults Hindsight state outside the coding workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-default-workspace-"));
  const agentDir = join(homedir(), ".aiteam", "agent");
  const previousUrl = process.env.AITEAM_HINDSIGHT_URL;
  process.env.AITEAM_HINDSIGHT_URL = "http://hindsight.test";
  let loader: ReturnType<typeof createControlledResourceLoader> | undefined;
  try {
    loader = createControlledResourceLoader("product prompt", undefined, authorization("member-1", "employee-1", { enabled: true }), workspace);
    const configPath = hindsightConfigPath(agentDir, workspace);
    assert.equal(configPath.startsWith(workspace), false);
    assert.equal(existsSync(configPath), true);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    assert.equal(config.retain.queuePath.startsWith(workspace), false);
    assert.equal(existsSync(join(workspace, ".pi", "agent")), false);
    await loader.shutdown();
  } finally {
    if (previousUrl === undefined) delete process.env.AITEAM_HINDSIGHT_URL;
    else process.env.AITEAM_HINDSIGHT_URL = previousUrl;
    rmSync(hindsightStateDir(agentDir, workspace), { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Agent-controlled Hindsight reload ignores ambient endpoint and runtime workspace path", () => {
  const previousUrl = process.env.HINDSIGHT_BASE_URL;
  process.env.HINDSIGHT_BASE_URL = "http://ambient-hindsight.test";
  let reloadedCwd = "";
  try {
    const reloadConfig = createAgentControlledReloadConfig("/agent-owned/config", (cwd) => {
      reloadedCwd = cwd;
      assert.equal(process.env.HINDSIGHT_BASE_URL, undefined);
    });
    reloadConfig("/real/coding/workspace");
    assert.equal(reloadedCwd, "/agent-owned/config");
  } finally {
    if (previousUrl === undefined) delete process.env.HINDSIGHT_BASE_URL;
    else process.env.HINDSIGHT_BASE_URL = previousUrl;
  }
});

test("Hindsight state cleanup removes failed queue state only when explicitly requested", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-cleanup-workspace-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-cleanup-agent-"));
  const previousUrl = process.env.AITEAM_HINDSIGHT_URL;
  process.env.AITEAM_HINDSIGHT_URL = "http://hindsight.test";
  try {
    const loader = createControlledResourceLoader("prompt", undefined, authorization("member-1", "employee-1", { enabled: true }), workspace, agentDir);
    const stateDir = hindsightStateDir(agentDir, workspace);
    const queuePath = join(stateDir, "retain-queue.jsonl");
    writeFileSync(queuePath, "retry\n");
    await loader.shutdown();
    assert.equal(readFileSync(queuePath, "utf8"), "retry\n");
    removeHindsightState(agentDir, workspace);
    assert.equal(existsSync(stateDir), false);
  } finally {
    if (previousUrl === undefined) delete process.env.AITEAM_HINDSIGHT_URL;
    else process.env.AITEAM_HINDSIGHT_URL = previousUrl;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("memory policy must explicitly enable the extension and bank identity is tenant/member/employee scoped", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-policy-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-agent-"));
  const previousUrl = process.env.AITEAM_HINDSIGHT_URL;
  process.env.AITEAM_HINDSIGHT_URL = "http://hindsight.test";
  try {
    const disabled = authorization("member-1", "employee-1", { enabled: false });
    const disabledLoader = createControlledResourceLoader("prompt", undefined, disabled, workspace, agentDir);
    await disabledLoader.reload();
    assert.equal(isMemoryPolicyEnabled(disabled.snapshot), false);
    assert.deepEqual(disabledLoader.getExtensions().extensions, []);
    assert.equal(existsSync(hindsightConfigPath(agentDir, workspace)), false);

    const first = authorization("member-1", "employee-1", { enabled: true });
    const second = authorization("member-2", "employee-1", { enabled: true });
    const firstLoader = createControlledResourceLoader("prompt", undefined, first, workspace, agentDir);
    await firstLoader.reload();
    const firstBank = JSON.parse(readFileSync(hindsightConfigPath(agentDir, workspace), "utf8")).banks.project.bankId;
    const secondLoader = createControlledResourceLoader("prompt", undefined, second, workspace, agentDir);
    await secondLoader.reload();
    const secondBank = JSON.parse(readFileSync(hindsightConfigPath(agentDir, workspace), "utf8")).banks.project.bankId;
    assert.notEqual(firstBank, secondBank);
  } finally {
    if (previousUrl === undefined) delete process.env.AITEAM_HINDSIGHT_URL;
    else process.env.AITEAM_HINDSIGHT_URL = previousUrl;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
