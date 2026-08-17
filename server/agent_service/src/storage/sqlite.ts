import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type ReceiptState = "accepted" | "completed" | "unknown";

export interface ConversationRecord {
  id: string;
  sessionFile: string;
  workspace: string;
}

export interface IdempotencyReceipt {
  conversationId: string;
  callerId: string;
  key: string;
  fingerprint: string;
  state: ReceiptState;
  lastEntryId?: string;
  isNew: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency-Key is already bound to a different request") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyUnknownError extends Error {
  constructor(message = "The previous request has unknown execution state") {
    super(message);
    this.name = "IdempotencyUnknownError";
  }
}

interface ReceiptRow {
  conversation_id: string;
  caller_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  state: ReceiptState;
  last_entry_id: string | null;
}

interface ConversationRow {
  id: string;
  session_file: string;
  workspace: string;
}

export class AgentSqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_receipt (
        conversation_id TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'completed', 'unknown')),
        owner_instance TEXT,
        lease_expires_at TEXT,
        accepted_at TEXT NOT NULL,
        completed_at TEXT,
        last_entry_id TEXT,
        PRIMARY KEY (conversation_id, caller_id, idempotency_key)
      );
    `);
    this.recoverExpiredAcceptedReceipts();
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.db
      .prepare("SELECT id, session_file, workspace FROM conversation WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row
      ? { id: row.id, sessionFile: row.session_file, workspace: row.workspace }
      : undefined;
  }

  saveConversation(record: ConversationRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO conversation (id, session_file, workspace, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_file = excluded.session_file,
          workspace = excluded.workspace,
          updated_at = excluded.updated_at
      `)
      .run(record.id, record.sessionFile, record.workspace, now, now);
  }

  reservePrompt(input: {
    conversationId: string;
    callerId: string;
    key: string;
    fingerprint: string;
    leaseMs?: number;
  }): IdempotencyReceipt {
    const existing = this.db
      .prepare(`
        SELECT conversation_id, caller_id, idempotency_key,
               request_fingerprint, state, last_entry_id
        FROM idempotency_receipt
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
      `)
      .get(input.conversationId, input.callerId, input.key) as ReceiptRow | undefined;

    if (existing) {
      if (existing.request_fingerprint !== input.fingerprint) {
        throw new IdempotencyConflictError();
      }
      if (existing.state === "unknown") {
        throw new IdempotencyUnknownError();
      }
      return this.toReceipt(existing);
    }

    const acceptedAt = new Date();
    const leaseExpiresAt = new Date(acceptedAt.getTime() + (input.leaseMs ?? 30_000));
    this.db
      .prepare(`
        INSERT INTO idempotency_receipt (
          conversation_id, caller_id, idempotency_key,
          request_fingerprint, state, owner_instance,
          lease_expires_at, accepted_at
        ) VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)
      `)
      .run(
        input.conversationId,
        input.callerId,
        input.key,
        input.fingerprint,
        process.pid.toString(),
        leaseExpiresAt.toISOString(),
        acceptedAt.toISOString(),
      );

    return {
      conversationId: input.conversationId,
      callerId: input.callerId,
      key: input.key,
      fingerprint: input.fingerprint,
      state: "accepted",
      isNew: true,
    };
  }

  markCompleted(conversationId: string, callerId: string, key: string, lastEntryId?: string): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt
        SET state = 'completed', completed_at = ?, lease_expires_at = NULL, last_entry_id = ?
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
      `)
      .run(new Date().toISOString(), lastEntryId ?? null, conversationId, callerId, key);
  }

  markUnknown(conversationId: string, callerId: string, key: string): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt
        SET state = 'unknown', lease_expires_at = NULL
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
      `)
      .run(conversationId, callerId, key);
  }

  close(): void {
    this.db.close();
  }

  private recoverExpiredAcceptedReceipts(): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt
        SET state = 'unknown', lease_expires_at = NULL
        WHERE state = 'accepted' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
      `)
      .run(new Date().toISOString());
  }

  private toReceipt(row: ReceiptRow): IdempotencyReceipt {
    return {
      conversationId: row.conversation_id,
      callerId: row.caller_id,
      key: row.idempotency_key,
      fingerprint: row.request_fingerprint,
      state: row.state,
      lastEntryId: row.last_entry_id ?? undefined,
      isNew: false,
    };
  }
}
