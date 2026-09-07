import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createMemoryLifecycle } from "@luxusai/pi-hindsight/extensions/lifecycle/memory-lifecycle.js";
import { resolveConfig } from "@luxusai/pi-hindsight/extensions/config/config.js";
import { createAgentControlledReloadConfig, createControlledResourceLoader, hindsightConfigPath, hindsightStateDir, isMemoryPolicyEnabled, memoryToolNames, removeHindsightState, withAgentHindsightEnvironment } from "./resources.js";
import { HINDSIGHT_CLIENT_PROTOCOL, type HindsightRuntimeConfig } from "../manager-client.js";
import type { SessionAuthorization } from "./session-host.js";

function hindsightLease(bank = "a", token = "opaque-lease-secret"): HindsightRuntimeConfig {
  return {
    base_url: "https://manager.test/api/manager/hindsight",
    bank_id: `aiteam-${bank.repeat(32).slice(0, 32)}`,
    token,
    lease_id: `lease-${bank}`,
    version: 1,
    policy_revision: 1,
    allowed_operations: ["recall", "retain"],
    client_protocol: HINDSIGHT_CLIENT_PROTOCOL,
    explicit_auto_retain: false,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

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

test("controlled loader uses only the Manager lease and loads approved Hindsight tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-loader-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-agent-"));
  const previousConfigBaseUrl = process.env.HINDSIGHT_BASE_URL;
  const previousGlobalToken = process.env.HINDSIGHT_API_TOKEN;
  const hindsightOverrides = ["PI_HINDSIGHT_ENABLED", "PI_HINDSIGHT_PROJECT_BANK_ID", "PI_HINDSIGHT_USER_BANK_ID", "PI_HINDSIGHT_GLOBAL_BANK_ID"] as const;
  const previousOverrides = hindsightOverrides.map((name) => [name, process.env[name]] as const);
  process.env.HINDSIGHT_BASE_URL = "http://ambient-hindsight.test";
  process.env.HINDSIGHT_API_TOKEN = "ambient-service-token";
  process.env.PI_HINDSIGHT_ENABLED = "false";
  process.env.PI_HINDSIGHT_PROJECT_BANK_ID = "ambient-project-bank";
  process.env.PI_HINDSIGHT_USER_BANK_ID = "ambient-user-bank";
  process.env.PI_HINDSIGHT_GLOBAL_BANK_ID = "ambient-global-bank";
  try {
    mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
    const auth = authorization("member-1", "employee-1", { enabled: true, allowed_operations: ["recall", "retain"] });
    const runtime = hindsightLease();
    const loader = createControlledResourceLoader("product prompt", undefined, auth, workspace, agentDir, undefined, runtime);
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
    assert.deepEqual(memoryToolNames(auth.snapshot, runtime).join(","), "hindsight_recall,hindsight_retain");
    const recallOnly = authorization("member-1", "employee-1", { enabled: true, allowed_operations: ["recall"] });
    assert.deepEqual(memoryToolNames(recallOnly.snapshot, runtime), ["hindsight_recall"]);
    const defaultPolicy = authorization("member-1", "employee-1");
    defaultPolicy.snapshot.tool_policy = { allowed_tools: [] };
    assert.equal(isMemoryPolicyEnabled(defaultPolicy.snapshot), true);
    assert.deepEqual(memoryToolNames(defaultPolicy.snapshot, runtime), ["hindsight_recall"]);

    const configPath = hindsightConfigPath(agentDir, workspace, runtime);
    const configDir = dirname(dirname(configPath));
    assert.equal(configPath, join(configDir, ".pi", "hindsight.json"));
    assert.equal(configPath.startsWith(workspace), false);
    assert.equal(existsSync(join(workspace, ".pi", "hindsight.json")), false);
    const configText = readFileSync(configPath, "utf8");
    const config = JSON.parse(configText) as Record<string, any>;
    assert.equal(config.setupComplete, true);
    assert.equal(config.banks.project.enabled, true);
    assert.equal(config.banks.project.derive, "manual");
    assert.equal(config.banks.project.bankId, runtime.bank_id);
    assert.equal(config.banks.user.enabled, false);
    assert.equal(config.banks.global?.enabled ?? false, false);
    assert.equal(config.hindsight.baseUrl, runtime.base_url);
    assert.equal(config.hindsight.apiKey, undefined);
    assert.match(config.hindsight.apiKeyRef, /^env:AITEAM_HINDSIGHT_LEASE_[A-F0-9]{24}$/);
    assert.equal(configText.includes(runtime.token), false);
    assert.equal(configText.includes("ambient-service-token"), false);
    assert.equal(process.env[config.hindsight.apiKeyRef.slice("env:".length)], undefined);
    assert.equal(isAbsolute(config.retain.queuePath), true);
    assert.equal(dirname(config.retain.queuePath), hindsightStateDir(agentDir, workspace));
    assert.match(config.retain.queuePath, /\/retain-queue-[a-f0-9]{32}\.jsonl$/);
    assert.equal(existsSync(join(hindsightStateDir(agentDir, workspace), "retain-queue.jsonl")), false);
    writeFileSync(config.retain.queuePath, "retry\n");

    const resolved = withAgentHindsightEnvironment(() => resolveConfig(configDir, process.env));
    assert.equal(resolved.setupComplete, true);
    assert.equal(resolved.banks.project.bankId, config.banks.project.bankId);
    assert.equal(resolved.hindsight.baseUrl, runtime.base_url);
    assert.equal(resolved.hindsight.apiKey, undefined);
    const lifecycle = withAgentHindsightEnvironment(() => createMemoryLifecycle(configDir));
    assert.equal(lifecycle.deps.getConfig().setupComplete, true);
    assert.equal(lifecycle.deps.getConfig().banks.project.bankId, config.banks.project.bankId);
    assert.equal(lifecycle.deps.getConfig().hindsight.baseUrl, runtime.base_url);
    await loader.shutdown();
    await loader.shutdown();
    assert.equal(existsSync(configPath), false);
    assert.equal(readFileSync(config.retain.queuePath, "utf8"), "retry\n");
  } finally {
    if (previousConfigBaseUrl === undefined) delete process.env.HINDSIGHT_BASE_URL;
    else process.env.HINDSIGHT_BASE_URL = previousConfigBaseUrl;
    if (previousGlobalToken === undefined) delete process.env.HINDSIGHT_API_TOKEN;
    else process.env.HINDSIGHT_API_TOKEN = previousGlobalToken;
    for (const [name, value] of previousOverrides) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("controlled loader keeps Hindsight state outside the coding workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-default-workspace-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-default-agent-"));
  let loader: ReturnType<typeof createControlledResourceLoader> | undefined;
  try {
    loader = createControlledResourceLoader("product prompt", undefined, authorization("member-1", "employee-1", { enabled: true }), workspace, agentDir, undefined, hindsightLease());
    const configPath = hindsightConfigPath(agentDir, workspace, hindsightLease());
    assert.equal(configPath.startsWith(workspace), false);
    assert.equal(existsSync(configPath), true);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
    assert.equal(config.retain.queuePath.startsWith(workspace), false);
    assert.equal(existsSync(join(workspace, ".pi", "agent")), false);
    await loader.shutdown();
  } finally {
    rmSync(hindsightStateDir(agentDir, workspace), { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Agent-controlled Hindsight reload ignores ambient endpoint and credentials", () => {
  const previousBaseUrl = process.env.HINDSIGHT_BASE_URL;
  const previousRef = process.env.HINDSIGHT_API_KEY_REF;
  const previousToken = process.env.HINDSIGHT_API_TOKEN;
  const previousKey = process.env.HINDSIGHT_API_KEY;
  process.env.HINDSIGHT_BASE_URL = "http://ambient-hindsight.test";
  process.env.HINDSIGHT_API_KEY_REF = "HINDSIGHT_API_TOKEN";
  process.env.HINDSIGHT_API_TOKEN = "ambient-token";
  process.env.HINDSIGHT_API_KEY = "ambient-key";
  let reloadedCwd = "";
  try {
    const reloadConfig = createAgentControlledReloadConfig("/agent-owned/config", (cwd) => {
      reloadedCwd = cwd;
      assert.equal(process.env.HINDSIGHT_BASE_URL, undefined);
      assert.equal(process.env.HINDSIGHT_API_KEY_REF, undefined);
      assert.equal(process.env.HINDSIGHT_API_TOKEN, undefined);
      assert.equal(process.env.HINDSIGHT_API_KEY, undefined);
    });
    reloadConfig("/real/coding/workspace");
    assert.equal(reloadedCwd, "/agent-owned/config");
  } finally {
    if (previousBaseUrl === undefined) delete process.env.HINDSIGHT_BASE_URL;
    else process.env.HINDSIGHT_BASE_URL = previousBaseUrl;
    if (previousRef === undefined) delete process.env.HINDSIGHT_API_KEY_REF;
    else process.env.HINDSIGHT_API_KEY_REF = previousRef;
    if (previousToken === undefined) delete process.env.HINDSIGHT_API_TOKEN;
    else process.env.HINDSIGHT_API_TOKEN = previousToken;
    if (previousKey === undefined) delete process.env.HINDSIGHT_API_KEY;
    else process.env.HINDSIGHT_API_KEY = previousKey;
  }
});

test("Hindsight state cleanup removes failed queue state only when explicitly requested", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-cleanup-workspace-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-cleanup-agent-"));
  try {
    const loader = createControlledResourceLoader("prompt", undefined, authorization("member-1", "employee-1", { enabled: true }), workspace, agentDir, undefined, hindsightLease());
    const stateDir = hindsightStateDir(agentDir, workspace);
    const queuePath = join(stateDir, "retain-queue.jsonl");
    writeFileSync(queuePath, "retry\n");
    await loader.shutdown();
    assert.equal(readFileSync(queuePath, "utf8"), "retry\n");
    removeHindsightState(agentDir, workspace);
    assert.equal(existsSync(stateDir), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("memory defaults on, supports explicit disable, and only Manager leases select a bank", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiteam-hindsight-policy-"));
  const agentDir = mkdtempSync(join(tmpdir(), "aiteam-hindsight-agent-"));
  try {
    const disabled = authorization("member-1", "employee-1", { enabled: false });
    const disabledLoader = createControlledResourceLoader("prompt", undefined, disabled, workspace, agentDir);
    await disabledLoader.reload();
    assert.equal(isMemoryPolicyEnabled(disabled.snapshot), false);
    assert.deepEqual(disabledLoader.getExtensions().extensions, []);
    assert.equal(existsSync(hindsightConfigPath(agentDir, workspace)), false);

    const first = authorization("member-1", "employee-1", { enabled: true });
    const second = authorization("member-2", "employee-1", { enabled: true });
    const firstLease = hindsightLease("a", "lease-one-secret");
    const secondLease = hindsightLease("b", "lease-two-secret");
    const firstLoader = createControlledResourceLoader("prompt", undefined, first, workspace, agentDir, undefined, firstLease);
    await firstLoader.reload();
    const firstBank = JSON.parse(readFileSync(hindsightConfigPath(agentDir, workspace, firstLease), "utf8")).banks.project.bankId;
    const secondLoader = createControlledResourceLoader("prompt", undefined, second, workspace, agentDir, undefined, secondLease);
    await secondLoader.reload();
    const secondBank = JSON.parse(readFileSync(hindsightConfigPath(agentDir, workspace, secondLease), "utf8")).banks.project.bankId;
    assert.equal(firstBank, firstLease.bank_id);
    assert.equal(secondBank, secondLease.bank_id);
    assert.notEqual(firstBank, secondBank);
    assert.equal(readFileSync(hindsightConfigPath(agentDir, workspace, secondLease), "utf8").includes(firstLease.token), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
