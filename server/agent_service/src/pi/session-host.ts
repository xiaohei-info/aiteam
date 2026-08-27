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
import type { AgentSqliteStore, ConversationPermissionMode, FrozenSnapshot } from "../storage/sqlite.js";
import { createDelegateEmployeeTool, createMentionEmployeeTool, type DelegateEmployeeInput } from "../tools/delegate.js";
import { GroupMessageDeliveryService, type GroupMessageCommand, type GroupMessageReply, type GroupMessageSource } from "../services/group-message-delivery.js";
import { createTodoUpdateTool, TODO_UPDATE_TOOL_NAME } from "../tools/todo.js";
import { serializePiEvent } from "./event-sse.js";
import type { UsageCapture } from "../usage.js";
import { LocalSandbox } from "./sandbox.js";
import { registerRuntimeProvider, type RuntimePricingSnapshot } from "./model-runtime.js";
import { isMemoryPolicyEnabled, memoryToolNames, ragToolNames, removeHindsightState, type ControlledResourceLoader } from "./resources.js";

export interface PiEventEnvelope {
  id: string;
  event: AgentSessionEvent;
  conversation_id?: string;
  source_ref?: string;
  tool_call_id?: string;
  source_employee_id?: string;
  source_employee_display_name?: string;
  source_role?: "human" | "child" | "participant" | "coordinator";
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

export interface PromptDeliveryOptions {
  logicalMessageId?: string;
  idempotencyKey?: string;
}

export interface SessionAuthorization {
  caller: AuthenticatedCaller;
  employeeId: string;
  snapshot: FrozenSnapshot;
  mentionedEmployeeIds?: ReadonlySet<string>;
  rosterEmployeeIds?: ReadonlySet<string>;
  /** Platform-owned group coordination tool; never enabled for ordinary participants. */
  peerMentionAllowed?: boolean;
  permissionMode?: ConversationPermissionMode;
  managerClient?: ManagerClient;
  runtimeProviderId?: string;
  runtimeScope?: string;
  groupMessageSource?: { type: "human" | "employee"; id: string; displayName?: string };
  groupContext?: string;
}

export interface SessionHostOptions {
  cwdRoot: string;
  agentDir: string;
  sessionDir: string;
  store: AgentSqliteStore;
  modelRuntime: ModelRuntime;
  model?: Model<any>;
  useFauxModel?: boolean;
  resourceLoaderFactory: (conversationId: string, authorization?: SessionAuthorization, workspace?: string, agentDir?: string, hindsightRuntimeConfig?: HindsightRuntimeConfig) => ResourceLoader;
  managerClient?: ManagerClient;
  customTools?: ToolDefinition[];
  sandbox?: LocalSandbox;
  usageRecorder?: (capture: UsageCapture, caller: AuthenticatedCaller) => void | Promise<void>;
}

interface Subscriber {
  listener: (envelope: PiEventEnvelope) => void;
  replaying: boolean;
  queued: PiEventEnvelope[];
}

interface SessionRecord {
  conversationId: string;
  employeeId?: string;
  role?: "coordinator" | "member";
  workspace: string;
  permissionMode: ConversationPermissionMode;
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
  listeners: Set<Subscriber>;
  eventSequence: number;
  runtimeProviderId?: string;
  activeSourceRef?: string;
  activeToolCallId?: string;
  activeSourceRole?: "human" | "child" | "participant" | "coordinator";
  activeSource?: GroupMessageSource;
  hindsightWorkspaces: Set<string>;
  disposing?: Promise<void>;
}

const MAX_DELEGATE_CALLS = 4;
const MAX_DELEGATE_PROMPT_BUDGET = 32_000;
const MAX_DELEGATE_RESULT_CHARS = 2_000;
const MAX_ENTRIES_PROMPT_WAIT_MS = 5_000;
const MAX_GROUP_CONTEXT_CHARS = 8_000;
const MAX_GROUP_CONTEXT_FIELD_CHARS = 600;
const DEFAULT_AGENT_TOOLS = [
  "bash", "read", "write", "edit", "todo_update",
  "knowledge_search", "knowledge_get", "hindsight_recall", "hindsight_retain",
] as const;

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
  private readonly listeners = new Map<string, Set<Subscriber>>();
  private readonly delivery: GroupMessageDeliveryService;

  constructor(private readonly options: SessionHostOptions) {
    this.delivery = new GroupMessageDeliveryService((command, employeeId) => this.deliverToParticipant(command, employeeId));
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
    const subscriber: Subscriber = { listener, replaying: true, queued: [] };
    const listeners = this.listeners.get(conversationId) ?? new Set<Subscriber>();
    listeners.add(subscriber);
    this.listeners.set(conversationId, listeners);
    try {
      if (after !== undefined && after !== "") this.parseEntryCursor(after);
      subscriber.replaying = false;
      for (const envelope of subscriber.queued.splice(0)) listener(envelope);
    } catch (error) {
      listeners.delete(subscriber);
      throw error;
    }
    return () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.listeners.delete(conversationId);
    };
  }

  async prompt(conversationId: string, text: string, images?: ImageContent[], caller?: AuthenticatedCaller, mentions?: string[], deliveryOptions?: PromptDeliveryOptions): Promise<string | undefined> {
    const metadata = this.options.store.getConversationMetadata(conversationId);
    if (!metadata) throw new Error("Conversation does not exist");
    const targetEmployeeIds = this.resolveTargetEmployeeIds(metadata, caller, mentions ?? []);
    for (const record of this.records.values()) {
      if (record.conversationId === conversationId) {
        record.delegateCalls = 0;
        record.delegatePromptChars = 0;
      }
    }
    const sourceId = caller?.userId ?? caller?.callerId ?? "human";
    const result = await this.delivery.deliver({
      conversationId,
      source: { type: "human", id: sourceId },
      targetEmployeeIds,
      text,
      images,
      logicalMessageId: deliveryOptions?.logicalMessageId ?? `${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      idempotencyKey: deliveryOptions?.idempotencyKey,
      caller,
    });
    return result.replies.at(-1)?.entryId;
  }

  async abort(conversationId: string): Promise<boolean> {
    const records = [...this.records.values()].filter((record) => record.conversationId === conversationId);
    if (records.length === 0) return false;
    await Promise.all(records.map(async (record) => {
      record.aborting = true;
      const session = record.session ?? (record.sessionReady ? await record.sessionReady : undefined);
      await session?.abort().catch(() => undefined);
    }));
    return true;
  }

  isPrompting(conversationId: string): boolean {
    return [...this.records.values()].some((record) => record.conversationId === conversationId && record.prompting);
  }

  async delete(conversationId: string, tenantId: string, memberId: string): Promise<boolean> {
    const indexed = this.options.store.getOwnedConversation(conversationId, tenantId, memberId);
    if (!indexed) return false;
    const participants = this.options.store.listConversationParticipants(conversationId);
    const records = [...this.records.values()].filter((record) => record.conversationId === conversationId);
    for (const record of records) {
      record.aborting = true;
      await record.sessionReady?.catch(() => undefined);
      await record.session?.abort().catch(() => undefined);
      await record.promptPromise?.catch(() => undefined);
      await this.disposeSession(record);
      for (const workspace of record.hindsightWorkspaces) removeHindsightState(this.options.agentDir, workspace);
      this.records.delete(this.recordKey(record.conversationId, record.employeeId));
    }
    for (const participant of participants) if (participant.workspace) removeHindsightState(this.options.agentDir, participant.workspace);
    if (indexed.workspace) removeHindsightState(this.options.agentDir, indexed.workspace);
    const paths = [indexed.sessionFile, indexed.workspace, ...participants.flatMap((participant) => [participant.session_file, participant.workspace])];
    for (const path of paths) {
      if (!path) continue;
      this.assertManagedPathEither(path, this.options.sessionDir, this.options.cwdRoot);
      rmSync(path, { recursive: true, force: true });
    }
    this.listeners.delete(conversationId);
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
    const participantRows = this.options.store.listConversationParticipants(conversationId);
    const records = participantRows.length > 0
      ? participantRows.map((participant) => this.ensureRecord(conversationId, participant.employee_id))
      : [this.ensureRecord(conversationId)];
    await Promise.all(records.map(async (record) => {
      await record.sessionReady?.catch(() => undefined);
      if (record.prompting && !record.promptPromise) await new Promise<void>((resolve) => setImmediate(resolve));
      if (record.promptPromise) {
        // Do not let a provider that ignores abort hold history forever. Entries are
        // durable Pi data; an in-flight prompt can be observed on the next read.
        await Promise.race([
          record.promptPromise.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, MAX_ENTRIES_PROMPT_WAIT_MS)),
        ]);
      }
    }));
    const seenLogicalMessages = new Set<string>();
    return records
      .flatMap((record) => record.sessionManager.getEntries().map((entry) => this.decorateEntry(record, entry)))
      .filter((entry) => {
        const value = entry as unknown as Record<string, unknown>;
        if (value.type !== "message" || (value as { message?: { role?: unknown } }).message?.role !== "user") return true;
        const logicalMessageId = typeof value.logical_message_id === "string" ? value.logical_message_id : undefined;
        if (!logicalMessageId || seenLogicalMessages.has(logicalMessageId)) return !logicalMessageId;
        seenLogicalMessages.add(logicalMessageId);
        return true;
      })
      // SessionManager timestamps are ISO strings. Stable sort preserves append order
      // for entries written within the same millisecond.
      .sort((left, right) => this.entryTimestamp(left) - this.entryTimestamp(right));
  }

  private entryTimestamp(entry: SessionEntry): number {
    const value = entry as unknown as { timestamp?: unknown };
    if (typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) return value.timestamp;
    if (typeof value.timestamp === "string") {
      const timestamp = Date.parse(value.timestamp);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return 0;
  }

  async initializeConversationParticipants(conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const metadata = this.options.store.getOwnedConversationMetadata(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new SessionAuthorizationError("Conversation is not owned by the authenticated member");
    if (metadata.kind !== "group") {
      if (metadata.entry_employee_id) this.ensureRecord(conversationId, metadata.entry_employee_id);
      return;
    }
    const memberId = caller.userId ?? caller.callerId;
    const solution = metadata.solution_instance_id
      ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id)
      : undefined;
    if (metadata.solution_instance_id && !solution) throw new SessionAuthorizationError("Solution is no longer authorized locally");
    if (solution && typeof solution.status === "string" && solution.status !== "applied") throw new SessionAuthorizationError("Solution is not active");
    const roster = solution && Array.isArray(solution.expert_employee_ids)
      ? solution.expert_employee_ids.filter((id): id is string => typeof id === "string")
      : this.options.store.listLoadedExperts(caller.tenantId, memberId).filter((expert) => !expert.revoked).map((expert) => expert.employee_id);
    const coordinator = metadata.coordinator_employee_id
      ?? (solution && typeof solution.coordinator_employee_id === "string" ? solution.coordinator_employee_id : undefined)
      ?? roster[0];
    if (!coordinator || !roster.includes(coordinator)) throw new SessionAuthorizationError("Group conversation has no authorized coordinator");
    for (const employeeId of [...new Set([coordinator, ...roster])]) {
      this.requireParticipantSnapshot(caller, employeeId);
      const previous = this.options.store.getConversationParticipant(conversationId, employeeId);
      this.options.store.upsertConversationParticipant({
        conversation_id: conversationId,
        employee_id: employeeId,
        role: employeeId === coordinator ? "coordinator" : "member",
        session_file: previous?.session_file ?? "",
        workspace: previous?.workspace ?? "",
        pi_session_id: previous?.pi_session_id ?? null,
        employee_version: this.options.store.listSnapshots(caller.tenantId, memberId).find((snapshot) => snapshot.employee_id === employeeId)?.version ?? "",
      });
      this.ensureRecord(conversationId, employeeId);
    }
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) {
      const session = record.session ?? await record.sessionReady?.catch(() => undefined);
      await session?.abort().catch(() => undefined);
      await record.promptPromise?.catch(() => undefined);
      await this.disposeSession(record);
    }
    this.records.clear();
    this.listeners.clear();
  }

  private async recordUsage(record: SessionRecord, authorization: SessionAuthorization | undefined, startedAt: number, settled: boolean, entriesBefore: number): Promise<void> {
    if (!this.options.usageRecorder || !authorization?.caller.tenantId || !authorization.caller.userId) return;
    await this.recordUsageEntries(
      authorization, startedAt, settled, record.sessionManager.getEntries().slice(entriesBefore),
    );
  }

  private async recordUsageEntries(authorization: SessionAuthorization, startedAt: number, settled: boolean, entries: readonly SessionEntry[]): Promise<void> {
    if (!this.options.usageRecorder || !authorization.caller.tenantId || !authorization.caller.userId) return;
    await this.options.usageRecorder({
      tenantId: authorization.caller.tenantId,
      memberId: authorization.caller.userId,
      employeeId: authorization.employeeId,
      startedAt,
      endedAt: Date.now(),
      entries,
      settled,
      pricing: ((authorization.snapshot.model_policy as Record<string, unknown> | undefined)?.pricing ?? null) as RuntimePricingSnapshot | null,
    }, authorization.caller);
  }

  private ensureRecord(conversationId: string, employeeId?: string): SessionRecord {
    const indexed = this.options.store.getConversation(conversationId);
    if (!indexed) throw new Error("Conversation does not exist");
    const resolvedEmployeeId = employeeId ?? indexed.entryEmployeeId ?? indexed.coordinatorEmployeeId ?? undefined;
    const key = this.recordKey(conversationId, resolvedEmployeeId);
    const existing = this.records.get(key);
    if (existing) {
      existing.permissionMode = indexed.permissionMode ?? "read-only";
      return existing;
    }

    const participant = resolvedEmployeeId
      ? this.options.store.getConversationParticipant(conversationId, resolvedEmployeeId)
      : undefined;
    const workspace = participant?.workspace || indexed.workspace || join(this.options.cwdRoot, this.safeDirectoryName(`${conversationId}:${resolvedEmployeeId ?? "conversation"}`));
    this.assertManagedLexicalPath(workspace, this.options.cwdRoot);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    this.assertManagedPath(workspace, this.options.cwdRoot);
    chmodSync(workspace, 0o700);

    let sessionManager: SessionManager;
    const existingSessionFile = participant?.session_file || (!resolvedEmployeeId ? indexed.sessionFile : "");
    if (existingSessionFile && existsSync(existingSessionFile)) {
      this.assertManagedPathEither(existingSessionFile, this.options.sessionDir, this.options.cwdRoot);
      sessionManager = SessionManager.open(existingSessionFile, this.options.sessionDir, workspace);
    } else {
      sessionManager = SessionManager.create(workspace, this.options.sessionDir);
    }

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Persistent SessionManager did not provide a session file");
    this.assertManagedPathEither(sessionFile, this.options.sessionDir, this.options.cwdRoot);
    try { chmodSync(sessionFile, 0o600); } catch { /* SDK may create it after first append */ }
    const role = participant?.role ?? (resolvedEmployeeId && indexed.coordinatorEmployeeId === resolvedEmployeeId ? "coordinator" : "member");
    if (resolvedEmployeeId) {
      const expert = this.options.store.listLoadedExperts(indexed.tenantId ?? undefined, indexed.memberId ?? undefined, true).find((item) => item.employee_id === resolvedEmployeeId);
      this.options.store.upsertConversationParticipant({
        conversation_id: conversationId,
        employee_id: resolvedEmployeeId,
        role,
        session_file: sessionFile,
        workspace,
        pi_session_id: sessionManager.getSessionId(),
        employee_version: participant?.employee_version ?? expert?.version ?? "",
        created_at: participant?.created_at,
      });
      if (indexed.kind !== "group" && !indexed.coordinatorEmployeeId) this.options.store.saveConversation({ ...indexed, id: conversationId, sessionFile, workspace });
    } else {
      this.options.store.saveConversation({ ...indexed, id: conversationId, sessionFile, workspace });
    }

    const record: SessionRecord = {
      conversationId,
      ...(resolvedEmployeeId ? { employeeId: resolvedEmployeeId } : {}),
      role,
      workspace,
      permissionMode: indexed.permissionMode ?? "read-only",
      sessionManager,
      prompting: false,
      aborting: false,
      delegateCalls: 0,
      delegatePromptChars: 0,
      listeners: new Set(),
      eventSequence: 0,
      hindsightWorkspaces: new Set([workspace]),
    };
    this.records.set(key, record);
    return record;
  }

  private recordKey(conversationId: string, employeeId?: string): string {
    return `${conversationId}:${employeeId ?? "__conversation__"}`;
  }

  private requireParticipantSnapshot(caller: AuthenticatedCaller, employeeId: string): void {
    const memberId = caller.userId ?? caller.callerId;
    const expert = this.options.store.listLoadedExperts(caller.tenantId, memberId).find((item) => item.employee_id === employeeId && !item.revoked);
    if (!expert || !this.options.store.listSnapshots(caller.tenantId, memberId).some((snapshot) => snapshot.employee_id === employeeId && snapshot.version === expert.version)) {
      throw new SessionAuthorizationError(`Employee ${employeeId} is not authorized in this conversation`);
    }
  }

  private resolveTargetEmployeeIds(metadata: { kind: string; entry_employee_id: string | null; coordinator_employee_id: string | null; solution_instance_id: string | null; tenant_id?: string | null; member_id?: string | null }, caller: AuthenticatedCaller | undefined, mentions: string[]): string[] {
    const coordinator = metadata.coordinator_employee_id ?? metadata.entry_employee_id;
    if (!caller && !coordinator) return ["__conversation__"];
    if (metadata.kind !== "group" && !metadata.coordinator_employee_id) {
      if (mentions.length > 0) throw new SessionAuthorizationError("mentions are only supported for group conversations");
      if (!coordinator) throw new SessionAuthorizationError("Conversation requires a locally authorized employee snapshot");
      return [coordinator];
    }
    if (!caller) return coordinator ? [coordinator] : [];
    const memberId = caller.userId ?? caller.callerId;
    const solution = metadata.solution_instance_id
      ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id)
      : undefined;
    if (solution && typeof solution.status === "string" && solution.status !== "applied") throw new SessionAuthorizationError("Solution is not active");
    const roster = solution && Array.isArray(solution.expert_employee_ids)
      ? solution.expert_employee_ids.filter((id): id is string => typeof id === "string")
      : this.options.store.listLoadedExperts(caller.tenantId, memberId).filter((expert) => !expert.revoked).map((expert) => expert.employee_id);
    if (metadata.solution_instance_id && !solution) throw new SessionAuthorizationError("Solution is no longer authorized locally");
    const allowed = new Set(roster);
    if (mentions.length === 0) return coordinator && allowed.has(coordinator) ? [coordinator] : [];
    const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
    const targets = [...new Set(mentions)].map((handle) => experts.find((expert) => expert.handle === handle)?.employee_id);
    if (targets.some((employeeId) => !employeeId || !allowed.has(employeeId))) throw new SessionAuthorizationError("Mentioned employee is not in the authorized group roster");
    return targets as string[];
  }

  private async ensureSession(record: SessionRecord, authorization?: SessionAuthorization): Promise<AgentSession> {
    if (record.session) return record.session;
    const hindsightRuntimeConfig = await this.resolveHindsightRuntimeConfig(authorization);
    const resourceLoader = this.options.resourceLoaderFactory(record.conversationId, authorization, record.workspace, this.options.agentDir, hindsightRuntimeConfig);
    record.resourceLoader = resourceLoader;
    await resourceLoader.reload();
    if (authorization && this.hasCodingTools(authorization.snapshot)) {
      if (!this.options.sandbox) throw new Error("Coding tools require a configured local sandbox");
      await this.options.sandbox.assertAvailable(record.workspace, record.permissionMode);
    }
    const allowPeerMention = Boolean(authorization?.peerMentionAllowed);
    const customTools = this.toolsFor(authorization, allowPeerMention, record, record.workspace);
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
    if (!authorization) return (this.options.customTools ?? []).filter((tool) => tool.name !== TODO_UPDATE_TOOL_NAME);
    const allowed = this.allowedTools(authorization.snapshot);
    if (allowDelegation && authorization.peerMentionAllowed) allowed.add("mention_employee");
    const operations = this.options.sandbox && workspace
      ? this.options.sandbox.operations(workspace, sessionId ?? record?.sessionManager.getSessionId(), record?.permissionMode)
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
      ...(this.options.customTools ?? []).filter((tool) => tool.name !== TODO_UPDATE_TOOL_NAME && (allowDelegation || (tool.name !== "delegate_employee" && tool.name !== "mention_employee"))),
      ...(allowed.has(TODO_UPDATE_TOOL_NAME) ? [createTodoUpdateTool()] : []),
      ...codingTools,
      ...(allowDelegation && record ? [
        ...(allowed.has("mention_employee") ? [createMentionEmployeeTool({ delegate: (toolCallId, input, signal) => this.mention(record, authorization, toolCallId, input, signal) })] : []),
        ...(allowed.has("delegate_employee") ? [createDelegateEmployeeTool({ delegate: (toolCallId, input, signal) => this.mention(record, authorization, toolCallId, input, signal) })] : []),
      ] : []),
    ];
    return tools.filter((tool, index) => allowed.has(tool.name) && tools.findIndex((candidate) => candidate.name === tool.name) === index) as ToolDefinition[];
  }

  private allowedTools(snapshot: FrozenSnapshot): Set<string> {
    const policy = snapshot.tool_policy;
    const allowed = policy && typeof policy === "object" ? (policy as Record<string, unknown>).allowed_tools : undefined;
    const names = Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === "string") : [];
    if (names.length === 0) names.push(...DEFAULT_AGENT_TOOLS);
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
    const employeeId = record.employeeId ?? metadata?.entry_employee_id ?? metadata?.coordinator_employee_id;
    if (!employeeId) throw new SessionAuthorizationError("Conversation has no authorized employee");
    const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
    const expert = experts.find((item) => item.employee_id === employeeId);
    if (!expert || expert.revoked) throw new SessionAuthorizationError();
    let rosterEmployeeIds: ReadonlySet<string> | undefined;
    if (metadata?.kind === "group" || metadata?.coordinator_employee_id) {
      rosterEmployeeIds = new Set(this.options.store.listConversationParticipants(record.conversationId).map((item) => item.employee_id));
      if (rosterEmployeeIds.size === 0) rosterEmployeeIds = new Set(experts.filter((item) => !item.revoked).map((item) => item.employee_id));
      if (!rosterEmployeeIds.has(employeeId)) throw new SessionAuthorizationError("Employee is not in the authorized group roster");
    }
    const snapshot = this.options.store.listSnapshots(caller.tenantId, memberId).find((item) => item.employee_id === employeeId && item.version === expert.version);
    if (!snapshot) throw new SessionAuthorizationError("Conversation employee snapshot is not available locally");
    const mentionedEmployeeIds = mentions.length
      ? new Set(experts.filter((item) => (!rosterEmployeeIds || rosterEmployeeIds.has(item.employee_id)) && mentions.includes(item.handle)).map((item) => item.employee_id))
      : undefined;
    // The coordinator's platform-owned mention tool is available for every
    // coordinator conversation; target delivery still rechecks the authorized
    // solution/roster and fails closed for invalid targets.
    const peerMentionAllowed = record.role === "coordinator" && Boolean(metadata?.coordinator_employee_id);
    return { caller, employeeId, snapshot, mentionedEmployeeIds, rosterEmployeeIds, peerMentionAllowed, permissionMode: metadata?.permission_mode ?? "read-only", managerClient: this.options.managerClient };
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

  private async flushResourceLoader(loader?: ResourceLoader): Promise<void> {
    const controlled = loader as ControlledResourceLoader | undefined;
    await controlled?.shutdown?.();
  }

  private async deliverToParticipant(command: GroupMessageCommand, employeeId: string): Promise<GroupMessageReply> {
    const caller = command.caller;
    if (!caller) {
      const record = this.ensureRecord(command.conversationId, employeeId);
      return this.promptParticipant(record, command, undefined);
    }
    const metadata = this.options.store.getConversationMetadata(command.conversationId);
    if (!metadata) throw new SessionAuthorizationError("Conversation does not exist");
    if ((metadata.tenant_id && metadata.tenant_id !== caller.tenantId) || (metadata.member_id && metadata.member_id !== (caller.userId ?? caller.callerId))) {
      throw new SessionAuthorizationError("Conversation employee is not authorized locally");
    }
    if (metadata.kind === "group" || metadata.coordinator_employee_id) {
      const participants = this.options.store.listConversationParticipants(command.conversationId);
      const participantIds = new Set(participants.map((participant) => participant.employee_id));
      const memberId = caller.userId ?? caller.callerId;
      const solution = metadata.solution_instance_id
        ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id)
        : undefined;
      if (metadata.solution_instance_id && !solution) throw new SessionAuthorizationError("Solution is no longer authorized locally");
      if (solution && typeof solution.status === "string" && solution.status !== "applied") throw new SessionAuthorizationError("Solution is not active");
      const allowedIds = new Set(solution && Array.isArray(solution.expert_employee_ids)
        ? solution.expert_employee_ids.filter((id): id is string => typeof id === "string")
        : this.options.store.listLoadedExperts(caller.tenantId, memberId).filter((expert) => !expert.revoked).map((expert) => expert.employee_id));
      if (!allowedIds.has(employeeId) || (metadata.solution_instance_id && !participantIds.has(employeeId))) throw new SessionAuthorizationError("Employee is not in the authorized local roster or solution roster");
    } else if (metadata.entry_employee_id !== employeeId) {
      throw new SessionAuthorizationError("Employee is not the private conversation participant");
    }
    const record = this.ensureRecord(command.conversationId, employeeId);
    const authorization = this.resolveAuthorization(record, caller);
    authorization!.groupMessageSource = command.source;
    if (metadata.kind === "group") authorization!.groupContext = this.buildGroupContext(command.conversationId, employeeId);
    if (command.source.type === "employee" && command.source.id === employeeId) throw new SessionAuthorizationError("An employee cannot mention itself");
    return this.promptParticipant(record, command, authorization);
  }

  private async promptParticipant(record: SessionRecord, command: GroupMessageCommand, authorization?: SessionAuthorization): Promise<GroupMessageReply> {
    const employeeId = record.employeeId ?? "conversation";
    const startedAt = Date.now();
    const entriesBefore = record.sessionManager.getEntries().length;
    if (record.prompting) throw new ConversationBusyError();
    record.prompting = true;
    record.aborting = false;
    record.activeToolCallId = command.toolCallId;
    record.activeSourceRef = command.toolCallId ? `${record.conversationId}:${command.toolCallId}` : undefined;
    record.activeSource = command.source;
    record.activeSourceRole = command.source.type === "employee" ? "child" : (record.role === "coordinator" ? "coordinator" : "participant");
    try {
      record.sessionReady = this.ensureSession(record, authorization);
      const session = await record.sessionReady;
      const promptPromise = (async () => {
        await session.prompt(command.text, command.images ? { images: command.images } : undefined);
        this.recordEntrySources(record, command, entriesBefore);
        await this.recordUsage(record, authorization, startedAt, true, entriesBefore);
        return record.sessionManager.getLeafId() ?? undefined;
      })();
      record.promptPromise = promptPromise;
      const entryId = await promptPromise;
      const text = this.latestAssistantText(record.sessionManager.getEntries().slice(entriesBefore));
      return { employeeId, entryId, text };
    } catch (error) {
      this.recordEntrySources(record, command, entriesBefore);
      await this.recordUsage(record, authorization, startedAt, false, entriesBefore);
      throw error;
    } finally {
      record.promptPromise = undefined;
      record.sessionReady = undefined;
      record.prompting = false;
      record.aborting = false;
      record.activeToolCallId = undefined;
      record.activeSourceRef = undefined;
      record.activeSourceRole = undefined;
      record.activeSource = undefined;
      await this.disposeSession(record);
    }
  }

  private async mention(record: SessionRecord, authorization: SessionAuthorization, toolCallId: string, input: DelegateEmployeeInput, signal?: AbortSignal): Promise<string> {
    if (record.role !== "coordinator" || !record.employeeId) throw new Error("Only a group coordinator can mention another employee");
    if (record.aborting || signal?.aborted) throw new Error("Mention aborted");
    const targetEmployeeId = this.resolveEmployeeReference(record, authorization, input.employee_id);
    if (targetEmployeeId === record.employeeId) throw new Error("An employee cannot mention itself");
    const prompt = [input.task, input.context ? `Context:\n${input.context}` : ""].filter(Boolean).join("\n\n");
    if (record.delegateCalls >= MAX_DELEGATE_CALLS) throw new Error(`Mention limit reached (maximum ${MAX_DELEGATE_CALLS})`);
    if (record.delegatePromptChars + prompt.length > MAX_DELEGATE_PROMPT_BUDGET) throw new Error("Mention prompt budget exceeded");
    record.delegateCalls += 1;
    record.delegatePromptChars += prompt.length;
    const result = await this.delivery.deliver({
      conversationId: record.conversationId,
      source: { type: "employee", id: record.employeeId, displayName: authorization.snapshot.display_name },
      targetEmployeeIds: [targetEmployeeId],
      text: prompt,
      toolCallId,
      logicalMessageId: `${record.conversationId}:${toolCallId}`,
      idempotencyKey: `mention:${record.conversationId}:${toolCallId}:${targetEmployeeId}`,
      caller: authorization.caller,
    });
    return result.replies[0]?.text ?? "Employee completed without a textual result.";
  }

  private buildGroupContext(conversationId: string, targetEmployeeId: string): string {
    const metadata = this.options.store.getConversationMetadata(conversationId);
    const tenantId = metadata?.tenant_id ?? undefined;
    const memberId = metadata?.member_id ?? undefined;
    const rows = this.options.store.listConversationParticipants(conversationId);
    const experts = this.options.store.listLoadedExperts(tenantId, memberId, true);
    const snapshots = this.options.store.listSnapshots(tenantId, memberId);
    const solution = metadata?.solution_instance_id
      ? this.options.store.listSolutions(tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id)
      : undefined;
    const participantById = new Map(rows.map((participant) => [participant.employee_id, participant]));
    const orderedIds = uniqueStrings(
      Array.isArray(solution?.expert_employee_ids) ? solution.expert_employee_ids : [],
      rows.map((participant) => participant.employee_id),
    );
    const memberLines = orderedIds.map((employeeId) => {
      const participant = participantById.get(employeeId);
      const expert = experts.find((item) => item.employee_id === employeeId);
      const snapshot = snapshots.find((item) => item.employee_id === employeeId);
      const displayName = groupContextField(snapshot?.display_name) ?? groupContextField(expert?.display_name) ?? employeeId;
      const handle = groupContextField(expert?.handle) ?? employeeId;
      const role = participant?.role === "coordinator" ? "协调专家" : "群成员";
      const intro = groupContextField(snapshot?.persona) ?? groupContextField(expert?.persona);
      const tools = snapshot ? [...this.allowedTools(snapshot)] : uniqueStrings(expert?.tools);
      const skills = uniqueStrings(snapshot?.skill_refs, snapshot?.skills, expert?.skills);
      const knowledge = uniqueStrings(snapshot?.knowledge_refs, expert?.knowledge_refs);
      const connectors = uniqueStrings(snapshot?.connector_refs, expert?.connector_refs);
      const lines = [`- ${displayName} (@${handle}) · ${role}`];
      if (intro) lines.push(`  介绍：${intro}`);
      if (tools.length) lines.push(`  工具能力：${tools.join("、")}`);
      if (skills.length) lines.push(`  技能能力：${skills.join("、")}`);
      if (knowledge.length) lines.push(`  知识范围：${knowledge.join("、")}`);
      if (connectors.length) lines.push(`  连接器能力：${connectors.join("、")}`);
      return lines.join("\n");
    });
    const sections: string[] = [];
    if (solution) {
      const name = groupContextField(solution.display_name) ?? solution.solution_instance_id;
      const version = groupContextField(solution.version);
      const sourceId = groupContextField(solution.solution_id);
      const description = groupContextField(solution.description);
      const tags = uniqueStrings(solution.tags);
      const workflow = groupContextReference(solution.workflow_skill_ref);
      const instructions = groupContextField(solution.coordinator_instructions);
      const requirements = groupContextField(solution.output_requirements);
      sections.push([
        `当前解决方案：${name}${version ? `（版本 ${version}）` : ""}`,
        sourceId ? `方案来源：${sourceId}` : "",
        description ? `方案介绍：${description}` : "",
        tags.length ? `方案标签：${tags.join("、")}` : "",
        workflow ? `方案工作流技能：${workflow}` : "",
        instructions ? `方案协作说明：${instructions}` : "",
        requirements ? `方案交付要求：${requirements}` : "",
      ].filter(Boolean).join("\n"));
    }
    if (memberLines.length) sections.push(`群聊成员信息（仅作协作参考，实际权限以当前员工快照为准）：\n${memberLines.join("\n")}`);
    for (const participant of rows) {
      if (participant.employee_id === targetEmployeeId) continue;
      const record = this.ensureRecord(conversationId, participant.employee_id);
      const messages = record.sessionManager.getEntries()
        .filter((entry) => entry.type === "message")
        .slice(-4)
        .map((entry) => {
          if (entry.message.role !== "user" && entry.message.role !== "assistant") return "";
          const content = entry.message.content;
          const text = typeof content === "string"
            ? content
            : content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join(" ");
          const normalized = text.replace(/\s+/gu, " ").trim();
          return normalized ? `${entry.message.role === "user" ? "用户" : "Agent"}: ${normalized.slice(0, 600)}` : "";
        })
        .filter(Boolean);
      if (messages.length > 0) sections.push(`参与者 ${participant.employee_id} 的近期消息：\n${messages.join("\n")}`);
    }
    return boundGroupContext(sections.join("\n\n"));
  }

  private recordEntrySources(record: SessionRecord, command: GroupMessageCommand, entriesBefore: number): void {
    if (!record.employeeId) return;
    for (const entry of record.sessionManager.getEntries().slice(entriesBefore)) {
      if (entry.type !== "message" || entry.message.role !== "user" || typeof entry.id !== "string") continue;
      this.options.store.upsertConversationEntrySource({
        conversation_id: record.conversationId,
        employee_id: record.employeeId,
        pi_entry_id: entry.id,
        logical_message_id: command.logicalMessageId,
        source_type: command.source.type,
        source_id: command.source.id,
        ...(command.source.displayName ? { source_display_name: command.source.displayName } : {}),
      });
    }
  }

  private latestAssistantText(entries: readonly SessionEntry[]): string {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const text = entry.message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("").trim();
      if (text) return text.slice(0, MAX_DELEGATE_RESULT_CHARS);
    }
    return "Employee completed without a textual result.";
  }

  private decorateEntry(record: SessionRecord, entry: SessionEntry): SessionEntry {
    if (!record.employeeId || !record.role) return entry;
    const indexed = this.options.store.getConversation(record.conversationId);
    const expert = this.options.store.listLoadedExperts(indexed?.tenantId ?? undefined, indexed?.memberId ?? undefined, true).find((item) => item.employee_id === record.employeeId);
    const base = entry as unknown as Record<string, unknown>;
    if (entry.type === "message" && entry.message.role === "user" && typeof entry.id === "string") {
      const source = this.options.store.getConversationEntrySource(record.conversationId, record.employeeId, entry.id);
      if (source) return {
        ...base,
        source_type: source.source_type,
        source_id: source.source_id,
        ...(source.source_display_name ? { source_display_name: source.source_display_name } : {}),
        source_role: source.source_type === "employee" ? "participant" : "human",
        logical_message_id: source.logical_message_id,
      } as unknown as SessionEntry;
    }
    return {
      ...base,
      source_employee_id: record.employeeId,
      source_employee_display_name: expert?.display_name ?? record.employeeId,
      source_role: record.role,
    } as unknown as SessionEntry;
  }

  private resolveEmployeeReference(record: SessionRecord, authorization: SessionAuthorization, reference: string): string {
    const metadata = this.options.store.getConversationMetadata(record.conversationId);
    const memberId = authorization.caller.userId ?? authorization.caller.callerId;
    const participants = this.options.store.listConversationParticipants(record.conversationId);
    const solution = metadata?.solution_instance_id
      ? this.options.store.listSolutions(authorization.caller.tenantId, memberId).find((item) => item.solution_instance_id === metadata.solution_instance_id)
      : undefined;
    const roster = new Set(
      metadata?.kind === "group" && participants.length > 0
        ? participants.map((participant) => participant.employee_id)
        : solution && Array.isArray(solution.expert_employee_ids)
          ? solution.expert_employee_ids.filter((employeeId): employeeId is string => typeof employeeId === "string")
          : this.options.store.listLoadedExperts(authorization.caller.tenantId, memberId).filter((expert) => !expert.revoked).map((expert) => expert.employee_id),
    );
    const matches = this.options.store.listLoadedExperts(authorization.caller.tenantId, memberId).filter((expert) =>
      !expert.revoked && roster.has(expert.employee_id)
      && (expert.employee_id === reference || expert.handle === reference || expert.display_name === reference),
    );
    if (matches.length !== 1) throw new SessionAuthorizationError("Mentioned employee is not in the authorized local roster or solution roster");
    return matches[0]!.employee_id;
  }

  private async resolveHindsightRuntimeConfig(authorization?: SessionAuthorization): Promise<HindsightRuntimeConfig | undefined> {
    if (!authorization || !isMemoryPolicyEnabled(authorization.snapshot)) return undefined;
    if (authorization.managerClient?.pullHindsightRuntimeConfig) {
      const config = await authorization.managerClient.pullHindsightRuntimeConfig(authorization.caller, authorization.employeeId);
      if (!config) throw new SessionAuthorizationError("Manager Hindsight lease is unavailable");
      return config;
    }
    // Managerless fixtures/development sessions cannot obtain the default
    // memory lease; keep them local and avoid turning the platform default into
    // an unexpected production dependency.
    if (authorization.snapshot.memory_policy === undefined || authorization.snapshot.memory_policy === null) return undefined;
    if (process.env.AITEAM_ENV === "production") {
      throw new SessionAuthorizationError("Manager Hindsight lease is unavailable");
    }
    // Development/faux sessions may omit the external memory lease; no Hindsight
    // tools or local bank are created in that case.
    return undefined;
  }

  private async ensureRuntimeModel(authorization: SessionAuthorization): Promise<{ model: Model<any>; providerId?: string }> {
    // Development E2E/faux sessions intentionally use the deterministic Pi
    // model and must not contact the seeded dummy Provider endpoint. Production
    // never enables this option because launch guards reject AITEAM_PI_FAKE.
    if (this.options.useFauxModel) return { model: this.requireDefaultModel() };
    if (!authorization.managerClient?.pullRuntimeConfig) {
      if (!this.options.model) throw new SessionAuthorizationError("No authenticated Pi model is available");
      return { model: this.options.model };
    }
    const memberId = authorization.caller.userId ?? authorization.caller.callerId;
    const config = await authorization.managerClient.pullRuntimeConfig(authorization.caller, authorization.employeeId);
    const policy = authorization.snapshot.model_policy;
    const expectedModel = policy && typeof policy === "object" && typeof (policy as Record<string, unknown>).model === "string" ? (policy as Record<string, unknown>).model : undefined;
    const expectedProvider = policy && typeof policy === "object" && typeof (policy as Record<string, unknown>).provider_ref === "string" ? (policy as Record<string, unknown>).provider_ref : undefined;
    const expectedProviderVersion = policy && typeof policy === "object" ? (policy as Record<string, unknown>).provider_version : undefined;
    const expectedModelVersion = policy && typeof policy === "object" ? (policy as Record<string, unknown>).model_version : undefined;
    const expectedPricing = policy && typeof policy === "object" ? (policy as Record<string, unknown>).pricing : undefined;
    const expectedPricingVersion = expectedPricing && typeof expectedPricing === "object" ? (expectedPricing as Record<string, unknown>).pricing_version : undefined;
    if (!expectedModel || !expectedProvider || config.model !== expectedModel || config.provider_ref !== expectedProvider || config.provider_version !== expectedProviderVersion || config.model_version !== expectedModelVersion || config.pricing.pricing_version !== expectedPricingVersion) throw new SessionAuthorizationError("Manager runtime config does not match the employee snapshot");
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

  private publish(record: SessionRecord, event: AgentSessionEvent): void {
    const indexed = this.options.store.getConversation(record.conversationId);
    const expert = record.employeeId
      ? this.options.store.listLoadedExperts(indexed?.tenantId ?? undefined, indexed?.memberId ?? undefined, true).find((item) => item.employee_id === record.employeeId)
      : undefined;
    const raw = event as unknown as Record<string, unknown>;
    const message = raw.message as Record<string, unknown> | undefined;
    const isUserMessage = message?.role === "user";
    const metadata = record.employeeId
      ? isUserMessage && record.activeSource?.type === "human"
        ? { conversation_id: record.conversationId, source_role: "human" as const }
        : isUserMessage && record.activeSource?.type === "employee"
          ? {
              conversation_id: record.conversationId,
              source_employee_id: record.activeSource.id,
              source_employee_display_name: record.activeSource.displayName ?? record.activeSource.id,
              source_role: "participant" as const,
            }
          : {
              conversation_id: record.conversationId,
              ...(record.activeSourceRef ? { source_ref: record.activeSourceRef } : {}),
              ...(record.activeToolCallId ? { tool_call_id: record.activeToolCallId } : {}),
              source_employee_id: record.employeeId,
              source_employee_display_name: expert?.display_name ?? record.employeeId,
              source_role: record.activeSourceRole ?? (record.role === "coordinator" ? "coordinator" as const : "participant" as const),
            }
      : { conversation_id: record.conversationId };
    if (!serializePiEvent(event, metadata)) return;
    const entryId = this.entryIdentity(event);
    const envelope: PiEventEnvelope = {
      id: entryId && record.employeeId ? `${record.employeeId}:${entryId}` : entryId ?? `${record.conversationId}:${++record.eventSequence}`,
      event,
      ...metadata,
    };
    for (const subscriber of this.listeners.get(record.conversationId) ?? []) {
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
    if (!this.options.sandbox) return false;
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

function uniqueStrings(...values: unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== "string" || !item.trim()) continue;
      seen.add(item.trim());
    }
  }
  return [...seen];
}

function groupContextField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, MAX_GROUP_CONTEXT_FIELD_CHARS) : undefined;
}

function groupContextReference(value: unknown): string | undefined {
  if (typeof value === "string") return groupContextField(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = groupContextField(record.skill_id ?? record.skill_ref ?? record.id);
  const version = groupContextField(record.version);
  return id ? `${id}${version ? `@${version}` : ""}` : undefined;
}

function boundGroupContext(value: string): string {
  if (value.length <= MAX_GROUP_CONTEXT_CHARS) return value;
  const head = Math.floor(MAX_GROUP_CONTEXT_CHARS / 2);
  const tail = MAX_GROUP_CONTEXT_CHARS - head - 1;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
