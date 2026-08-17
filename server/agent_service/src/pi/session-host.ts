import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSqliteStore } from "../storage/sqlite.js";

export interface PiEventEnvelope {
  id: string;
  event: AgentSessionEvent;
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

export interface SessionHostOptions {
  cwdRoot: string;
  agentDir: string;
  sessionDir: string;
  store: AgentSqliteStore;
  modelRuntime: ModelRuntime;
  model: Model<any>;
  resourceLoaderFactory: (conversationId: string) => ResourceLoader;
  customTools?: ToolDefinition[];
}

interface Subscriber {
  listener: (envelope: PiEventEnvelope) => void;
  replaying: boolean;
  queued: PiEventEnvelope[];
}

interface SessionRecord {
  conversationId: string;
  workspace: string;
  sessionManager: SessionManager;
  session?: AgentSession;
  sessionReady?: Promise<AgentSession>;
  unsubscribe?: () => void;
  prompting: boolean;
  listeners: Set<Subscriber>;
}

export class ConversationBusyError extends Error {
  constructor() {
    super("Conversation already has an active Pi prompt");
    this.name = "ConversationBusyError";
  }
}

export class SessionHost {
  private readonly records = new Map<string, SessionRecord>();

  constructor(private readonly options: SessionHostOptions) {
    mkdirSync(options.cwdRoot, { recursive: true });
    mkdirSync(options.sessionDir, { recursive: true });
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
      const cursor = this.parseCursor(after);
      const bounds = this.options.store.getEventBounds(conversationId);
      if (cursor !== undefined && bounds.first !== undefined && cursor < bounds.first - 1) {
        throw new EventCursorStaleError(cursor, bounds.first);
      }

      let events = this.options.store.getEvents(conversationId, cursor);
      if (events.length === 0 && cursor === undefined) {
        this.persistExistingEntries(record);
        events = this.options.store.getEvents(conversationId);
      }
      for (const persisted of events) {
        listener({ id: String(persisted.cursor), event: JSON.parse(persisted.event) as AgentSessionEvent });
      }
      subscriber.replaying = false;
      for (const envelope of subscriber.queued.splice(0)) listener(envelope);
    } catch (error) {
      record.listeners.delete(subscriber);
      throw error;
    }

    return () => record.listeners.delete(subscriber);
  }

  async prompt(conversationId: string, text: string, images?: ImageContent[]): Promise<string | undefined> {
    const record = await this.ensureRecord(conversationId);
    if (record.prompting) throw new ConversationBusyError();
    record.prompting = true;

    try {
      record.sessionReady = this.ensureSession(record);
      const session = await record.sessionReady;
      await session.prompt(text, images ? { images } : undefined);
      this.publishNewEntries(record);
      return record.sessionManager.getLeafId() ?? undefined;
    } finally {
      record.sessionReady = undefined;
      record.prompting = false;
      this.disposeSession(record);
    }
  }

  async abort(conversationId: string): Promise<boolean> {
    const record = this.records.get(conversationId);
    if (!record) return false;
    const session = record.session ?? (record.sessionReady ? await record.sessionReady : undefined);
    if (!session) return false;
    await session.abort();
    return true;
  }

  isPrompting(conversationId: string): boolean {
    return this.records.get(conversationId)?.prompting ?? false;
  }

  async entries(conversationId: string) {
    const record = await this.ensureRecord(conversationId);
    return record.sessionManager.getEntries();
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) this.disposeSession(record);
    this.records.clear();
  }

  private async ensureRecord(conversationId: string): Promise<SessionRecord> {
    const existing = this.records.get(conversationId);
    if (existing) return existing;

    const indexed = this.options.store.getConversation(conversationId);
    const workspace = indexed?.workspace || join(this.options.cwdRoot, this.safeDirectoryName(conversationId));
    mkdirSync(workspace, { recursive: true });

    let sessionManager: SessionManager;
    if (indexed?.sessionFile && existsSync(indexed.sessionFile)) {
      sessionManager = SessionManager.open(indexed.sessionFile, this.options.sessionDir, workspace);
    } else {
      sessionManager = SessionManager.create(workspace, this.options.sessionDir);
    }

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Persistent SessionManager did not provide a session file");
    this.options.store.saveConversation({ id: conversationId, sessionFile, workspace });

    const record: SessionRecord = {
      conversationId,
      workspace,
      sessionManager,
      prompting: false,
      listeners: new Set(),
    };
    this.records.set(conversationId, record);
    return record;
  }

  private async ensureSession(record: SessionRecord): Promise<AgentSession> {
    if (record.session) return record.session;
    const resourceLoader = this.options.resourceLoaderFactory(record.conversationId);
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: record.workspace,
      agentDir: this.options.agentDir,
      model: this.options.model,
      thinkingLevel: "off",
      modelRuntime: this.options.modelRuntime,
      resourceLoader,
      sessionManager: record.sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: this.options.customTools?.map((tool) => tool.name) ?? [],
      customTools: this.options.customTools,
    });
    record.session = result.session;
    record.unsubscribe = result.session.subscribe((event) => this.publish(record, event));
    return result.session;
  }

  private disposeSession(record: SessionRecord): void {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.session?.dispose();
    record.session = undefined;
  }

  private publish(record: SessionRecord, event: AgentSessionEvent): void {
    const envelope: PiEventEnvelope = {
      id: String(this.options.store.appendEvent(record.conversationId, event)),
      event,
    };
    for (const subscriber of record.listeners) {
      if (subscriber.replaying) subscriber.queued.push(envelope);
      else subscriber.listener(envelope);
    }
  }

  private persistExistingEntries(record: SessionRecord): void {
    for (const entry of record.sessionManager.getEntries()) {
      this.options.store.appendEvent(record.conversationId, { type: "entry_appended", entry });
    }
  }

  private publishNewEntries(record: SessionRecord): void {
    const known = new Set(
      this.options.store.getEvents(record.conversationId).flatMap((item) => {
        try {
          const event = JSON.parse(item.event) as { type?: string; entry?: { id?: string } };
          return event.type === "entry_appended" && event.entry?.id ? [event.entry.id] : [];
        } catch {
          return [];
        }
      }),
    );
    for (const entry of record.sessionManager.getEntries()) {
      if (known.has(entry.id)) continue;
      this.publish(record, { type: "entry_appended", entry });
    }
  }

  private parseCursor(after?: string): number | undefined {
    if (after === undefined || after === "") return undefined;
    if (!/^\d+$/.test(after)) throw new InvalidEventCursorError();
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor)) throw new InvalidEventCursorError();
    return cursor;
  }

  private safeDirectoryName(conversationId: string): string {
    return `conversation-${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`;
  }
}
