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

interface SessionRecord {
  conversationId: string;
  workspace: string;
  sessionManager: SessionManager;
  session?: AgentSession;
  sessionReady?: Promise<AgentSession>;
  unsubscribe?: () => void;
  prompting: boolean;
  sequence: number;
  history: PiEventEnvelope[];
  listeners: Set<(envelope: PiEventEnvelope) => void>;
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
    record.listeners.add(listener);

    const replay = record.history.length > 0 ? record.history : this.entriesAsEvents(record);
    for (const envelope of replay) {
      if (!after || this.isAfter(envelope.id, after, replay)) listener(envelope);
    }

    return () => record.listeners.delete(listener);
  }

  async prompt(conversationId: string, text: string, images?: ImageContent[]): Promise<string | undefined> {
    const record = await this.ensureRecord(conversationId);
    if (record.prompting) throw new ConversationBusyError();
    record.prompting = true;

    try {
      record.sessionReady = this.ensureSession(record);
      const session = await record.sessionReady;
      await session.prompt(text, images ? { images } : undefined);
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
    for (const record of this.records.values()) {
      this.disposeSession(record);
    }
    this.records.clear();
  }

  private async ensureRecord(conversationId: string): Promise<SessionRecord> {
    const existing = this.records.get(conversationId);
    if (existing) return existing;

    const indexed = this.options.store.getConversation(conversationId);
    const workspace = indexed?.workspace ?? join(this.options.cwdRoot, this.safeDirectoryName(conversationId));
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
      sequence: 0,
      history: [],
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
    const envelope: PiEventEnvelope = { id: `${++record.sequence}`, event };
    record.history.push(envelope);
    if (record.history.length > 512) record.history.shift();
    for (const listener of record.listeners) listener(envelope);
  }

  private entriesAsEvents(record: SessionRecord): PiEventEnvelope[] {
    return record.sessionManager.getEntries().map((entry) => ({
      id: `entry-${entry.id}`,
      event: { type: "entry_appended", entry },
    }));
  }

  private isAfter(id: string, after: string, replay: PiEventEnvelope[]): boolean {
    if (id === after) return false;
    if (after.startsWith("entry-")) {
      const afterIndex = replay.findIndex((item) => item.id === after);
      const currentIndex = replay.findIndex((item) => item.id === id);
      return afterIndex < 0 || currentIndex > afterIndex;
    }
    const afterNumber = Number(after);
    return !Number.isFinite(afterNumber) || Number(id) > afterNumber;
  }

  private safeDirectoryName(conversationId: string): string {
    return `conversation-${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`;
  }
}
