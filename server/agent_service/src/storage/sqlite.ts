import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type ReceiptState = "accepted" | "completed" | "unknown";

export interface ConversationRecord {
  id: string;
  sessionFile: string;
  workspace: string;
}

export interface PersistedEvent {
  conversationId: string;
  cursor: number;
  event: string;
}

export interface IdempotencyReceipt {
  conversationId: string;
  callerId: string;
  key: string;
  fingerprint: string;
  state: ReceiptState;
  lastEntryId?: string;
  ownerInstance?: string;
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
  owner_instance: string | null;
  lease_expires_at: string | null;
  last_entry_id: string | null;
}

interface ConversationRow {
  id: string;
  session_file: string;
  workspace: string;
}

interface EventRow {
  conversation_id: string;
  cursor: number;
  event_json: string;
}

const DEFAULT_LEASE_MS = 30_000;

export class AgentSqliteStore {
  readonly db: DatabaseSync;
  private readonly instanceId = randomUUID();

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

      CREATE TABLE IF NOT EXISTS pi_event (
        conversation_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, cursor)
      );
    `);
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

  appendEvent(conversationId: string, event: unknown): number {
    const cursor = (this.db
      .prepare("SELECT COALESCE(MAX(cursor), 0) + 1 AS next_cursor FROM pi_event WHERE conversation_id = ?")
      .get(conversationId) as { next_cursor: number }).next_cursor;
    this.db
      .prepare("INSERT INTO pi_event (conversation_id, cursor, event_json, created_at) VALUES (?, ?, ?, ?)")
      .run(conversationId, cursor, JSON.stringify(event), new Date().toISOString());
    // Keep the local log bounded while retaining enough history for reconnects.
    this.db.prepare("DELETE FROM pi_event WHERE conversation_id = ? AND cursor <= ?").run(conversationId, cursor - 2048);
    return cursor;
  }

  getEvents(conversationId: string, after?: number): PersistedEvent[] {
    const rows = this.db
      .prepare(`
        SELECT conversation_id, cursor, event_json
        FROM pi_event
        WHERE conversation_id = ? AND cursor > ?
        ORDER BY cursor ASC
      `)
      .all(conversationId, after ?? 0) as unknown as EventRow[];
    return rows.map((row) => ({ conversationId: row.conversation_id, cursor: row.cursor, event: row.event_json }));
  }

  getEventBounds(conversationId: string): { first?: number; last?: number } {
    const row = this.db
      .prepare("SELECT MIN(cursor) AS first, MAX(cursor) AS last FROM pi_event WHERE conversation_id = ?")
      .get(conversationId) as { first: number | null; last: number | null };
    return { first: row.first ?? undefined, last: row.last ?? undefined };
  }

  reservePrompt(input: {
    conversationId: string;
    callerId: string;
    key: string;
    fingerprint: string;
    leaseMs?: number;
  }): IdempotencyReceipt {
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(`
          SELECT conversation_id, caller_id, idempotency_key,
                 request_fingerprint, state, owner_instance,
                 lease_expires_at, last_entry_id
          FROM idempotency_receipt
          WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
        `)
        .get(input.conversationId, input.callerId, input.key) as ReceiptRow | undefined;

      if (existing) {
        if (existing.request_fingerprint !== input.fingerprint) throw new IdempotencyConflictError();
        const expired = !existing.lease_expires_at || existing.lease_expires_at <= now.toISOString();
        if (existing.state === "completed") return this.finishTransaction(existing);
        if (!expired) {
          if (existing.state === "unknown") throw new IdempotencyUnknownError();
          return this.finishTransaction(existing);
        }

        const ownerInstance = randomUUID();
        this.db
          .prepare(`
            UPDATE idempotency_receipt
            SET state = 'accepted', owner_instance = ?, lease_expires_at = ?, accepted_at = ?, completed_at = NULL
            WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
          `)
          .run(ownerInstance, leaseExpiresAt, now.toISOString(), input.conversationId, input.callerId, input.key);
        this.db.exec("COMMIT");
        return {
          conversationId: input.conversationId,
          callerId: input.callerId,
          key: input.key,
          fingerprint: input.fingerprint,
          state: "accepted",
          ownerInstance,
          isNew: true,
        };
      }

      const ownerInstance = randomUUID();
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
          ownerInstance,
          leaseExpiresAt,
          now.toISOString(),
        );
      this.db.exec("COMMIT");
      return {
        conversationId: input.conversationId,
        callerId: input.callerId,
        key: input.key,
        fingerprint: input.fingerprint,
        state: "accepted",
        ownerInstance,
        isNew: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(conversationId: string, callerId: string, key: string, ownerInstance?: string, leaseMs = DEFAULT_LEASE_MS): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt SET lease_expires_at = ?
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
          AND state = 'accepted' AND owner_instance = ?
      `)
      .run(new Date(Date.now() + leaseMs).toISOString(), conversationId, callerId, key, ownerInstance ?? this.instanceId);
  }

  markCompleted(conversationId: string, callerId: string, key: string, lastEntryId?: string, ownerInstance?: string): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt
        SET state = 'completed', completed_at = ?, lease_expires_at = NULL, last_entry_id = ?
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
          AND state = 'accepted' AND owner_instance = ?
      `)
      .run(new Date().toISOString(), lastEntryId ?? null, conversationId, callerId, key, ownerInstance ?? this.instanceId);
  }

  markUnknown(conversationId: string, callerId: string, key: string, ownerInstance?: string, retryAfterMs = DEFAULT_LEASE_MS): void {
    this.db
      .prepare(`
        UPDATE idempotency_receipt
        SET state = 'unknown', lease_expires_at = ?
        WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ?
          AND state = 'accepted' AND owner_instance = ?
      `)
      .run(new Date(Date.now() + retryAfterMs).toISOString(), conversationId, callerId, key, ownerInstance ?? this.instanceId);
  }

  close(): void {
    this.db.close();
  }

  private finishTransaction(row: ReceiptRow): IdempotencyReceipt {
    this.db.exec("COMMIT");
    return this.toReceipt(row);
  }

  private toReceipt(row: ReceiptRow): IdempotencyReceipt {
    return {
      conversationId: row.conversation_id,
      callerId: row.caller_id,
      key: row.idempotency_key,
      fingerprint: row.request_fingerprint,
      state: row.state,
      lastEntryId: row.last_entry_id ?? undefined,
      ownerInstance: row.owner_instance ?? undefined,
      isNew: false,
    };
  }
}
