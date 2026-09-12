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
import { createRecallTurnPolicy } from "@luxusai/pi-hindsight/extensions/lifecycle/memory-lifecycle-recall.js";
import { notify, setMemoryStatus, snapshotRuntime } from "@luxusai/pi-hindsight/extensions/lifecycle/memory-lifecycle-runtime.js";
import { isMemorySetupComplete } from "@luxusai/pi-hindsight/extensions/config/setup-gate.js";
import { registerTools } from "@luxusai/pi-hindsight/extensions/operations/tools.js";
import { skillRefsForSnapshot, skillResourcePaths, skillSigningVerificationForSnapshot, SkillCache } from "../skills.js";
import type { FrozenSnapshot } from "../storage/sqlite.js";
import { HINDSIGHT_CLIENT_PROTOCOL, normalizeHindsightRuntimeConfig, type HindsightRuntimeConfig } from "../manager-client.js";
import type { SessionAuthorization } from "./session-host.js";
import { ApprovalService } from "../approval-service.js";
import { createRagMcpFactory, ragToolNames } from "./rag-mcp.js";

const HINDSIGHT_TOOLS = new Set(["hindsight_recall", "hindsight_retain"]);
const DEFAULT_MEMORY_TOOLS = ["hindsight_recall", "hindsight_retain"] as const;
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

export function hindsightConfigPath(agentDir: string, workspace: string, lease?: HindsightRuntimeConfig): string {
  const root = join(hindsightStateDir(agentDir, workspace), "config");
  // Legacy config is never loaded. Each current lease owns its generated file so
  // an older lifecycle's reload/shutdown cannot borrow a replacement's queue/key.
  const scope = lease ? createHash("sha256").update(JSON.stringify([
    "consent-v1", lease.lease_id, lease.version, lease.policy_revision, lease.client_protocol,
  ])).digest("hex").slice(0, 32) : undefined;
  return join(scope ? join(root, scope) : root, ".pi", "hindsight.json");
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
  approvalService?: ApprovalService,
  conversationId?: string,
  sessionId?: string,
  onAccessDenied?: (error: unknown) => void,
): ControlledResourceLoader {
  const skillScope = authorization?.caller.tenantId && (authorization.caller.userId ?? authorization.caller.callerId)
    ? { tenantId: authorization.caller.tenantId, memberId: authorization.caller.userId ?? authorization.caller.callerId }
    : undefined;
  const skillRefs = authorization ? skillRefsForSnapshot(authorization.snapshot) : [];
  if (skillRefs.length && (!skillScope || !cache)) throw new Error("Required signed skill cache is unavailable; sync with Manager");
  const verification = authorization
    ? skillSigningVerificationForSnapshot(authorization.snapshot)
    : skillSigningVerificationForSnapshot({});
  const skills = skillScope && cache
    ? skillResourcePaths(cache, skillScope, skillRefs, verification)
    : { skills: [], diagnostics: [] };
  const leaseConfig = hindsightRuntimeConfig ? normalizeHindsightRuntimeConfig(hindsightRuntimeConfig, managerUrl) : undefined;
  const memoryPolicy = authorization ? getMemoryPolicy(authorization.snapshot, leaseConfig) : undefined;
  const baseUrl = leaseConfig?.base_url;
  const stateDir = hindsightStateDir(agentDir, workspace);
  const configDir = dirname(dirname(hindsightConfigPath(agentDir, workspace, leaseConfig)));
  const leaseEnvName = leaseConfig ? hindsightLeaseEnvName(configDir) : undefined;
  if (authorization && memoryPolicy?.enabled && baseUrl && leaseConfig && leaseEnvName) {
    const queueScope = createHash("sha256").update(JSON.stringify([
      "consent-v1", authorization.caller.tenantId, authorization.caller.userId ?? authorization.caller.callerId,
      authorization.employeeId, leaseConfig.bank_id, leaseConfig.client_protocol, leaseConfig.policy_revision,
      leaseConfig.lease_id, leaseConfig.version, memoryPolicy.autoRetain,
    ])).digest("hex").slice(0, 32);
    materializeHindsightConfig(configDir, stateDir, memoryPolicy, baseUrl, leaseConfig, leaseEnvName, queueScope);
  }
  const lifecycle = memoryPolicy?.enabled && baseUrl && leaseConfig && leaseEnvName
    ? createHindsightFactory(configDir, memoryPolicy, leaseEnvName, leaseConfig.token, {
      authorization, approvalService, conversationId, sessionId, onAccessDenied,
    })
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
        if (lifecycle) rmSync(configDir, { recursive: true, force: true });
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
  let allowed = rawAllowed.filter((name): name is string => typeof name === "string");
  const memory = getMemoryPolicy(snapshot, hindsightRuntimeConfig);
  if (allowed.length === 0 && memory?.enabled) allowed = [...DEFAULT_MEMORY_TOOLS];
  const names = new Set(allowed.map((name) => LEGACY_MEMORY_TOOLS.get(name) ?? name));
  if (!hindsightRuntimeConfig) return [];
  return [...HINDSIGHT_TOOLS].filter((name) => names.has(name) && (name === "hindsight_recall" ? memory?.recall : memory?.retain));
}

export function isMemoryPolicyEnabled(snapshot: FrozenSnapshot): boolean {
  return getMemoryPolicy(snapshot)?.enabled === true;
}

interface MemoryPolicy { enabled: boolean; recall: boolean; retain: boolean; autoRetain: boolean; factOnly: boolean }

function getMemoryPolicy(snapshot: FrozenSnapshot, lease?: HindsightRuntimeConfig): MemoryPolicy | undefined {
  const policy = snapshot.memory_policy;
  // Unknown legacy defaults never authorize automatic conversation export.
  if (policy === undefined || policy === null) {
    const recall = !lease?.allowed_operations || lease.allowed_operations.includes("recall");
    return { enabled: recall, recall, retain: false, autoRetain: false, factOnly: lease?.retention_mode === "fact_only" };
  }
  if (typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const value = policy as Record<string, unknown>;
  if (value.enabled !== true) return { enabled: false, recall: false, retain: false, autoRetain: false, factOnly: false };
  const operations = value.allowed_operations ?? value.operations ?? ["recall"];
  const allows = (operation: "recall" | "retain") => Array.isArray(operations) && operations.includes(operation)
    && (!lease?.allowed_operations || lease.allowed_operations.includes(operation));
  const recall = allows("recall") && value.recall !== false && value.allow_recall !== false && value.recall_enabled !== false;
  const retain = allows("retain") && (!lease || (lease.client_protocol === HINDSIGHT_CLIENT_PROTOCOL
    && Array.isArray(lease.allowed_operations) && Number.isSafeInteger(lease.policy_revision) && (lease.policy_revision ?? 0) > 0))
    && value.retain !== false && value.allow_retain !== false && value.retain_enabled !== false;
  return { enabled: recall || retain, recall, retain,
    autoRetain: retain && value.explicit_auto_retain === true && lease?.explicit_auto_retain === true
      && lease.client_protocol === HINDSIGHT_CLIENT_PROTOCOL,
    factOnly: lease?.retention_mode === "fact_only" || value.retention_guarded === true || typeof value.retention_days === "number" };
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

function createHindsightFactory(
  configDir: string,
  policy: MemoryPolicy,
  leaseEnvName?: string,
  leaseToken?: string,
  contextOptions: {
    authorization?: SessionAuthorization;
    approvalService?: ApprovalService;
    conversationId?: string;
    sessionId?: string;
    onAccessDenied?: (error: unknown) => void;
  } = {},
) {
  const lifecycle = withHindsightLeaseEnvironment(leaseEnvName, leaseToken, () => withAgentHindsightEnvironment(() => createMemoryLifecycle(configDir)));
  const deps = {
    ...lifecycle.deps,
    reloadConfig: createAgentControlledReloadConfig(configDir, lifecycle.deps.reloadConfig, leaseEnvName, leaseToken),
  };
  let context: ExtensionContext | undefined;
  let shutdownPromise: Promise<void> | undefined;
  // Only identity of this loader's context-only injections, never copied memory
  // text or guesses based on a user's <hindsight-memory> text.
  const injectedMessages = new WeakSet<object>();
  const factory = (pi: ExtensionAPI) => {
    const restrictedPi = new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") {
          return (tool: ToolDefinition) => {
            if (!HINDSIGHT_TOOLS.has(tool.name)) return;
            if (tool.name === "hindsight_recall" ? !policy.recall : !policy.retain) return;
            const parameters = tool.parameters as Record<string, unknown>;
            const properties = parameters.properties && typeof parameters.properties === "object"
              ? { ...(parameters.properties as Record<string, unknown>) }
              : undefined;
            if (properties) delete properties.bank;
            target.registerTool({
              ...tool,
              parameters: properties ? { ...parameters, properties } : tool.parameters,
              execute: async (id, params, signal, onUpdate, ctx) => {
                const invoke = () => tool.execute(id, { ...(params as Record<string, unknown>), bank: undefined }, signal, onUpdate, ctx);
                try {
                  if (tool.name !== "hindsight_retain" || !contextOptions.approvalService || !contextOptions.authorization || !contextOptions.conversationId || !contextOptions.sessionId) return await invoke();
                  const caller = contextOptions.authorization.caller;
                  return await contextOptions.approvalService.execute({
                    tenantId: caller.tenantId ?? "",
                    memberId: caller.userId ?? caller.callerId,
                    conversationId: contextOptions.conversationId,
                    participantEmployeeId: contextOptions.authorization.employeeId,
                    sessionId: contextOptions.sessionId,
                    snapshotVersion: contextOptions.authorization.snapshot.snapshot_version,
                    permissionRevision: `${contextOptions.authorization.snapshot.version}:memory`,
                    toolCallId: id,
                    promptReceiptRef: contextOptions.conversationId,
                    toolName: tool.name,
                    args: params,
                    riskLevel: "external",
                    permissionMode: contextOptions.authorization.permissionMode ?? "read-only",
                    expiresAt: authorizationExpiry(contextOptions.authorization),
                    signal,
                  }, invoke);
                } catch (error) {
                  contextOptions.onAccessDenied?.(error);
                  throw error;
                }
              },
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
    pi.on("context", async (event, ctx) => {
      const messages = event.messages.filter((message) => !injectedMessages.has(message));
      const runtime = snapshotRuntime(ctx);
      const config = deps.getConfig();
      if (!runtime || !config.enabled || !config.recall.enabled || !isMemorySetupComplete(config, runtime.cwd)) return { messages };
      // A fresh SDK policy means no reuse of its 60s recall cache across Manager
      // expiry/revocation. Keep the pinned parser, renderer and error behavior.
      const recall = createRecallTurnPolicy({
        getConfig: deps.getConfig, getClient: deps.getClient, notify,
        setMemoryStatus: (current, activity, memoryCount) => setMemoryStatus({
          runtime: current, config: deps.getConfig(), projectBankId: deps.getProjectBankId(), activity, memoryCount,
        }),
      });
      let result;
      try {
        result = await recall.recall({ messages }, runtime);
      } catch (error) {
        contextOptions.onAccessDenied?.(error);
        throw error;
      }
      for (const message of result?.messages ?? []) {
        if (!messages.includes(message)) injectedMessages.add(message);
      }
      return result ?? { messages };
    });
    if (policy.autoRetain) pi.on("agent_end", async (event, ctx) => {
      try { await lifecycle.retain(event, ctx); }
      catch (error) { contextOptions.onAccessDenied?.(error); throw error; }
    });
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

function authorizationExpiry(authorization: SessionAuthorization): number | undefined {
  const jwt = typeof authorization.caller.claims?.exp === "number" && Number.isFinite(authorization.caller.claims.exp)
    ? authorization.caller.claims.exp * 1_000
    : undefined;
  const values = [jwt, authorization.runtimeExpiresAt, authorization.hindsightExpiresAt].filter((value): value is number => value !== undefined && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function materializeHindsightConfig(
  configDir: string,
  stateDir: string,
  policy: MemoryPolicy,
  baseUrl: string,
  runtimeConfig: HindsightRuntimeConfig,
  leaseEnvName: string,
  queueScope: string,
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
    mentalModels: { inject: false },
    recall: { enabled: policy.recall, budget: "low", maxTokens: 600, topK: 6, timeoutMs: 1_000,
      ...(policy.factOnly ? { types: ["world", "experience"], preferObservations: false, includeSourceFacts: false } : {}),
    },
    retain: { enabled: policy.retain, async: true, delivery: "coalesced", queuePath: join(stateDir, `retain-queue-${queueScope}.jsonl`), shutdownFlushMaxJobs: 1, shutdownFlushTimeoutMs: 1_000 },
    notifications: { startup: false, recall: false, retain: false },
  };
  const configPath = join(configDir, ".pi", "hindsight.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}
