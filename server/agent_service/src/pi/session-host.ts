import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { AuthenticatedCaller } from "../http/auth.js";
import type { ManagerClient } from "../manager-client.js";
import type { AgentSqliteStore, FrozenSnapshot } from "../storage/sqlite.js";
import { createKnowledgeTools } from "../tools/knowledge.js";
import { createMemoryTools } from "../tools/memory.js";
import { createDelegateEmployeeTool, type DelegateEmployeeInput } from "../tools/delegate.js";
import { serializePiEvent } from "./event-sse.js";
import type { UsageCapture } from "../usage.js";

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
  managerClient?: ManagerClient;
}

export interface SessionHostOptions {
  cwdRoot: string;
  agentDir: string;
  sessionDir: string;
  store: AgentSqliteStore;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  resourceLoaderFactory: (conversationId: string, authorization?: SessionAuthorization) => ResourceLoader;
  managerClient?: ManagerClient;
  customTools?: ToolDefinition[];
  sandboxAvailable?: () => boolean;
  usageRecorder?: (capture: UsageCapture) => void | Promise<void>;
}

interface Subscriber {
  listener: (envelope: PiEventEnvelope) => void;
  replaying: boolean;
  queued: PiEventEnvelope[];
}

interface ChildSession {
  session?: AgentSession;
  aborted: boolean;
  abort: () => Promise<void>;
}

interface SessionRecord {
  conversationId: string;
  workspace: string;
  sessionManager: SessionManager;
  session?: AgentSession;
  sessionReady?: Promise<AgentSession>;
  unsubscribe?: () => void;
  prompting: boolean;
  aborting: boolean;
  delegateCalls: number;
  delegatePromptChars: number;
  activeDelegates: Set<ChildSession>;
  listeners: Set<Subscriber>;
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
    const record = await this.ensureRecord(conversationId);
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

  async prompt(conversationId: string, text: string, images?: ImageContent[], caller?: AuthenticatedCaller): Promise<string | undefined> {
    const record = await this.ensureRecord(conversationId);
    if (record.prompting) throw new ConversationBusyError();
    record.prompting = true;
    record.aborting = false;
    record.delegateCalls = 0;
    record.delegatePromptChars = 0;

    try {
      const authorization = caller ? this.resolveAuthorization(record, caller) : undefined;
      record.sessionReady = this.ensureSession(record, authorization);
      const session = await record.sessionReady;
      const startedAt = Date.now();
      const entriesBefore = record.sessionManager.getEntries().length;
      try {
        await session.prompt(text, images ? { images } : undefined);
        await this.recordUsage(record, authorization, startedAt, true, entriesBefore);
        return record.sessionManager.getLeafId() ?? undefined;
      } catch (error) {
        await this.recordUsage(record, authorization, startedAt, false, entriesBefore);
        throw error;
      }
    } finally {
      record.sessionReady = undefined;
      record.prompting = false;
      record.aborting = false;
      await this.abortChildren(record);
      this.disposeSession(record);
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
      await this.abortChildren(record);
      await record.session?.abort().catch(() => undefined);
      this.disposeSession(record);
      this.records.delete(conversationId);
    }
    for (const path of [indexed.sessionFile, indexed.workspace]) {
      if (!path) continue;
      this.assertManagedPathEither(path, path === indexed.workspace ? this.options.cwdRoot : this.options.sessionDir, this.options.cwdRoot);
      rmSync(path, { recursive: true, force: true });
    }
    return this.options.store.deleteConversation(conversationId, tenantId, memberId);
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.records.values()].map(async (record) => {
      if (!record.prompting) return;
      record.aborting = true;
      await record.session?.abort().catch(() => undefined);
    }));
  }

  async entries(conversationId: string) {
    const record = await this.ensureRecord(conversationId);
    return record.sessionManager.getEntries();
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) {
      await this.abortChildren(record);
      await record.session?.abort().catch(() => undefined);
      this.disposeSession(record);
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
      entries: record.sessionManager.getEntries().slice(entriesBefore),
      settled,
    });
  }

  private async ensureRecord(conversationId: string): Promise<SessionRecord> {
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
      activeDelegates: new Set(),
      listeners: new Set(),
    };
    this.records.set(conversationId, record);
    return record;
  }

  private async ensureSession(record: SessionRecord, authorization?: SessionAuthorization): Promise<AgentSession> {
    if (record.session) return record.session;
    const resourceLoader = this.options.resourceLoaderFactory(record.conversationId, authorization);
    await resourceLoader.reload();
    const customTools = this.toolsFor(authorization, true, record);
    if (authorization && this.hasCodingTools(authorization.snapshot) && !this.options.sandboxAvailable?.()) {
      throw new SessionAuthorizationError("Coding tools require an available external sandbox");
    }
    const result = await createAgentSession({
      cwd: record.workspace,
      agentDir: this.options.agentDir,
      model: this.options.model,
      thinkingLevel: this.thinkingLevelFor(authorization),
      modelRuntime: this.options.modelRuntime,
      resourceLoader,
      sessionManager: record.sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: customTools.map((tool) => tool.name),
      customTools,
    });
    record.session = result.session;
    try { chmodSync(record.sessionManager.getSessionFile()!, 0o600); } catch { /* SDK may defer the first write */ }
    record.unsubscribe = result.session.subscribe((event) => this.publish(record, event));
    return result.session;
  }

  private toolsFor(authorization?: SessionAuthorization, allowDelegation = true, record?: SessionRecord): ToolDefinition[] {
    if (!authorization) return this.options.customTools ?? [];
    const allowed = this.allowedTools(authorization.snapshot);
    const tools = [
      ...(this.options.customTools ?? []).filter((tool) => allowDelegation || tool.name !== "delegate_employee"),
      ...createMemoryTools({ caller: authorization.caller, employeeId: authorization.employeeId, managerClient: authorization.managerClient }),
      ...createKnowledgeTools({ caller: authorization.caller, employeeId: authorization.employeeId, knowledgeRefs: this.knowledgeRefs(authorization.snapshot), managerClient: authorization.managerClient }),
      ...(allowDelegation && record ? [createDelegateEmployeeTool({ delegate: (toolCallId, input, signal) => this.delegate(record, authorization, toolCallId, input, signal) })] : []),
    ];
    return tools.filter((tool, index) => allowed.has(tool.name) && tools.findIndex((candidate) => candidate.name === tool.name) === index);
  }

  private allowedTools(snapshot: FrozenSnapshot): Set<string> {
    const policy = snapshot.tool_policy;
    if (!policy || typeof policy !== "object") return new Set();
    const allowed = (policy as Record<string, unknown>).allowed_tools;
    return new Set(Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === "string") : []);
  }

  private knowledgeRefs(snapshot: FrozenSnapshot): string[] {
    return Array.isArray(snapshot.knowledge_refs) ? snapshot.knowledge_refs.filter((ref): ref is string => typeof ref === "string") : [];
  }

  private thinkingLevelFor(authorization?: SessionAuthorization): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    const policy = authorization?.snapshot.model_policy;
    const value = policy && typeof policy === "object"
      ? (policy as Record<string, unknown>).thinking_level
      : undefined;
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "off";
  }

  private resolveAuthorization(record: SessionRecord, caller: AuthenticatedCaller): SessionAuthorization | undefined {
    const metadata = this.options.store.getConversationMetadata(record.conversationId);
    const employeeId = metadata?.entry_employee_id ?? metadata?.coordinator_employee_id;
    if (!employeeId) throw new SessionAuthorizationError("Conversation has no authorized employee");
    const expert = this.options.store.listLoadedExperts().find((item) => item.employee_id === employeeId);
    if (!expert || expert.revoked || (caller.tenantId && expert.tenant_id !== caller.tenantId)) throw new SessionAuthorizationError();
    const snapshot = this.options.store.listSnapshots().find((item) => item.employee_id === employeeId && item.version === expert.version && (!caller.tenantId || !item.tenant_id || item.tenant_id === caller.tenantId));
    if (!snapshot) throw new SessionAuthorizationError("Conversation employee snapshot is not available locally");
    return { caller, employeeId, snapshot, managerClient: this.options.managerClient };
  }

  private disposeSession(record: SessionRecord): void {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.session?.dispose();
    record.session = undefined;
  }

  private async abortChildren(record: SessionRecord): Promise<number> {
    const children = [...record.activeDelegates];
    await Promise.all(children.map((child) => child.abort().catch(() => undefined)));
    return children.length;
  }

  private async delegate(record: SessionRecord, authorization: SessionAuthorization, toolCallId: string, input: DelegateEmployeeInput, signal?: AbortSignal): Promise<string> {
    if (!authorization.caller.tenantId) throw new Error("Authenticated tenant is required for delegation");
    const expert = this.options.store.listLoadedExperts().find((item) => item.employee_id === input.employee_id && item.tenant_id === authorization.caller.tenantId && !item.revoked);
    if (!expert) throw new Error("Employee is not in the authorized local roster");
    const snapshot = this.options.store.listSnapshots().find((item) => item.employee_id === input.employee_id && item.version === expert.version);
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

    const child: ChildSession = { aborted: false, abort: async () => { child.aborted = true; await child.session?.abort(); } };
    record.activeDelegates.add(child);
    const sourceRef = createHash("sha256").update(`${record.conversationId}:${toolCallId}:${Date.now()}`).digest("hex").slice(0, 24);
    try {
      const sessionManager = SessionManager.inMemory(record.workspace);
      const resourceLoader = this.options.resourceLoaderFactory(`${record.conversationId}:${sourceRef}`, { ...authorization, employeeId: snapshot.employee_id, snapshot });
      await resourceLoader.reload();
      const childTools = this.toolsFor({ ...authorization, employeeId: snapshot.employee_id, snapshot }, false);
      const result = await createAgentSession({
        cwd: record.workspace,
        agentDir: this.options.agentDir,
        model: this.modelFor(snapshot),
        thinkingLevel: this.thinkingLevelFor({ ...authorization, snapshot }),
        modelRuntime: this.options.modelRuntime,
        resourceLoader,
        sessionManager,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        tools: childTools.map((tool) => tool.name),
        customTools: childTools,
      });
      child.session = result.session;
      if (child.aborted || signal?.aborted || record.aborting) await child.abort();
      const unsubscribe = result.session.subscribe((event) => this.publishChild(record, event, sourceRef, toolCallId));
      try {
        await result.session.prompt(prompt);
        return this.childSummary(sessionManager.getEntries());
      } finally {
        unsubscribe();
        await child.abort();
        result.session.dispose();
      }
    } finally {
      record.activeDelegates.delete(child);
    }
  }

  private modelFor(snapshot: FrozenSnapshot): Model<any> {
    const policy = snapshot.model_policy;
    if (policy && typeof policy === "object") {
      const values = policy as Record<string, unknown>;
      const provider = typeof values.provider === "string" ? values.provider : typeof values.provider_ref === "string" ? values.provider_ref : undefined;
      const model = typeof values.model === "string" ? values.model : typeof values.model_id === "string" ? values.model_id : undefined;
      if (provider && model) return this.options.modelRuntime.getModel(provider, model) ?? this.options.model;
    }
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
    const envelope: PiEventEnvelope = { id: `${sourceRef}:${Date.now()}`, event, conversation_id: record.conversationId, source_ref: sourceRef, tool_call_id: toolCallId };
    for (const subscriber of record.listeners) {
      if (subscriber.replaying) subscriber.queued.push(envelope);
      else subscriber.listener(envelope);
    }
  }

  private publish(record: SessionRecord, event: AgentSessionEvent): void {
    if (!serializePiEvent(event)) return;
    const envelope: PiEventEnvelope = {
      id: this.entryIdentity(event) ?? `${record.conversationId}:${Date.now()}`,
      event,
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
