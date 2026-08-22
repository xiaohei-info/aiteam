import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
  type SessionEntry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { AuthenticatedCaller } from "../http/auth.js";
import type { HindsightRuntimeConfig, ManagerClient } from "../manager-client.js";
import type { AgentSqliteStore, FrozenSnapshot } from "../storage/sqlite.js";
import { createDelegateEmployeeTool, type DelegateEmployeeInput } from "../tools/delegate.js";
import { serializePiEvent } from "./event-sse.js";
import type { UsageCapture } from "../usage.js";
import { LocalSandbox } from "./sandbox.js";
import { registerRuntimeProvider } from "./model-runtime.js";
import { isMemoryPolicyEnabled, memoryToolNames, ragToolNames, removeHindsightState, type ControlledResourceLoader } from "./resources.js";

export interface PiEventEnvelope {
  id: string;
  event: AgentSessionEvent;
  conversation_id?: string;
  source_ref?: string;
  tool_call_id?: string;
}

export class EventCursorStaleError extends Error {
  constructor(readonly requested: number, readonly firstAvailable: number) {
    super(`Event cursor ${requested} is no longer available; first available cursor is ${firstAvailable}`);
    this.name = "EventCursorStaleError";
  }
}

export class InvalidEventCursorError extends Error {
  constructor() {
    super("Event cursor must be a non-negative integer");
    this.name = "InvalidEventCursorError";
  }
}

export interface SessionAuthorization {
  caller: AuthenticatedCaller;
  employeeId: string;
  snapshot: FrozenSnapshot;
  mentionedEmployeeIds?: ReadonlySet<string>;
  rosterEmployeeIds?: ReadonlySet<string>;
  managerClient?: ManagerClient;
  runtimeProviderId?: string;
  runtimeScope?: string;
}

export interface SessionHostOptions {
  cwdRoot: string;
  agentDir: string;
  sessionDir: string;
  store: AgentSqliteStore;
  modelRuntime: ModelRuntime;
  model?: Model<any>;
  resourceLoaderFactory: (conversationId: string, authorization?: SessionAuthorization, workspace?: string, agentDir?: string, hindsightRuntimeConfig?: HindsightRuntimeConfig) => ResourceLoader;
  managerClient?: ManagerClient;
  customTools?: ToolDefinition[];
  sandbox?: LocalSandbox;
  usageRecorder?: (capture: UsageCapture) => void | Promise<void>;
}

interface Subscriber {
  listener: (envelope: PiEventEnvelope) => void;
  replaying: boolean;
  queued: PiEventEnvelope[];
}

interface ChildSession {
  session?: AgentSession;
  resourceLoader?: ResourceLoader;
  resourceLoaderShutdown?: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
  aborted: boolean;
  abort: () => Promise<void>;
}

interface SessionRecord {
  conversationId: string;
  workspace: string;
  sessionManager: SessionManager;
  session?: AgentSession;
  resourceLoader?: ResourceLoader;
  sessionReady?: Promise<AgentSession>;
  promptPromise?: Promise<string | undefined>;
  unsubscribe?: () => void;
  prompting: boolean;
  aborting: boolean;
  delegateCalls: number;
  delegatePromptChars: number;
  delegatedEntries: SessionEntry[];
  activeDelegates: Set<ChildSession>;
  listeners: Set<Subscriber>;
  eventSequence: number;
  runtimeProviderId?: string;
  hindsightWorkspaces: Set<string>;
  disposing?: Promise<void>;
}

const MAX_DELEGATE_CALLS = 4;
const MAX_DELEGATE_CONCURRENCY = 2;
const MAX_DELEGATE_PROMPT_BUDGET = 32_000;
const MAX_DELEGATE_RESULT_CHARS = 2_000;

export class ConversationBusyError extends Error {
  constructor() {
    super("Conversation already has an active Pi prompt");
    this.name = "ConversationBusyError";
  }
}

export class SessionAuthorizationError extends Error {
  constructor(message = "Conversation employee is not authorized locally") {
    super(message);
    this.name = "SessionAuthorizationError";
  }
}

export class SessionHost {
  private readonly records = new Map<string, SessionRecord>();

  constructor(private readonly options: SessionHostOptions) {
    mkdirSync(options.cwdRoot, { recursive: true, mode: 0o700 });
    mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(options.agentDir, { recursive: true, mode: 0o700 });
    chmodSync(options.cwdRoot, 0o700);
    chmodSync(options.sessionDir, 0o700);
    chmodSync(options.agentDir, 0o700);
  }

  async subscribe(
    conversationId: string,
    listener: (envelope: PiEventEnvelope) => void,
    after?: string,
  ): Promise<() => void> {
    const record = this.ensureRecord(conversationId);
    const subscriber: Subscriber = { listener, replaying: true, queued: [] };
    record.listeners.add(subscriber);
    try {
      // Pi entries are the durable replay source. Transient AgentSessionEvents stay in memory;
      // callers use GET /entries with a Pi entry id after reconnecting.
      if (after !== undefined && after !== "") this.parseEntryCursor(after);
      subscriber.replaying = false;
      for (const envelope of subscriber.queued.splice(0)) listener(envelope);
    } catch (error) {
      record.listeners.delete(subscriber);
      throw error;
    }

    return () => record.listeners.delete(subscriber);
  }

  async prompt(conversationId: string, text: string, images?: ImageContent[], caller?: AuthenticatedCaller, mentions?: string[]): Promise<string | undefined> {
    // Keep record creation and the prompting marker in the same synchronous turn. An
    // immediate delete must see the initialization lock before prompt yields.
    const record = this.ensureRecord(conversationId);
    if (record.prompting) throw new ConversationBusyError();
    record.prompting = true;
    record.aborting = false;
    record.delegateCalls = 0;
    record.delegatePromptChars = 0;
    record.delegatedEntries = [];

    try {
      const authorization = caller ? this.resolveAuthorization(record, caller, mentions ?? []) : undefined;
      record.sessionReady = this.ensureSession(record, authorization);
      const session = await record.sessionReady;
      const startedAt = Date.now();
      const entriesBefore = record.sessionManager.getEntries().length;
      const promptPromise = (async () => {
        try {
          await session.prompt(text, images ? { images } : undefined);
          await this.recordUsage(record, authorization, startedAt, true, entriesBefore);
          return record.sessionManager.getLeafId() ?? undefined;
        } catch (error) {
          await this.recordUsage(record, authorization, startedAt, false, entriesBefore);
          throw error;
        }
      })();
      record.promptPromise = promptPromise;
      try {
        return await promptPromise;
      } finally {
        if (record.promptPromise === promptPromise) record.promptPromise = undefined;
      }
    } finally {
      record.sessionReady = undefined;
      record.prompting = false;
      record.aborting = false;
      await this.abortChildren(record);
      await this.disposeSession(record);
    }
  }

  async abort(conversationId: string): Promise<boolean> {
    const record = this.records.get(conversationId);
    if (!record) return false;
    record.aborting = true;
    const session = record.session ?? (record.sessionReady ? await record.sessionReady : undefined);
    const children = await this.abortChildren(record);
    if (!session) return children > 0;
    await session.abort();
    return true;
  }

  isPrompting(conversationId: string): boolean {
    return this.records.get(conversationId)?.prompting ?? false;
  }

  async delete(conversationId: string, tenantId: string, memberId: string): Promise<boolean> {
    const indexed = this.options.store.getOwnedConversation(conversationId, tenantId, memberId);
    if (!indexed) return false;
    const record = this.records.get(conversationId);
    if (record) {
      record.aborting = true;
      const sessionReady = record.sessionReady;
      await this.abortChildren(record);
      // Initialization may still be constructing the session/resource loader. Wait for
      // it before disposal and workspace deletion so no resource is created afterward.
      await sessionReady?.catch(() => undefined);
      await record.session?.abort().catch(() => undefined);
      await record.promptPromise?.catch(() => undefined);
      await this.disposeSession(record);
      for (const workspace of record.hindsightWorkspaces) removeHindsightState(this.options.agentDir, workspace);
      this.records.delete(conversationId);
    }
    if (!record && indexed.workspace) removeHindsightState(this.options.agentDir, indexed.workspace);
    for (const path of [indexed.sessionFile, indexed.workspace]) {
      if (!path) continue;
      this.assertManagedPathEither(path, path === indexed.workspace ? this.options.cwdRoot : this.options.sessionDir, this.options.cwdRoot);
      rmSync(path, { recursive: true, force: true });
    }
    return this.options.store.deleteConversation(conversationId, tenantId, memberId);
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.records.values()].map(async (record) => {
      if (!record.prompting && !record.promptPromise && !record.sessionReady) return;
      record.aborting = true;
      const session = record.session ?? await record.sessionReady?.catch(() => undefined);
      await session?.abort().catch(() => undefined);
      await record.promptPromise?.catch(() => undefined);
    }));
  }

  async entries(conversationId: string) {
    const record = this.ensureRecord(conversationId);
    return record.sessionManager.getEntries();
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) {
      await this.abortChildren(record);
      const session = record.session ?? await record.sessionReady?.catch(() => undefined);
      await session?.abort().catch(() => undefined);
      await record.promptPromise?.catch(() => undefined);
      await this.disposeSession(record);
    }
    this.records.clear();
  }

  private async recordUsage(record: SessionRecord, authorization: SessionAuthorization | undefined, startedAt: number, settled: boolean, entriesBefore: number): Promise<void> {
    if (!this.options.usageRecorder || !authorization?.caller.tenantId || !authorization.caller.userId) return;
    const employeeId = authorization.employeeId;
    await this.options.usageRecorder({
      tenantId: authorization.caller.tenantId,
      memberId: authorization.caller.userId,
      employeeId,
      startedAt,
      endedAt: Date.now(),
      entries: [...record.sessionManager.getEntries().slice(entriesBefore), ...record.delegatedEntries],
      settled,
    });
  }

  private ensureRecord(conversationId: string): SessionRecord {
    const existing = this.records.get(conversationId);
    if (existing) return existing;

    const indexed = this.options.store.getConversation(conversationId);
    if (!indexed) throw new Error("Conversation does not exist");
    const workspace = indexed.workspace || join(this.options.cwdRoot, this.safeDirectoryName(conversationId));
    this.assertManagedLexicalPath(workspace, this.options.cwdRoot);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    this.assertManagedPath(workspace, this.options.cwdRoot);
    chmodSync(workspace, 0o700);

    let sessionManager: SessionManager;
    if (indexed.sessionFile && existsSync(indexed.sessionFile)) {
      this.assertManagedPathEither(indexed.sessionFile, this.options.sessionDir, this.options.cwdRoot);
      sessionManager = SessionManager.open(indexed.sessionFile, this.options.sessionDir, workspace);
    } else {
      sessionManager = SessionManager.create(workspace, this.options.sessionDir);
    }

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Persistent SessionManager did not provide a session file");
    this.assertManagedPathEither(sessionFile, this.options.sessionDir, this.options.cwdRoot);
    try { chmodSync(sessionFile, 0o600); } catch { /* SDK may create it after first append */ }
    this.options.store.saveConversation({ ...indexed, id: conversationId, sessionFile, workspace });

    const record: SessionRecord = {
      conversationId,
      workspace,
      sessionManager,
      prompting: false,
      aborting: false,
      delegateCalls: 0,
      delegatePromptChars: 0,
      delegatedEntries: [],
      activeDelegates: new Set(),
      listeners: new Set(),
      eventSequence: 0,
      hindsightWorkspaces: new Set([workspace]),
    };
    this.records.set(conversationId, record);
    return record;
  }

  private async ensureSession(record: SessionRecord, authorization?: SessionAuthorization): Promise<AgentSession> {
    if (record.session) return record.session;
    const hindsightRuntimeConfig = await this.resolveHindsightRuntimeConfig(authorization);
    const resourceLoader = this.options.resourceLoaderFactory(record.conversationId, authorization, record.workspace, this.options.agentDir, hindsightRuntimeConfig);
    record.resourceLoader = resourceLoader;
    await resourceLoader.reload();
    if (authorization && this.hasCodingTools(authorization.snapshot)) {
      if (!this.options.sandbox) throw new Error("Coding tools require a configured local sandbox");
      await this.options.sandbox.assertAvailable(record.workspace);
    }
    const customTools = this.toolsFor(authorization, true, record, record.workspace);
    if (authorization) {
      authorization.runtimeScope = record.conversationId;
      await this.ensureRuntimeModel(authorization);
      record.runtimeProviderId = authorization.runtimeProviderId;
    }
    const result = await createAgentSession({
      cwd: record.workspace,
      agentDir: this.options.agentDir,
      model: authorization ? this.modelFor(authorization.snapshot, authorization.runtimeProviderId) : this.requireDefaultModel(),
      thinkingLevel: this.thinkingLevelFor(authorization),
      modelRuntime: this.options.modelRuntime,
      resourceLoader,
      sessionManager: record.sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: [...customTools.map((tool) => tool.name), ...(authorization ? [...memoryToolNames(authorization.snapshot, hindsightRuntimeConfig), ...ragToolNames(authorization.snapshot)] : [])],
      customTools,
    });
    record.session = result.session;
    try { chmodSync(record.sessionManager.getSessionFile()!, 0o600); } catch { /* SDK may defer the first write */ }
    record.unsubscribe = result.session.subscribe((event) => this.publish(record, event));
    return result.session;
  }

  private toolsFor(authorization?: SessionAuthorization, allowDelegation = true, record?: SessionRecord, workspace?: string, sessionId?: string): ToolDefinition[] {
    if (!authorization) return this.options.customTools ?? [];
    const allowed = this.allowedTools(authorization.snapshot);
    const operations = this.options.sandbox && workspace
      ? this.options.sandbox.operations(workspace, sessionId ?? record?.sessionManager.getSessionId())
      : undefined;
    const codingTools = operations && workspace
      ? [
          createBashToolDefinition(workspace, { operations: operations.bash }),
          createReadToolDefinition(workspace, { operations: operations.read }),
          createWriteToolDefinition(workspace, { operations: operations.write }),
          createEditToolDefinition(workspace, { operations: operations.edit }),
        ]
      : [];
    const tools = [
      ...(this.options.customTools ?? []).filter((tool) => allowDelegation || tool.name !== "delegate_employee"),
      ...codingTools,
      ...(allowDelegation && record ? [createDelegateEmployeeTool({ delegate: (toolCallId, input, signal) => this.delegate(record, authorization, toolCallId, input, signal) })] : []),
    ];
    return tools.filter((tool, index) => allowed.has(tool.name) && tools.findIndex((candidate) => candidate.name === tool.name) === index) as ToolDefinition[];
  }

  private allowedTools(snapshot: FrozenSnapshot): Set<string> {
    const policy = snapshot.tool_policy;
    if (!policy || typeof policy !== "object") return new Set();
    const allowed = (policy as Record<string, unknown>).allowed_tools;
    const names = Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === "string") : [];
    if (names.includes("memory_recall")) names.push("hindsight_recall");
    if (names.includes("memory_retain")) names.push("hindsight_retain");
    return new Set(names);
  }

  private thinkingLevelFor(authorization?: SessionAuthorization): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    const policy = authorization?.snapshot.model_policy;
    const value = policy && typeof policy === "object"
      ? (policy as Record<string, unknown>).thinking_level
      : undefined;
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "off";
  }

  private resolveAuthorization(record: SessionRecord, caller: AuthenticatedCaller, mentions: string[] = []): SessionAuthorization | undefined {
    const metadata = this.options.store.getConversationMetadata(record.conversationId);
    const memberId = caller.userId ?? caller.callerId;
    if (metadata?.tenant_id && metadata.tenant_id !== caller.tenantId) throw new SessionAuthorizationError();
    if (metadata?.member_id && metadata.member_id !== memberId) throw new SessionAuthorizationError();
    const employeeId = metadata?.entry_employee_id ?? metadata?.coordinator_employee_id;
    if (!employeeId) throw new SessionAuthorizationError("Conversation has no authorized employee");
    const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
    const expert = experts.find((item) => item.employee_id === employeeId);
    if (!expert || expert.revoked) throw new SessionAuthorizationError();
    let rosterEmployeeIds: ReadonlySet<string> | undefined;
    if (metadata?.kind === "group") {
      rosterEmployeeIds = new Set(experts.filter((item) => !item.revoked).map((item) => item.employee_id));
      if (metadata.solution_instance_id) {
        const solution = this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id);
        if (!solution) throw new SessionAuthorizationError("Conversation solution is not authorized locally");
        const solutionRoster = Array.isArray(solution.expert_employee_ids)
          ? solution.expert_employee_ids.filter((id): id is string => typeof id === "string")
          : [];
        if (solutionRoster.length > 0) rosterEmployeeIds = new Set(solutionRoster);
      }
      if (!rosterEmployeeIds.has(employeeId)) throw new SessionAuthorizationError("Coordinator is not in the authorized group roster");
    }
    const snapshot = this.options.store.listSnapshots(caller.tenantId, memberId).find((item) => item.employee_id === employeeId && item.version === expert.version);
    if (!snapshot) throw new SessionAuthorizationError("Conversation employee snapshot is not available locally");
    const mentionedEmployeeIds = mentions.length
      ? new Set(experts.filter((item) => (!rosterEmployeeIds || rosterEmployeeIds.has(item.employee_id)) && mentions.includes(item.handle)).map((item) => item.employee_id))
      : undefined;
    return { caller, employeeId, snapshot, mentionedEmployeeIds, rosterEmployeeIds, managerClient: this.options.managerClient };
  }

  private async disposeSession(record: SessionRecord): Promise<void> {
    if (record.disposing) return record.disposing;
    record.disposing = (async () => {
      record.unsubscribe?.();
      record.unsubscribe = undefined;
      await this.flushResourceLoader(record.resourceLoader);
      record.session?.dispose();
      record.session = undefined;
      record.resourceLoader = undefined;
      const providerId = record.runtimeProviderId;
      record.runtimeProviderId = undefined;
      if (providerId) {
        await this.options.modelRuntime.removeRuntimeApiKey(providerId).catch(() => undefined);
        this.options.modelRuntime.unregisterProvider(providerId);
      }
    })();
    try {
      await record.disposing;
    } finally {
      record.disposing = undefined;
    }
  }

  private async abortChildren(record: SessionRecord): Promise<number> {
    const children = [...record.activeDelegates];
    await Promise.all(children.map(async (child) => {
      await child.abort().catch(() => undefined);
      await child.done.catch(() => undefined);
    }));
    return children.length;
  }

  private async flushResourceLoader(loader?: ResourceLoader): Promise<void> {
    const controlled = loader as ControlledResourceLoader | undefined;
    await controlled?.shutdown?.();
  }

  private async flushChildResourceLoader(child: ChildSession): Promise<void> {
    if (!child.resourceLoaderShutdown) {
      child.resourceLoaderShutdown = this.flushResourceLoader(child.resourceLoader);
    }
    await child.resourceLoaderShutdown;
  }

  private async delegate(record: SessionRecord, authorization: SessionAuthorization, toolCallId: string, input: DelegateEmployeeInput, signal?: AbortSignal): Promise<string> {
    if (!authorization.caller.tenantId) throw new Error("Authenticated tenant is required for delegation");
    const memberId = authorization.caller.userId ?? authorization.caller.callerId;
    if (authorization.mentionedEmployeeIds && !authorization.mentionedEmployeeIds.has(input.employee_id)) {
      throw new Error("Employee was not explicitly mentioned in this group prompt");
    }
    if (authorization.rosterEmployeeIds && !authorization.rosterEmployeeIds.has(input.employee_id)) {
      throw new Error("Employee is not in the authorized group roster");
    }
    const expert = this.options.store.listLoadedExperts(authorization.caller.tenantId, memberId).find((item) => item.employee_id === input.employee_id && !item.revoked);
    if (!expert) throw new Error("Employee is not in the authorized local roster");
    const snapshot = this.options.store.listSnapshots(authorization.caller.tenantId, memberId).find((item) => item.employee_id === input.employee_id && item.version === expert.version);
    if (!snapshot) throw new Error("Employee snapshot is not available locally");

    const prompt = [input.task, input.context ? `Context:\n${input.context}` : ""].filter(Boolean).join("\n\n");
    if (record.aborting || signal?.aborted) throw new Error("Delegation aborted");
    if (record.delegateCalls >= MAX_DELEGATE_CALLS) throw new Error(`Delegation limit reached (maximum ${MAX_DELEGATE_CALLS})`);
    if (record.delegatePromptChars + prompt.length > MAX_DELEGATE_PROMPT_BUDGET) throw new Error("Delegation prompt budget exceeded");
    record.delegateCalls += 1;
    record.delegatePromptChars += prompt.length;
    while (record.activeDelegates.size >= MAX_DELEGATE_CONCURRENCY) {
      if (record.aborting || signal?.aborted) throw new Error("Delegation aborted");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const child: ChildSession = {
      aborted: false,
      done,
      resolveDone,
      abort: async () => { child.aborted = true; await child.session?.abort(); },
    };
    record.activeDelegates.add(child);
    const sourceRef = createHash("sha256").update(`${record.conversationId}:${toolCallId}:${Date.now()}`).digest("hex").slice(0, 24);
    let childWorkspace: string | undefined;
    let childProviderId: string | undefined;
    try {
      childWorkspace = join(record.workspace, ".delegates", sourceRef);
      record.hindsightWorkspaces.add(childWorkspace);
      mkdirSync(childWorkspace, { recursive: true, mode: 0o700 });
      chmodSync(childWorkspace, 0o700);
      if (this.hasCodingTools(snapshot)) {
        if (!this.options.sandbox) throw new Error("Coding tools require a configured local sandbox");
        await this.options.sandbox.assertAvailable(childWorkspace);
      }
      const sessionManager = SessionManager.inMemory(childWorkspace);
      const childAuthorization = { ...authorization, employeeId: snapshot.employee_id, snapshot, runtimeScope: sourceRef };
      const hindsightRuntimeConfig = await this.resolveHindsightRuntimeConfig(childAuthorization);
      const resourceLoader = this.options.resourceLoaderFactory(`${record.conversationId}:${sourceRef}`, childAuthorization, childWorkspace, this.options.agentDir, hindsightRuntimeConfig);
      child.resourceLoader = resourceLoader;
      await resourceLoader.reload();
      const childTools = this.toolsFor(childAuthorization, false, undefined, childWorkspace, sessionManager.getSessionId());
      const childRuntime = await this.ensureRuntimeModel(childAuthorization);
      childProviderId = childRuntime.providerId;
      const result = await createAgentSession({
        cwd: childWorkspace,
        agentDir: this.options.agentDir,
        model: childRuntime.model,
        thinkingLevel: this.thinkingLevelFor({ ...authorization, snapshot }),
        modelRuntime: this.options.modelRuntime,
        resourceLoader,
        sessionManager,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        tools: [...childTools.map((tool) => tool.name), ...memoryToolNames(childAuthorization.snapshot, hindsightRuntimeConfig), ...ragToolNames(childAuthorization.snapshot)],
        customTools: childTools,
      });
      child.session = result.session;
      if (child.aborted || signal?.aborted || record.aborting) await child.abort();
      const unsubscribe = result.session.subscribe((event) => this.publishChild(record, event, sourceRef, toolCallId));
      try {
        await result.session.prompt(prompt);
        return this.childSummary(sessionManager.getEntries());
      } finally {
        record.delegatedEntries.push(...sessionManager.getEntries());
        unsubscribe();
        await child.abort();
        await this.flushChildResourceLoader(child);
        result.session.dispose();
      }
    } finally {
      try {
        if (childProviderId) {
          await this.options.modelRuntime.removeRuntimeApiKey(childProviderId).catch(() => undefined);
          this.options.modelRuntime.unregisterProvider(childProviderId);
        }
        await this.flushChildResourceLoader(child);
      } finally {
        if (childWorkspace) rmSync(childWorkspace, { recursive: true, force: true });
        record.activeDelegates.delete(child);
        child.resolveDone();
      }
    }
  }

  private async resolveHindsightRuntimeConfig(authorization?: SessionAuthorization): Promise<HindsightRuntimeConfig | undefined> {
    if (!authorization || !isMemoryPolicyEnabled(authorization.snapshot)) return undefined;
    if (authorization.managerClient?.pullHindsightRuntimeConfig) {
      const config = await authorization.managerClient.pullHindsightRuntimeConfig(authorization.caller, authorization.employeeId);
      if (!config) throw new SessionAuthorizationError("Manager Hindsight lease is unavailable");
      return config;
    }
    if (process.env.AITEAM_ENV === "production") {
      throw new SessionAuthorizationError("Manager Hindsight lease is unavailable");
    }
    // Development/faux sessions may omit the external memory lease; no Hindsight
    // tools or local bank are created in that case.
    return undefined;
  }

  private async ensureRuntimeModel(authorization: SessionAuthorization): Promise<{ model: Model<any>; providerId?: string }> {
    if (!authorization.managerClient?.pullRuntimeConfig) {
      if (!this.options.model) throw new SessionAuthorizationError("No authenticated Pi model is available");
      return { model: this.options.model };
    }
    const memberId = authorization.caller.userId ?? authorization.caller.callerId;
    const config = await authorization.managerClient.pullRuntimeConfig(authorization.caller, authorization.employeeId);
    const policy = authorization.snapshot.model_policy;
    const expectedModel = policy && typeof policy === "object" && typeof (policy as Record<string, unknown>).model === "string" ? (policy as Record<string, unknown>).model : undefined;
    const expectedProvider = policy && typeof policy === "object" && typeof (policy as Record<string, unknown>).provider_ref === "string" ? (policy as Record<string, unknown>).provider_ref : undefined;
    if (!expectedModel || !expectedProvider || config.model !== expectedModel || config.provider_ref !== expectedProvider) throw new SessionAuthorizationError("Manager runtime config does not match the employee snapshot");
    const providerId = `aiteam:${createHash("sha256").update(`${authorization.caller.tenantId}:${memberId}:${authorization.employeeId}:${config.version}:${authorization.runtimeScope ?? "session"}`).digest("hex").slice(0, 32)}`;
    const model = await registerRuntimeProvider(this.options.modelRuntime, config, providerId);
    authorization.runtimeProviderId = providerId;
    return { model, providerId };
  }

  private modelFor(snapshot: FrozenSnapshot, runtimeProviderId?: string): Model<any> {
    const policy = snapshot.model_policy;
    if (policy && typeof policy === "object") {
      const values = policy as Record<string, unknown>;
      const provider = runtimeProviderId ?? (typeof values.provider === "string" ? values.provider : typeof values.provider_ref === "string" ? values.provider_ref : undefined);
      const model = typeof values.model === "string" ? values.model : typeof values.model_id === "string" ? values.model_id : undefined;
      if (provider && model) return this.options.modelRuntime.getModel(provider, model) ?? this.requireDefaultModel();
    }
    return this.options.model ?? this.requireDefaultModel();
  }

  private requireDefaultModel(): Model<any> {
    if (!this.options.model) throw new SessionAuthorizationError("No authenticated Pi model is available");
    return this.options.model;
  }

  private childSummary(entries: ReturnType<SessionManager["getEntries"]>): string {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const text = entry.message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("").trim();
      if (text) return text.slice(0, MAX_DELEGATE_RESULT_CHARS);
    }
    return "Employee completed without a textual result.";
  }

  private publishChild(record: SessionRecord, event: AgentSessionEvent, sourceRef: string, toolCallId: string): void {
    if (!serializePiEvent(event, { conversation_id: record.conversationId, source_ref: sourceRef, tool_call_id: toolCallId })) return;
    const envelope: PiEventEnvelope = { id: `${sourceRef}:${++record.eventSequence}`, event, conversation_id: record.conversationId, source_ref: sourceRef, tool_call_id: toolCallId };
    for (const subscriber of record.listeners) {
      if (subscriber.replaying) subscriber.queued.push(envelope);
      else subscriber.listener(envelope);
    }
  }

  private publish(record: SessionRecord, event: AgentSessionEvent): void {
    if (!serializePiEvent(event)) return;
    const envelope: PiEventEnvelope = {
      id: this.entryIdentity(event) ?? `${record.conversationId}:${++record.eventSequence}`,
      event,
      conversation_id: record.conversationId,
    };
    for (const subscriber of record.listeners) {
      if (subscriber.replaying) subscriber.queued.push(envelope);
      else subscriber.listener(envelope);
    }
  }

  private parseEntryCursor(after: string): void {
    if (after.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(after)) throw new InvalidEventCursorError();
  }

  private entryIdentity(event: AgentSessionEvent): string | undefined {
    const value = event as unknown as Record<string, unknown>;
    const message = value.message;
    if (message && typeof message === "object" && typeof (message as Record<string, unknown>).id === "string") return (message as Record<string, unknown>).id as string;
    return typeof value.entry_id === "string" ? value.entry_id : undefined;
  }

  private hasCodingTools(snapshot: FrozenSnapshot): boolean {
    const allowed = this.allowedTools(snapshot);
    return ["bash", "read", "write", "edit", "grep", "find", "ls"].some((name) => allowed.has(name));
  }

  private assertManagedPathEither(path: string, ...roots: string[]): void {
    if (roots.some((root) => { try { this.assertManagedPath(path, root); return true; } catch { return false; } })) return;
    throw new Error("Path escapes Agent data root");
  }

  private assertManagedLexicalPath(path: string, root: string): void {
    if (!isAbsolute(path) || !isAbsolute(root)) throw new Error("Managed paths must be absolute");
    const rel = relative(resolve(root), resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes Agent data root");
  }

  private assertManagedPath(path: string, root: string): void {
    if (!isAbsolute(path) || !isAbsolute(root)) throw new Error("Managed paths must be absolute");
    const resolvedRoot = realpathSync(root);
    const resolved = existsSync(path) ? realpathSync(path) : join(realpathSync(join(path, "..")), path.split("/").at(-1)!);
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes Agent data root");
  }

  private safeDirectoryName(conversationId: string): string {
    return `conversation-${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`;
  }
}
