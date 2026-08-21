import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createMemoryLifecycle } from "@luxusai/pi-hindsight/extensions/lifecycle/memory-lifecycle.js";
import { registerTools } from "@luxusai/pi-hindsight/extensions/operations/tools.js";
import { skillResourcePaths, skillSigningVerificationFromEnv, SkillCache } from "../skills.js";
import type { FrozenSnapshot } from "../storage/sqlite.js";
import { normalizeHindsightRuntimeConfig, type HindsightRuntimeConfig } from "../manager-client.js";
import type { SessionAuthorization } from "./session-host.js";
import { createRagMcpFactory, ragToolNames } from "./rag-mcp.js";

const HINDSIGHT_TOOLS = new Set(["hindsight_recall", "hindsight_retain"]);
const AGENT_IGNORED_HINDSIGHT_ENV = [
  "PI_HINDSIGHT_ENABLED",
  "PI_HINDSIGHT_PROJECT_BANK_ID",
  "PI_HINDSIGHT_USER_BANK_ID",
  "PI_HINDSIGHT_GLOBAL_BANK_ID",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_API_KEY_REF",
  "HINDSIGHT_API_TOKEN",
  "HINDSIGHT_API_KEY",
  "HOME",
] as const;

export interface ControlledResourceLoader extends ResourceLoader {
  /** Flush Hindsight before the owning Pi session is disposed. */
  shutdown(): Promise<void>;
}

export function hindsightStateDir(agentDir: string, workspace: string): string {
  return join(agentDir, "hindsight", createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 32));
}

export function hindsightConfigPath(agentDir: string, workspace: string): string {
  return join(hindsightStateDir(agentDir, workspace), "config", ".pi", "hindsight.json");
}

/** Remove only the state directory derived for this Agent workspace. */
export function removeHindsightState(agentDir: string, workspace: string): void {
  const stateRoot = resolve(agentDir, "hindsight");
  const stateDir = resolve(hindsightStateDir(agentDir, workspace));
  if (dirname(stateDir) !== stateRoot || !/^[0-9a-f]{32}$/.test(basename(stateDir))) return;
  rmSync(stateDir, { recursive: true, force: true });
}

const LEGACY_MEMORY_TOOLS = new Map([
  ["memory_recall", "hindsight_recall"],
  ["memory_retain", "hindsight_retain"],
]);

export function createControlledResourceLoader(
  systemPrompt: string,
  cache?: SkillCache,
  authorization?: SessionAuthorization,
  workspace = process.cwd(),
  // Hindsight config and queues are Agent state, never coding-workspace state.
  agentDir = join(homedir(), ".aiteam", "agent"),
  managerUrl = process.env.AITEAM_MANAGER_URL,
  hindsightRuntimeConfig?: HindsightRuntimeConfig,
): ControlledResourceLoader {
  const skillScope = authorization?.caller.tenantId && (authorization.caller.userId ?? authorization.caller.callerId)
    ? { tenantId: authorization.caller.tenantId, memberId: authorization.caller.userId ?? authorization.caller.callerId }
    : undefined;
  const skillRefs = authorization ? (Array.isArray(authorization.snapshot.skill_refs) ? authorization.snapshot.skill_refs.filter((ref): ref is string => typeof ref === "string") : []) : [];
  const envVerification = skillSigningVerificationFromEnv();
  const snapshotKeys = authorization && Array.isArray(authorization.snapshot.skill_signing_keys) ? authorization.snapshot.skill_signing_keys : [];
  const verification = snapshotKeys.length ? { ...envVerification, publicKeys: snapshotKeys } : envVerification;
  const memoryPolicy = authorization ? getMemoryPolicy(authorization.snapshot) : undefined;
  const leaseConfig = hindsightRuntimeConfig ? normalizeHindsightRuntimeConfig(hindsightRuntimeConfig, managerUrl) : undefined;
  const baseUrl = leaseConfig?.base_url;
  const stateDir = hindsightStateDir(agentDir, workspace);
  const configDir = join(stateDir, "config");
  const leaseEnvName = leaseConfig ? hindsightLeaseEnvName(stateDir) : undefined;
  if (authorization && memoryPolicy?.enabled && baseUrl && leaseConfig && leaseEnvName) {
    materializeHindsightConfig(configDir, stateDir, memoryPolicy, baseUrl, leaseConfig, leaseEnvName);
  }
  const skills = skillScope && cache
    ? skillResourcePaths(cache, skillScope, skillRefs, verification)
    : { skills: [], diagnostics: [] };
  const lifecycle = memoryPolicy?.enabled && baseUrl && leaseConfig && leaseEnvName
    ? createHindsightFactory(configDir, leaseEnvName, leaseConfig.token)
    : undefined;
  const rag = authorization && ragToolNames(authorization.snapshot, managerUrl).length ? createRagMcpFactory(authorization, managerUrl) : undefined;
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    skillsOverride: () => skills,
    extensionFactories: [
      ...(lifecycle ? [lifecycle.factory] : []),
      ...(rag ? [rag] : []),
    ],
  });
  let shutdownPromise: Promise<void> | undefined;
  return Object.assign(loader, {
    shutdown: async () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        await lifecycle?.shutdown();
        // Keep the queue state but remove the generated config after flushing.
        rmSync(configDir, { recursive: true, force: true });
      })();
      return shutdownPromise;
    },
  });
}

export { ragToolNames };

export function memoryToolNames(snapshot: FrozenSnapshot, hindsightRuntimeConfig?: HindsightRuntimeConfig): string[] {
  const policy = snapshot.tool_policy;
  const rawAllowed: unknown[] = policy && typeof policy === "object" && Array.isArray((policy as Record<string, unknown>).allowed_tools)
    ? (policy as Record<string, unknown>).allowed_tools as unknown[]
    : [];
  const allowed = rawAllowed.filter((name): name is string => typeof name === "string");
  const names = new Set(allowed.map((name) => LEGACY_MEMORY_TOOLS.get(name) ?? name));
  const memory = getMemoryPolicy(snapshot);
  if (!hindsightRuntimeConfig) return [];
  return [...HINDSIGHT_TOOLS].filter((name) => names.has(name) && (name === "hindsight_recall" ? memory?.recall : memory?.retain));
}

export function isMemoryPolicyEnabled(snapshot: FrozenSnapshot): boolean {
  return getMemoryPolicy(snapshot)?.enabled === true;
}

function getMemoryPolicy(snapshot: FrozenSnapshot): { enabled: boolean; recall: boolean; retain: boolean } | undefined {
  const policy = snapshot.memory_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const value = policy as Record<string, unknown>;
  if (value.enabled !== true) return { enabled: false, recall: false, retain: false };
  const operations = value.allowed_operations ?? value.operations;
  const allows = (operation: string) => !Array.isArray(operations) || operations.includes(operation);
  return {
    enabled: true,
    recall: allows("recall") && value.recall !== false && value.allow_recall !== false && value.recall_enabled !== false,
    retain: allows("retain") && value.retain !== false && value.allow_retain !== false && value.retain_enabled !== false,
  };
}

export function withAgentHindsightEnvironment<T>(callback: () => T): T {
  const previous = AGENT_IGNORED_HINDSIGHT_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of AGENT_IGNORED_HINDSIGHT_ENV) delete process.env[name];
  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export function createAgentControlledReloadConfig(
  configDir: string,
  reloadConfig: (cwd: string) => void,
  leaseEnvName?: string,
  leaseToken?: string,
): (cwd: string) => void {
  return () => withHindsightLeaseEnvironment(leaseEnvName, leaseToken, () => withAgentHindsightEnvironment(() => reloadConfig(configDir)));
}

function hindsightLeaseEnvName(stateDir: string): string {
  return `AITEAM_HINDSIGHT_LEASE_${createHash("sha256").update(stateDir).digest("hex").slice(0, 24).toUpperCase()}`;
}

function withHindsightLeaseEnvironment<T>(envName: string | undefined, token: string | undefined, callback: () => T): T {
  if (!envName || !token) return callback();
  const previous = process.env[envName];
  process.env[envName] = token;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
}

function createHindsightFactory(configDir: string, leaseEnvName?: string, leaseToken?: string) {
  const lifecycle = withHindsightLeaseEnvironment(leaseEnvName, leaseToken, () => withAgentHindsightEnvironment(() => createMemoryLifecycle(configDir)));
  const deps = {
    ...lifecycle.deps,
    reloadConfig: createAgentControlledReloadConfig(configDir, lifecycle.deps.reloadConfig, leaseEnvName, leaseToken),
  };
  let context: ExtensionContext | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const factory = (pi: ExtensionAPI) => {
    const restrictedPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: ToolDefinition) => {
            if (!HINDSIGHT_TOOLS.has(tool.name)) return;
            const parameters = tool.parameters as Record<string, unknown>;
            const properties = parameters.properties && typeof parameters.properties === "object"
              ? { ...(parameters.properties as Record<string, unknown>) }
              : undefined;
            if (properties) delete properties.bank;
            target.registerTool({
              ...tool,
              parameters: properties ? { ...parameters, properties } : tool.parameters,
              execute: async (id, params, signal, onUpdate, ctx) => tool.execute(id, { ...(params as Record<string, unknown>), bank: undefined }, signal, onUpdate, ctx),
            } as ToolDefinition);
          };
        }
        if (property === "registerCommand") return () => undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    registerTools(restrictedPi, deps);
    pi.on("session_start", async (_event, ctx) => {
      context = ctx;
      // Config reload must use the Agent-controlled directory; runtime events retain
      // the real workspace context for session identity and UI.
      const initialization = withHindsightLeaseEnvironment(leaseEnvName, leaseToken, () => withAgentHindsightEnvironment(() => lifecycle.initialize({ ...ctx, cwd: configDir })));
      await initialization;
    });
    pi.on("context", async (event, ctx) => lifecycle.recall(event, ctx));
    pi.on("agent_end", async (event, ctx) => { await lifecycle.retain(event, ctx); });
    pi.on("session_shutdown", async (_event, ctx) => shutdown(ctx));
  };
  const shutdown = async (ctx?: ExtensionContext) => {
    if (ctx) context = ctx;
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = context ? lifecycle.shutdown(context) : Promise.resolve();
    return shutdownPromise;
  };
  return { factory, shutdown: () => shutdown() };
}

function materializeHindsightConfig(
  configDir: string,
  stateDir: string,
  policy: { recall: boolean; retain: boolean },
  baseUrl: string,
  runtimeConfig: HindsightRuntimeConfig,
  leaseEnvName: string,
): void {
  mkdirSync(join(configDir, ".pi"), { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  chmodSync(join(configDir, ".pi"), 0o700);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const bankId = runtimeConfig.bank_id;
  const tokenRef = `env:${leaseEnvName}`;
  const config = {
    enabled: true,
    setupComplete: true,
    scope: { mode: "isolated-bank", projectIdStrategy: "basename", includeSharedObservations: false },
    hindsight: {
      baseUrl,
      timeoutMs: 1_000,
      apiKeyRef: tokenRef,
    },
    banks: { project: { enabled: true, derive: "manual", bankId }, user: { enabled: false } },
    recall: { enabled: policy.recall, budget: "low", maxTokens: 600, topK: 6, timeoutMs: 1_000 },
    retain: { enabled: policy.retain, async: true, delivery: "coalesced", queuePath: join(stateDir, "retain-queue.jsonl"), shutdownFlushMaxJobs: 1, shutdownFlushTimeoutMs: 1_000 },
    notifications: { startup: false, recall: false, retain: false },
  };
  const configPath = join(configDir, ".pi", "hindsight.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}
