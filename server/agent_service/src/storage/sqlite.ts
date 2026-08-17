import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { UsageSummary } from "../usage.js";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

export type ReceiptState = "accepted" | "completed" | "unknown";

export type ConversationState = "draft" | "active" | "paused" | "muted" | "archived";

export interface ConversationRecord {
  id: string;
  sessionFile: string;
  workspace: string;
  title?: string | null;
  kind?: string;
  labels?: string[];
  state?: ConversationState;
  entryEmployeeId?: string | null;
  coordinatorEmployeeId?: string | null;
  solutionRef?: string | null;
  tenantId?: string | null;
  memberId?: string | null;
  schedule?: Record<string, unknown> | null;
  lastReadEntryId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationMetadata {
  id: string;
  title: string | null;
  kind: string;
  labels: string[];
  state: ConversationState;
  entry_employee_id: string | null;
  coordinator_employee_id: string | null;
  solution_instance_id: string | null;
  tenant_id?: string | null;
  member_id?: string | null;
  schedule: Record<string, unknown> | null;
  last_read_entry_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoadedExpertProjection {
  employee_id: string;
  tenant_id: string;
  version: string;
  handle: string;
  display_name: string;
  revoked: boolean;
  synced_at: string;
  model_policy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface LoadedSolutionProjection {
  solution_instance_id: string;
  display_name: string;
  version: string;
  tenant_id?: string;
  [key: string]: unknown;
}

export interface FrozenSnapshot {
  employee_id: string;
  version: string;
  snapshot_version: string;
  display_name: string;
  tenant_id?: string;
  [key: string]: unknown;
}

export interface UsageOutboxItem {
  summary_id: string;
  tenant_id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  claim_token?: string | null;
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
  title: string | null;
  kind: string;
  labels_json: string;
  state: ConversationState;
  entry_employee_id: string | null;
  coordinator_employee_id: string | null;
  solution_ref: string | null;
  tenant_id: string | null;
  member_id: string | null;
  schedule_json: string | null;
  last_read_entry_id: string | null;
  created_at: string;
  updated_at: string;
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
    try { chmodSync(path, 0o600); } catch { /* database may be created by SQLite after open */ }
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        workspace TEXT NOT NULL,
        title TEXT,
        kind TEXT NOT NULL DEFAULT 'chat',
        labels_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('draft', 'active', 'paused', 'muted', 'archived')),
        entry_employee_id TEXT,
        coordinator_employee_id TEXT,
        solution_ref TEXT,
        tenant_id TEXT,
        member_id TEXT,
        schedule_json TEXT,
        last_read_entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_updated_idx ON conversation(updated_at DESC, id);

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

      CREATE TABLE IF NOT EXISTS loaded_employee_projection (
        employee_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loaded_solution_projection (
        solution_instance_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frozen_snapshot (
        employee_id TEXT PRIMARY KEY,
        snapshot_version TEXT NOT NULL,
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_summary_outbox (
        summary_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claim_token TEXT,
        claimed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS usage_outbox_status_idx ON usage_summary_outbox(status, created_at);
    `);
    for (const statement of [
      "ALTER TABLE conversation ADD COLUMN title TEXT",
      "ALTER TABLE conversation ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'",
      "ALTER TABLE conversation ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE conversation ADD COLUMN state TEXT NOT NULL DEFAULT 'active'",
      "ALTER TABLE conversation ADD COLUMN entry_employee_id TEXT",
      "ALTER TABLE conversation ADD COLUMN coordinator_employee_id TEXT",
      "ALTER TABLE conversation ADD COLUMN solution_ref TEXT",
      "ALTER TABLE conversation ADD COLUMN tenant_id TEXT",
      "ALTER TABLE conversation ADD COLUMN member_id TEXT",
      "ALTER TABLE conversation ADD COLUMN schedule_json TEXT",
      "ALTER TABLE conversation ADD COLUMN last_read_entry_id TEXT",
      "ALTER TABLE usage_summary_outbox ADD COLUMN claim_token TEXT",
      "ALTER TABLE usage_summary_outbox ADD COLUMN claimed_at TEXT",
    ]) {
      try { this.db.exec(statement); } catch { /* already migrated */ }
    }
    this.db.prepare("UPDATE usage_summary_outbox SET status = 'failed', last_error = COALESCE(last_error, 'Recovered unfinished usage upload'), claim_token = NULL, claimed_at = NULL WHERE status = 'sending'").run();
  }

  listScheduledConversations(): ConversationRecord[] {
    const rows = this.db.prepare("SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id, coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, last_read_entry_id, created_at, updated_at FROM conversation WHERE schedule_json IS NOT NULL AND tenant_id IS NOT NULL AND member_id IS NOT NULL").all() as unknown as ConversationRow[];
    return rows.map((row) => this.toConversation(row));
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.db
      .prepare("SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id, coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, last_read_entry_id, created_at, updated_at FROM conversation WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? this.toConversation(row) : undefined;
  }

  listConversations(limit = 50, cursor?: string, tenantId?: string, memberId?: string): { items: ConversationMetadata[]; nextCursor: string | null; hasMore: boolean } {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare(`
      SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id,
             coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, last_read_entry_id, created_at, updated_at
      FROM conversation
      WHERE (? IS NULL OR updated_at < (SELECT updated_at FROM conversation WHERE id = ?))
        AND (? IS NULL OR tenant_id = ?) AND (? IS NULL OR member_id = ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(cursor ?? null, cursor ?? null, tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null, safeLimit + 1) as unknown as ConversationRow[];
    const hasMore = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map((row) => this.toMetadata(row));
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null, hasMore };
  }

  saveConversation(record: ConversationRecord): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation (
        id, session_file, workspace, title, kind, labels_json, state, entry_employee_id,
        coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, last_read_entry_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_file = excluded.session_file,
        workspace = excluded.workspace,
        title = excluded.title,
        kind = excluded.kind,
        labels_json = excluded.labels_json,
        state = excluded.state,
        entry_employee_id = excluded.entry_employee_id,
        coordinator_employee_id = excluded.coordinator_employee_id,
        solution_ref = excluded.solution_ref,
        tenant_id = excluded.tenant_id,
        member_id = excluded.member_id,
        schedule_json = excluded.schedule_json,
        last_read_entry_id = excluded.last_read_entry_id,
        updated_at = excluded.updated_at
    `).run(
      record.id, record.sessionFile, record.workspace, record.title ?? null, record.kind ?? "chat",
      JSON.stringify(record.labels ?? []), record.state ?? "active", record.entryEmployeeId ?? null,
      record.coordinatorEmployeeId ?? null, record.solutionRef ?? null,
      record.tenantId ?? null, record.memberId ?? null,
      record.schedule ? JSON.stringify(record.schedule) : null, record.lastReadEntryId ?? null,
      record.createdAt ?? now, record.updatedAt ?? now,
    );
  }

  createConversation(input: Omit<ConversationRecord, "sessionFile" | "workspace"> & { sessionFile?: string; workspace?: string }): ConversationMetadata {
    const now = new Date().toISOString();
    this.saveConversation({
      ...input,
      sessionFile: input.sessionFile ?? "",
      workspace: input.workspace ?? "",
      createdAt: now,
      updatedAt: now,
    });
    return this.getConversationMetadata(input.id)!;
  }

  updateConversation(id: string, patch: Partial<Omit<ConversationRecord, "id" | "sessionFile" | "workspace">>): ConversationMetadata | undefined {
    const current = this.getConversation(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.saveConversation({ ...current, ...patch, id, updatedAt: now });
    return this.getConversationMetadata(id);
  }

  deleteConversation(id: string, tenantId?: string, memberId?: string): boolean {
    const result = this.db.prepare("DELETE FROM conversation WHERE id = ? AND (? IS NULL OR tenant_id = ?) AND (? IS NULL OR member_id = ?)").run(id, tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null);
    this.db.prepare("DELETE FROM pi_event WHERE conversation_id = ?").run(id);
    return result.changes > 0;
  }

  getConversationMetadata(id: string): ConversationMetadata | undefined {
    const record = this.getConversation(id);
    return record ? this.toMetadata(record) : undefined;
  }

  getOwnedConversation(id: string, tenantId: string, memberId: string): ConversationRecord | undefined {
    const record = this.getConversation(id);
    return record && record.tenantId === tenantId && record.memberId === memberId ? record : undefined;
  }

  getOwnedConversationMetadata(id: string, tenantId: string, memberId: string): ConversationMetadata | undefined {
    const record = this.getOwnedConversation(id, tenantId, memberId);
    return record ? this.toMetadata(record) : undefined;
  }

  listLoadedExperts(): LoadedExpertProjection[] {
    return (this.db.prepare("SELECT projection_json FROM loaded_employee_projection WHERE revoked = 0 ORDER BY employee_id").all() as { projection_json: string }[]).map((row) => JSON.parse(row.projection_json) as LoadedExpertProjection);
  }

  listSnapshots(): FrozenSnapshot[] {
    return (this.db.prepare("SELECT projection_json FROM frozen_snapshot ORDER BY employee_id").all() as { projection_json: string }[]).map((row) => JSON.parse(row.projection_json) as FrozenSnapshot);
  }

  listSolutions(): LoadedSolutionProjection[] {
    return (this.db.prepare("SELECT projection_json FROM loaded_solution_projection ORDER BY solution_instance_id").all() as { projection_json: string }[]).map((row) => JSON.parse(row.projection_json) as LoadedSolutionProjection);
  }

  replaceProjections(experts: LoadedExpertProjection[], solutions: LoadedSolutionProjection[], snapshots: FrozenSnapshot[], revokedIds: string[] = []): { upserted: number; revoked: number } {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsertExpert = this.db.prepare("INSERT INTO loaded_employee_projection (employee_id, tenant_id, version, projection_json, revoked, synced_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(employee_id) DO UPDATE SET tenant_id=excluded.tenant_id, version=excluded.version, projection_json=excluded.projection_json, revoked=0, synced_at=excluded.synced_at");
      for (const expert of experts) upsertExpert.run(expert.employee_id, expert.tenant_id, expert.version, JSON.stringify({ ...expert, synced_at: expert.synced_at ?? now, revoked: false }), now);
      const revoke = this.db.prepare("UPDATE loaded_employee_projection SET revoked = 1, synced_at = ? WHERE employee_id = ?");
      for (const id of revokedIds) revoke.run(now, id);
      const upsertSolution = this.db.prepare("INSERT INTO loaded_solution_projection (solution_instance_id, version, projection_json, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(solution_instance_id) DO UPDATE SET version=excluded.version, projection_json=excluded.projection_json, synced_at=excluded.synced_at");
      for (const solution of solutions) upsertSolution.run(solution.solution_instance_id, solution.version, JSON.stringify(solution), now);
      const upsertSnapshot = this.db.prepare("INSERT INTO frozen_snapshot (employee_id, snapshot_version, version, projection_json, synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(employee_id) DO UPDATE SET snapshot_version=excluded.snapshot_version, version=excluded.version, projection_json=excluded.projection_json, synced_at=excluded.synced_at");
      for (const snapshot of snapshots) upsertSnapshot.run(snapshot.employee_id, snapshot.snapshot_version, snapshot.version, JSON.stringify(snapshot), now);
      this.db.exec("COMMIT");
      return { upserted: experts.length + solutions.length + snapshots.length, revoked: revokedIds.length };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listUsageOutbox(tenantId?: string): UsageOutboxItem[] {
    return this.db.prepare("SELECT summary_id, tenant_id, kind, status, attempts, last_error, created_at, claim_token FROM usage_summary_outbox WHERE (? IS NULL OR tenant_id = ?) ORDER BY created_at DESC").all(tenantId ?? null, tenantId ?? null) as unknown as UsageOutboxItem[];
  }

  upsertUsageSummary(summary: UsageSummary): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO usage_summary_outbox (summary_id, tenant_id, kind, status, attempts, last_error, payload_json, created_at)
      VALUES (?, ?, 'usage', 'pending', 0, NULL, ?, ?)
      ON CONFLICT(summary_id) DO UPDATE SET
        payload_json = json_object(
          'schema_version', '1', 'summary_id', excluded.summary_id,
          'tenant_id', excluded.tenant_id, 'member_id', json_extract(usage_summary_outbox.payload_json, '$.member_id'),
          'employee_id', json_extract(usage_summary_outbox.payload_json, '$.employee_id'),
          'window_start', json_extract(usage_summary_outbox.payload_json, '$.window_start'),
          'window_end', json_extract(usage_summary_outbox.payload_json, '$.window_end'),
          'prompt_count', json_extract(usage_summary_outbox.payload_json, '$.prompt_count') + json_extract(excluded.payload_json, '$.prompt_count'),
          'settled_count', json_extract(usage_summary_outbox.payload_json, '$.settled_count') + json_extract(excluded.payload_json, '$.settled_count'),
          'error_count', json_extract(usage_summary_outbox.payload_json, '$.error_count') + json_extract(excluded.payload_json, '$.error_count'),
          'input_tokens', json_extract(usage_summary_outbox.payload_json, '$.input_tokens') + json_extract(excluded.payload_json, '$.input_tokens'),
          'output_tokens', json_extract(usage_summary_outbox.payload_json, '$.output_tokens') + json_extract(excluded.payload_json, '$.output_tokens'),
          'cache_tokens', json_extract(usage_summary_outbox.payload_json, '$.cache_tokens') + json_extract(excluded.payload_json, '$.cache_tokens'),
          'cost_minor', json_extract(usage_summary_outbox.payload_json, '$.cost_minor') + json_extract(excluded.payload_json, '$.cost_minor'),
          'currency', json_extract(usage_summary_outbox.payload_json, '$.currency'),
          'duration_ms_total', json_extract(usage_summary_outbox.payload_json, '$.duration_ms_total') + json_extract(excluded.payload_json, '$.duration_ms_total'),
          'run_count', json_extract(usage_summary_outbox.payload_json, '$.run_count') + json_extract(excluded.payload_json, '$.run_count'),
          'token_total', json_extract(usage_summary_outbox.payload_json, '$.token_total') + json_extract(excluded.payload_json, '$.token_total'),
          'cost_total', json_extract(usage_summary_outbox.payload_json, '$.cost_total') + json_extract(excluded.payload_json, '$.cost_total'),
          'duration_seconds_total', json_extract(usage_summary_outbox.payload_json, '$.duration_seconds_total') + json_extract(excluded.payload_json, '$.duration_seconds_total')
        ), status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'pending' END, last_error = NULL
    `).run(summary.summary_id, summary.tenant_id, JSON.stringify(summary), now);
  }

  claimUsageOutbox(tenantId: string, limit = 50): Array<{ summary_id: string; tenant_id: string; payload: UsageSummary; claim_token: string }> {
    const claimToken = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT summary_id, tenant_id, payload_json FROM usage_summary_outbox
        WHERE tenant_id = ? AND status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT ?`).all(tenantId, Math.min(Math.max(limit, 1), 100)) as { summary_id: string; tenant_id: string; payload_json: string }[];
      for (const row of rows) this.db.prepare("UPDATE usage_summary_outbox SET status = 'sending', attempts = attempts + 1, claim_token = ?, claimed_at = ?, last_error = NULL WHERE summary_id = ? AND status IN ('pending', 'failed')").run(claimToken, new Date().toISOString(), row.summary_id);
      this.db.exec("COMMIT");
      return rows.map((row) => ({ summary_id: row.summary_id, tenant_id: row.tenant_id, payload: JSON.parse(row.payload_json) as UsageSummary, claim_token: claimToken }));
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  markUsageSent(summaryId: string, claimToken: string): void {
    this.db.prepare("UPDATE usage_summary_outbox SET status = 'sent', claim_token = NULL, claimed_at = NULL, last_error = NULL WHERE summary_id = ? AND status = 'sending' AND claim_token = ?").run(summaryId, claimToken);
  }

  markUsageFailed(summaryId: string, claimToken: string, error: string): void {
    this.db.prepare("UPDATE usage_summary_outbox SET status = 'failed', claim_token = NULL, claimed_at = NULL, last_error = ? WHERE summary_id = ? AND status = 'sending' AND claim_token = ?").run(error.slice(0, 500), summaryId, claimToken);
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
    oneShot?: boolean;
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
        if (existing.state === "unknown") {
          this.db.exec("COMMIT");
          throw new IdempotencyUnknownError();
        }
        if (!expired) return this.finishTransaction(existing);

        // An expired accepted receipt is uncertain, never a license to replay Pi.
        this.db.prepare("UPDATE idempotency_receipt SET state = 'unknown', lease_expires_at = NULL WHERE conversation_id = ? AND caller_id = ? AND idempotency_key = ? AND state = 'accepted'").run(input.conversationId, input.callerId, input.key);
        this.db.exec("COMMIT");
        throw new IdempotencyUnknownError();
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
      if (input.oneShot) this.db.prepare("UPDATE conversation SET schedule_json = json_set(COALESCE(schedule_json, '{}'), '$.enabled', json('false')), updated_at = ? WHERE id = ?").run(now.toISOString(), input.conversationId);
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
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already committed before an uncertainty error */ }
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

  private toConversation(row: ConversationRow): ConversationRecord {
    return {
      id: row.id,
      sessionFile: row.session_file,
      workspace: row.workspace,
      title: row.title,
      kind: row.kind,
      labels: this.parseLabels(row.labels_json),
      state: row.state,
      entryEmployeeId: row.entry_employee_id,
      coordinatorEmployeeId: row.coordinator_employee_id,
      solutionRef: row.solution_ref,
      tenantId: row.tenant_id,
      memberId: row.member_id,
      schedule: this.parseJsonObject(row.schedule_json),
      lastReadEntryId: row.last_read_entry_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toMetadata(row: ConversationRow | ConversationRecord): ConversationMetadata {
    const record = "session_file" in row ? this.toConversation(row) : row;
    return {
      id: record.id,
      title: record.title ?? null,
      kind: record.kind ?? "chat",
      labels: record.labels ?? [],
      state: record.state ?? "active",
      entry_employee_id: record.entryEmployeeId ?? null,
      coordinator_employee_id: record.coordinatorEmployeeId ?? null,
      solution_instance_id: record.solutionRef ?? null,
      tenant_id: record.tenantId ?? null,
      member_id: record.memberId ?? null,
      schedule: record.schedule ?? null,
      last_read_entry_id: record.lastReadEntryId ?? null,
      created_at: record.createdAt ?? new Date(0).toISOString(),
      updated_at: record.updatedAt ?? new Date(0).toISOString(),
    };
  }

  private parseLabels(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch { return []; }
  }

  private parseJsonObject(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
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
