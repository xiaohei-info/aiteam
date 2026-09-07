import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { usdDecimal, usdUnits, type UsageSummary } from "../usage.js";
import { WorkRecordRepository } from "./work-records.js";
import type { SkillSigningKeyMetadata } from "../skills.js";
import { decodeReadCursor, encodeReadCursor, InvalidReadCursorError, readCursorScope } from "./read-cursor.js";
import { dirname, isAbsolute, join, relative } from "node:path";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

function createSha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function publicUsageSummary(value: unknown): UsageSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const fields = [
    "schema_version", "summary_id", "tenant_id", "member_id", "employee_id", "window_start", "window_end",
    "prompt_count", "settled_count", "error_count", "input_tokens", "output_tokens", "cache_tokens", "cost_minor",
    "currency", "duration_ms_total", "pricing_version", "pricing_status", "run_count", "token_total", "cost_total", "duration_seconds_total",
  ] as const;
  if (raw.schema_version !== "1" || raw.currency !== "USD" || fields.some((field) => raw[field] === undefined)) return undefined;
  return Object.fromEntries(fields.map((field) => [field, raw[field]])) as unknown as UsageSummary;
}

export type ReceiptState = "accepted" | "completed" | "unknown";

export type ConversationState = "draft" | "active" | "paused" | "muted" | "archived";
export type ConversationPermissionMode = "read-only" | "workspace-write" | "full-access";

export function normalizePermissionMode(value: unknown): ConversationPermissionMode {
  return value === "workspace-write" || value === "full-access" ? value : "read-only";
}

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
  permissionMode?: ConversationPermissionMode;
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
  permission_mode: ConversationPermissionMode;
  last_read_entry_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ConversationParticipantRole = "coordinator" | "member";

export interface ConversationParticipantSession {
  conversation_id: string;
  employee_id: string;
  role: ConversationParticipantRole;
  session_file: string;
  workspace: string;
  pi_session_id: string | null;
  employee_version: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationEntrySource {
  conversation_id: string;
  employee_id: string;
  pi_entry_id: string;
  logical_message_id: string;
  source_type: "human" | "employee";
  source_id: string;
  source_display_name?: string;
  created_at: string;
}

export interface LoadedExpertProjection {
  employee_id: string;
  tenant_id: string;
  member_id?: string;
  version: string;
  handle: string;
  display_name: string;
  revoked: boolean;
  synced_at: string;
  role_title?: string | null;
  department_ids?: string[];
  model_policy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface LoadedSolutionProjection {
  solution_instance_id: string;
  solution_id?: string;
  display_name: string;
  description?: string;
  icon?: string;
  tags?: string[];
  version: string;
  status?: string;
  coordinator_instructions?: string;
  workflow_skill_ref?: Record<string, unknown> | null;
  output_requirements?: string;
  config_version?: number;
  coordinator_employee_id?: string | null;
  expert_employee_ids?: string[];
  tenant_id?: string;
  member_id?: string;
  [key: string]: unknown;
}

export interface FrozenSnapshot {
  employee_id: string;
  version: string;
  snapshot_version: string;
  display_name: string;
  skill_signing_keys?: SkillSigningKeyMetadata[];
  tenant_id?: string;
  member_id?: string;
  [key: string]: unknown;
}

export interface UsageOutboxItem {
  summary_id: string;
  tenant_id: string;
  member_id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  claim_token?: string | null;
  /** The allowlisted aggregate that will be sent to Manager; never session content. */
  payload?: UsageSummary;
}

export type LocalFileKind = "attachment" | "artifact";

export interface LocalFileRecord {
  id: string;
  conversation_id: string;
  tenant_id: string;
  member_id: string;
  kind: LocalFileKind;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  referenced_at: string | null;
}

interface LocalFileRow extends LocalFileRecord {
  storage_path: string;
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
  permission_mode: ConversationPermissionMode;
  last_read_entry_id: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_LEASE_MS = 30_000;
const LOCAL_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOCAL_FILE_MAX_NAME = 255;
// Conservative local-file quota per tenant/member and conversation, shared by both kinds.
const MAX_LOCAL_FILES_PER_CONVERSATION = 32;
const MAX_LOCAL_FILE_BYTES_PER_CONVERSATION = 50 * 1024 * 1024;
// Unreferenced uploads are retained briefly so a delayed prompt can still use them.
const UNREFERENCED_LOCAL_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class AgentSqliteStore {
  readonly db: DatabaseSync;
  readonly attachmentRoot: string;
  readonly workRecords: WorkRecordRepository;
  private readonly instanceId = randomUUID();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.attachmentRoot = join(dirname(path), "attachments");
    mkdirSync(this.attachmentRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.attachmentRoot, 0o700);
    this.db = new DatabaseSync(path);
    this.db.function("add_usage_cost", (left, right) => {
      const a = usdUnits(left), b = usdUnits(right);
      return a === undefined || b === undefined ? null : usdDecimal(a + b);
    });
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
        permission_mode TEXT NOT NULL DEFAULT 'read-only' CHECK (permission_mode IN ('read-only', 'workspace-write', 'full-access')),
        last_read_entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_updated_idx ON conversation(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS conversation_participant_session (
        conversation_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('coordinator', 'member')),
        session_file TEXT NOT NULL,
        workspace TEXT NOT NULL,
        pi_session_id TEXT,
        employee_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, employee_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_participant_session_idx ON conversation_participant_session(conversation_id, role, employee_id);

      CREATE TABLE IF NOT EXISTS conversation_entry_source (
        conversation_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        pi_entry_id TEXT NOT NULL,
        logical_message_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('human', 'employee')),
        source_id TEXT NOT NULL,
        source_display_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, employee_id, pi_entry_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_entry_source_logical_idx ON conversation_entry_source(conversation_id, logical_message_id);

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

      CREATE TABLE IF NOT EXISTS loaded_employee_projection (
        employee_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, tenant_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS loaded_solution_projection (
        solution_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '',
        member_id TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (solution_instance_id, tenant_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS frozen_snapshot (
        employee_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '',
        member_id TEXT NOT NULL DEFAULT '',
        snapshot_version TEXT NOT NULL,
        version TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, tenant_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS usage_summary_outbox (
        summary_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL DEFAULT '',
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

      CREATE TABLE IF NOT EXISTS local_file (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('attachment', 'artifact')),
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= ${LOCAL_FILE_MAX_BYTES}),
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        referenced_at TEXT
      );
      CREATE INDEX IF NOT EXISTS local_file_conversation_idx ON local_file(conversation_id, created_at, id);

    `);
    // Pi Session JSONL is the sole content fact source; remove any pre-cutover raw event table.
    this.db.exec("DROP TABLE IF EXISTS pi_event");
    // Manager-owned enterprise knowledge must not survive in the Agent database.
    this.db.exec("DROP TABLE IF EXISTS knowledge_artifact");
    this.migrateOwnershipTables();
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
      "ALTER TABLE conversation ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'",
      "ALTER TABLE conversation ADD COLUMN last_read_entry_id TEXT",
      "ALTER TABLE usage_summary_outbox ADD COLUMN member_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE usage_summary_outbox ADD COLUMN claim_token TEXT",
      "ALTER TABLE usage_summary_outbox ADD COLUMN claimed_at TEXT",
      "ALTER TABLE usage_summary_outbox ADD COLUMN cost_total_decimal TEXT",
      "ALTER TABLE local_file ADD COLUMN referenced_at TEXT",
    ]) {
      try { this.db.exec(statement); } catch { /* already migrated */ }
    }
    this.db.prepare("UPDATE usage_summary_outbox SET member_id = COALESCE(NULLIF(member_id, ''), json_extract(payload_json, '$.member_id'), '') WHERE member_id = ''").run();
    this.db.prepare("UPDATE usage_summary_outbox SET status = 'failed', last_error = COALESCE(last_error, 'Recovered unfinished usage upload'), claim_token = NULL, claimed_at = NULL WHERE status = 'sending'").run();
    this.workRecords = new WorkRecordRepository(this.db, (summary, cost) => this.upsertUsageSummary(summary, cost));
    this.cleanupAttachmentRoot();
  }

  private migrateOwnershipTables(): void {
    const tableInfo = (table: string) => this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
    const rebuild = (table: string, createSql: string, columns: string, select: string) => {
      const legacy = `${table}_legacy`;
      this.db.exec(`ALTER TABLE ${table} RENAME TO ${legacy}; ${createSql}; INSERT INTO ${table} (${columns}) SELECT ${select} FROM ${legacy}; DROP TABLE ${legacy};`);
    };
    const employeeInfo = tableInfo("loaded_employee_projection");
    if (!employeeInfo.some((column) => column.name === "member_id") || employeeInfo.filter((column) => column.pk > 0).map((column) => column.name).join(",") !== "employee_id,tenant_id,member_id") {
      const member = employeeInfo.some((column) => column.name === "member_id") ? "COALESCE(member_id, json_extract(projection_json, '$.member_id'), '')" : "COALESCE(json_extract(projection_json, '$.member_id'), '')";
      rebuild("loaded_employee_projection", `CREATE TABLE loaded_employee_projection (
        employee_id TEXT NOT NULL, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL DEFAULT '', version TEXT NOT NULL,
        projection_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, tenant_id, member_id)
      )`, "employee_id, tenant_id, member_id, version, projection_json, revoked, synced_at", `employee_id, tenant_id, ${member}, version, projection_json, revoked, synced_at`);
    }
    const solutionInfo = tableInfo("loaded_solution_projection");
    if (!solutionInfo.some((column) => column.name === "member_id") || solutionInfo.filter((column) => column.pk > 0).map((column) => column.name).join(",") !== "solution_instance_id,tenant_id,member_id") {
      const tenant = solutionInfo.some((column) => column.name === "tenant_id") ? "COALESCE(tenant_id, json_extract(projection_json, '$.tenant_id'), '')" : "COALESCE(json_extract(projection_json, '$.tenant_id'), '')";
      const member = solutionInfo.some((column) => column.name === "member_id") ? "COALESCE(member_id, json_extract(projection_json, '$.member_id'), '')" : "COALESCE(json_extract(projection_json, '$.member_id'), '')";
      rebuild("loaded_solution_projection", `CREATE TABLE loaded_solution_projection (
        solution_instance_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '', member_id TEXT NOT NULL DEFAULT '', version TEXT NOT NULL,
        projection_json TEXT NOT NULL, synced_at TEXT NOT NULL,
        PRIMARY KEY (solution_instance_id, tenant_id, member_id)
      )`, "solution_instance_id, tenant_id, member_id, version, projection_json, synced_at", `solution_instance_id, ${tenant}, ${member}, version, projection_json, synced_at`);
    }
    const snapshotInfo = tableInfo("frozen_snapshot");
    if (!snapshotInfo.some((column) => column.name === "member_id") || snapshotInfo.filter((column) => column.pk > 0).map((column) => column.name).join(",") !== "employee_id,tenant_id,member_id") {
      const tenant = snapshotInfo.some((column) => column.name === "tenant_id") ? "COALESCE(tenant_id, json_extract(projection_json, '$.tenant_id'), '')" : "COALESCE(json_extract(projection_json, '$.tenant_id'), '')";
      const member = snapshotInfo.some((column) => column.name === "member_id") ? "COALESCE(member_id, json_extract(projection_json, '$.member_id'), '')" : "COALESCE(json_extract(projection_json, '$.member_id'), '')";
      rebuild("frozen_snapshot", `CREATE TABLE frozen_snapshot (
        employee_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '', member_id TEXT NOT NULL DEFAULT '', snapshot_version TEXT NOT NULL,
        version TEXT NOT NULL, projection_json TEXT NOT NULL, synced_at TEXT NOT NULL,
        PRIMARY KEY (employee_id, tenant_id, member_id)
      )`, "employee_id, tenant_id, member_id, snapshot_version, version, projection_json, synced_at", `employee_id, ${tenant}, ${member}, snapshot_version, version, projection_json, synced_at`);
    }
  }

  listScheduledConversations(): ConversationRecord[] {
    const rows = this.db.prepare("SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id, coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, permission_mode, last_read_entry_id, created_at, updated_at FROM conversation WHERE schedule_json IS NOT NULL AND tenant_id IS NOT NULL AND member_id IS NOT NULL").all() as unknown as ConversationRow[];
    return rows.map((row) => this.toConversation(row));
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.db
      .prepare("SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id, coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, permission_mode, last_read_entry_id, created_at, updated_at FROM conversation WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? this.toConversation(row) : undefined;
  }

  listConversations(limit = 50, cursor?: string, tenantId?: string, memberId?: string): { items: ConversationMetadata[]; nextCursor: string | null; hasMore: boolean } {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const scope = readCursorScope("conversations:updated-desc", [tenantId ?? null, memberId ?? null]);
    let boundary: [string, string] | undefined;
    if (cursor !== undefined) {
      if (cursor.startsWith("page_v1.")) boundary = decodeReadCursor(cursor, scope, ["string", "string"]) as [string, string];
      else {
        // Legacy bare IDs may only anchor a row in this query's owner scope.
        const anchor = this.getConversation(cursor);
        if (!anchor || (tenantId !== undefined && anchor.tenantId !== tenantId) || (memberId !== undefined && anchor.memberId !== memberId)) throw new InvalidReadCursorError();
        boundary = [anchor.updatedAt!, anchor.id];
      }
      if (!Number.isFinite(Date.parse(boundary[0])) || !boundary[1]) throw new InvalidReadCursorError();
    }
    const rows = this.db.prepare(`
      SELECT id, session_file, workspace, title, kind, labels_json, state, entry_employee_id,
             coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, permission_mode, last_read_entry_id, created_at, updated_at
      FROM conversation
      WHERE (? IS NULL OR (updated_at, id) < (?, ?))
        AND (? IS NULL OR tenant_id = ?) AND (? IS NULL OR member_id = ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[1] ?? null, tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null, safeLimit + 1) as unknown as ConversationRow[];
    const hasMore = rows.length > safeLimit;
    const items = rows.slice(0, safeLimit).map((row) => this.toMetadata(row));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeReadCursor(scope, [last.updated_at, last.id]) : null, hasMore };
  }

  saveConversation(record: ConversationRecord): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation (
        id, session_file, workspace, title, kind, labels_json, state, entry_employee_id,
        coordinator_employee_id, solution_ref, tenant_id, member_id, schedule_json, permission_mode, last_read_entry_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        permission_mode = excluded.permission_mode,
        last_read_entry_id = excluded.last_read_entry_id,
        updated_at = excluded.updated_at
    `).run(
      record.id, record.sessionFile, record.workspace, record.title ?? null, record.kind ?? "chat",
      JSON.stringify(record.labels ?? []), record.state ?? "active", record.entryEmployeeId ?? null,
      record.coordinatorEmployeeId ?? null, record.solutionRef ?? null,
      record.tenantId ?? null, record.memberId ?? null,
      record.schedule ? JSON.stringify(record.schedule) : null, record.permissionMode ?? "read-only", record.lastReadEntryId ?? null,
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
    const existing = this.getConversation(id);
    if (!existing || (tenantId !== undefined && existing.tenantId !== tenantId) || (memberId !== undefined && existing.memberId !== memberId)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing.tenantId && existing.memberId) {
        this.workRecords.deleteConversation(id, { tenantId: existing.tenantId, memberId: existing.memberId });
        this.deleteConversationLocalFiles(id, existing.tenantId, existing.memberId);
      }
      this.db.prepare("DELETE FROM conversation WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_participant_session WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_entry_source WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM idempotency_receipt WHERE conversation_id = ?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listConversationParticipants(conversationId: string): ConversationParticipantSession[] {
    return this.db.prepare(`
      SELECT conversation_id, employee_id, role, session_file, workspace, pi_session_id,
             employee_version, created_at, updated_at
      FROM conversation_participant_session
      WHERE conversation_id = ?
      ORDER BY CASE role WHEN 'coordinator' THEN 0 ELSE 1 END, employee_id
    `).all(conversationId) as unknown as ConversationParticipantSession[];
  }

  getConversationParticipant(conversationId: string, employeeId: string): ConversationParticipantSession | undefined {
    return this.db.prepare(`
      SELECT conversation_id, employee_id, role, session_file, workspace, pi_session_id,
             employee_version, created_at, updated_at
      FROM conversation_participant_session
      WHERE conversation_id = ? AND employee_id = ?
    `).get(conversationId, employeeId) as ConversationParticipantSession | undefined;
  }

  upsertConversationParticipant(input: Omit<ConversationParticipantSession, "created_at" | "updated_at"> & { created_at?: string; updated_at?: string }): ConversationParticipantSession {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation_participant_session (
        conversation_id, employee_id, role, session_file, workspace, pi_session_id,
        employee_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, employee_id) DO UPDATE SET
        role = excluded.role,
        session_file = excluded.session_file,
        workspace = excluded.workspace,
        pi_session_id = excluded.pi_session_id,
        employee_version = excluded.employee_version,
        updated_at = excluded.updated_at
    `).run(
      input.conversation_id, input.employee_id, input.role, input.session_file, input.workspace,
      input.pi_session_id ?? null, input.employee_version,
      input.created_at ?? now, input.updated_at ?? now,
    );
    return this.getConversationParticipant(input.conversation_id, input.employee_id)!;
  }

  deleteConversationParticipants(conversationId: string): void {
    this.db.prepare("DELETE FROM conversation_participant_session WHERE conversation_id = ?").run(conversationId);
  }

  upsertConversationEntrySource(input: Omit<ConversationEntrySource, "created_at"> & { created_at?: string }): ConversationEntrySource {
    const createdAt = input.created_at ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO conversation_entry_source (conversation_id, employee_id, pi_entry_id, logical_message_id, source_type, source_id, source_display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, employee_id, pi_entry_id) DO UPDATE SET
        logical_message_id = excluded.logical_message_id,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        source_display_name = excluded.source_display_name
    `).run(input.conversation_id, input.employee_id, input.pi_entry_id, input.logical_message_id, input.source_type, input.source_id, input.source_display_name ?? null, createdAt);
    return this.getConversationEntrySource(input.conversation_id, input.employee_id, input.pi_entry_id)!;
  }

  getConversationEntrySource(conversationId: string, employeeId: string, piEntryId: string): ConversationEntrySource | undefined {
    return this.db.prepare(`
      SELECT conversation_id, employee_id, pi_entry_id, logical_message_id, source_type, source_id, source_display_name, created_at
      FROM conversation_entry_source WHERE conversation_id = ? AND employee_id = ? AND pi_entry_id = ?
    `).get(conversationId, employeeId, piEntryId) as ConversationEntrySource | undefined;
  }

  createLocalFile(input: {
    conversationId: string;
    tenantId: string;
    memberId: string;
    kind: LocalFileKind;
    filename: string;
    mimeType: string;
    data: Buffer;
  }): LocalFileRecord {
    if (input.data.byteLength > LOCAL_FILE_MAX_BYTES) throw new Error("Local file exceeds maximum size");
    if (!input.filename || input.filename.length > LOCAL_FILE_MAX_NAME || input.filename.includes("/") || input.filename.includes("\\") || /[\u0000-\u001f\u007f]/u.test(input.filename)) throw new Error("Invalid local file name");
    const id = randomUUID();
    const storagePath = join(this.attachmentRoot, `${id}.bin`);
    const temporaryPath = join(this.attachmentRoot, `.${id}.tmp`);
    const fd = openSync(temporaryPath, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < input.data.byteLength) offset += writeSync(fd, input.data, offset, input.data.byteLength - offset);
      fsyncSync(fd);
      closeSync(fd);
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, storagePath);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    const createdAt = new Date().toISOString();
    const row = { id, conversation_id: input.conversationId, tenant_id: input.tenantId, member_id: input.memberId, kind: input.kind, filename: input.filename, mime_type: input.mimeType, byte_size: input.data.byteLength, sha256: createSha256(input.data), storage_path: storagePath, created_at: createdAt, referenced_at: null };
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const quota = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM local_file WHERE conversation_id = ? AND tenant_id = ? AND member_id = ?").get(input.conversationId, input.tenantId, input.memberId) as { count: number; bytes: number };
      if (quota.count >= MAX_LOCAL_FILES_PER_CONVERSATION) throw new Error(`Local file count limit is ${MAX_LOCAL_FILES_PER_CONVERSATION} per conversation`);
      if (quota.bytes + input.data.byteLength > MAX_LOCAL_FILE_BYTES_PER_CONVERSATION) throw new Error(`Local file storage limit is ${MAX_LOCAL_FILE_BYTES_PER_CONVERSATION} bytes per conversation`);
      this.db.prepare("INSERT INTO local_file (id, conversation_id, tenant_id, member_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at, referenced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.conversation_id, row.tenant_id, row.member_id, row.kind, row.filename, row.mime_type, row.byte_size, row.sha256, row.storage_path, row.created_at, row.referenced_at);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      rmSync(storagePath, { force: true });
      throw error;
    }
    return this.publicLocalFile(row);
  }

  listOwnedLocalFiles(conversationId: string, tenantId: string, memberId: string, kind?: LocalFileKind): LocalFileRecord[] {
    const rows = this.db.prepare("SELECT id, conversation_id, tenant_id, member_id, kind, filename, mime_type, byte_size, sha256, created_at, referenced_at FROM local_file WHERE conversation_id = ? AND tenant_id = ? AND member_id = ? AND (? IS NULL OR kind = ?) ORDER BY created_at ASC, id ASC").all(conversationId, tenantId, memberId, kind ?? null, kind ?? null) as unknown as LocalFileRecord[];
    return rows;
  }

  getOwnedLocalFile(id: string, conversationId: string, tenantId: string, memberId: string): LocalFileRow | undefined {
    return this.db.prepare("SELECT id, conversation_id, tenant_id, member_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at, referenced_at FROM local_file WHERE id = ? AND conversation_id = ? AND tenant_id = ? AND member_id = ?").get(id, conversationId, tenantId, memberId) as LocalFileRow | undefined;
  }

  readOwnedLocalFile(id: string, conversationId: string, tenantId: string, memberId: string): { record: LocalFileRecord; data: Buffer } | undefined {
    const row = this.getOwnedLocalFile(id, conversationId, tenantId, memberId);
    if (!row) return undefined;
    const resolved = this.managedFilePath(row.storage_path);
    if (!resolved) return undefined;
    return { record: this.publicLocalFile(row), data: readFileSync(resolved) };
  }

  deleteOwnedLocalFile(id: string, conversationId: string, tenantId: string, memberId: string): boolean {
    const row = this.getOwnedLocalFile(id, conversationId, tenantId, memberId);
    if (!row) return false;
    const resolved = this.managedFilePath(row.storage_path);
    this.db.prepare("DELETE FROM local_file WHERE id = ?").run(id);
    if (resolved) rmSync(resolved, { force: true });
    return true;
  }

  markLocalFilesReferenced(ids: string[], conversationId: string, tenantId: string, memberId: string, kind: LocalFileKind = "attachment"): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const mark = this.db.prepare("UPDATE local_file SET referenced_at = ? WHERE id = ? AND conversation_id = ? AND tenant_id = ? AND member_id = ? AND kind = ?");
    for (const id of ids) mark.run(now, id, conversationId, tenantId, memberId, kind);
  }

  deleteConversationLocalFiles(conversationId: string, tenantId: string, memberId: string): void {
    const rows = this.db.prepare("SELECT storage_path FROM local_file WHERE conversation_id = ? AND tenant_id = ? AND member_id = ?").all(conversationId, tenantId, memberId) as { storage_path: string }[];
    const paths = rows.map((row) => this.managedFilePath(row.storage_path));
    this.db.prepare("DELETE FROM local_file WHERE conversation_id = ? AND tenant_id = ? AND member_id = ?").run(conversationId, tenantId, memberId);
    for (const path of paths) if (path) rmSync(path, { force: true });
  }

  private managedFilePath(storagePath: string): string | undefined {
    const root = realpathSync(this.attachmentRoot);
    let resolved: string;
    try { resolved = realpathSync(storagePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const pathFromRoot = relative(root, resolved);
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) || !statSync(resolved).isFile()) throw new Error("Local file path escaped managed root");
    return resolved;
  }

  private cleanupAttachmentRoot(): void {
    const staleBefore = new Date(Date.now() - UNREFERENCED_LOCAL_FILE_RETENTION_MS).toISOString();
    const staleRows = this.db.prepare(`
      SELECT id, storage_path FROM local_file
      WHERE referenced_at IS NULL AND created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM idempotency_receipt
          WHERE idempotency_receipt.conversation_id = local_file.conversation_id
            AND idempotency_receipt.state IN ('accepted', 'unknown')
        )
    `).all(staleBefore) as { id: string; storage_path: string }[];
    for (const row of staleRows) {
      try {
        const resolved = this.managedFilePath(row.storage_path);
        this.db.prepare("DELETE FROM local_file WHERE id = ? AND referenced_at IS NULL").run(row.id);
        if (resolved) rmSync(resolved, { force: true });
      } catch {
        // Invalid metadata is retained for diagnosis; never follow it during cleanup.
      }
    }
    const indexed = new Set<string>();
    const rows = this.db.prepare("SELECT id, storage_path FROM local_file").all() as { id: string; storage_path: string }[];
    for (const row of rows) {
      try {
        const resolved = this.managedFilePath(row.storage_path);
        if (resolved) indexed.add(resolved);
        else this.db.prepare("DELETE FROM local_file WHERE id = ?").run(row.id);
      } catch {
        // Invalid metadata is retained for diagnosis; never follow it during cleanup.
      }
    }
    for (const entry of readdirSync(this.attachmentRoot, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const candidate = join(this.attachmentRoot, entry.name);
      const temporary = /^\\..+\\.tmp$/u.test(entry.name);
      let resolved: string | undefined;
      try { resolved = this.managedFilePath(candidate); } catch { /* symlink/path escape: remove only the root entry below */ }
      if (!temporary && resolved && indexed.has(resolved)) continue;
      rmSync(candidate, { force: true });
    }
  }

  private publicLocalFile(row: LocalFileRow): LocalFileRecord {
    const { storage_path: _storagePath, ...record } = row;
    return record;
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

  listLoadedExperts(tenantId?: string, memberId?: string, includeRevoked = false): LoadedExpertProjection[] {
    const rows = this.db.prepare(`SELECT projection_json, tenant_id, member_id, revoked
      FROM loaded_employee_projection
      WHERE (${includeRevoked ? "1 = 1" : "revoked = 0"})
        AND (? IS NULL OR tenant_id = ?)
        AND (? IS NULL OR member_id = '' OR member_id = ?)
      ORDER BY employee_id`).all(tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null) as { projection_json: string; tenant_id: string; member_id: string; revoked: number }[];
    return rows.map((row) => {
      const projection = JSON.parse(row.projection_json) as LoadedExpertProjection;
      return { ...projection, tenant_id: row.tenant_id, ...(row.member_id ? { member_id: row.member_id } : {}), revoked: row.revoked === 1 || projection.revoked === true };
    });
  }

  listSnapshots(tenantId?: string, memberId?: string): FrozenSnapshot[] {
    return (this.db.prepare("SELECT projection_json, tenant_id, member_id FROM frozen_snapshot WHERE (? IS NULL OR tenant_id = '' OR tenant_id = ?) AND (? IS NULL OR member_id = '' OR member_id = ?) ORDER BY employee_id").all(tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null) as { projection_json: string; tenant_id: string; member_id: string }[]).map((row) => ({ ...JSON.parse(row.projection_json) as FrozenSnapshot, ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}), ...(row.member_id ? { member_id: row.member_id } : {}) }));
  }

  listSolutions(tenantId?: string, memberId?: string): LoadedSolutionProjection[] {
    return (this.db.prepare("SELECT projection_json, tenant_id, member_id FROM loaded_solution_projection WHERE (? IS NULL OR tenant_id = '' OR tenant_id = ?) AND (? IS NULL OR member_id = '' OR member_id = ?) ORDER BY solution_instance_id").all(tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null) as { projection_json: string; tenant_id: string; member_id: string }[]).map((row) => ({ ...JSON.parse(row.projection_json) as LoadedSolutionProjection, ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}), ...(row.member_id ? { member_id: row.member_id } : {}) }));
  }

  replaceProjections(experts: LoadedExpertProjection[], solutions: LoadedSolutionProjection[], snapshots: FrozenSnapshot[], revokedIds: string[] = [], owner?: { tenantId: string; memberId: string }): { upserted: number; revoked: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.replaceProjectionRows(experts, solutions, snapshots, revokedIds, owner, new Date().toISOString());
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private replaceProjectionRows(experts: LoadedExpertProjection[], solutions: LoadedSolutionProjection[], snapshots: FrozenSnapshot[], revokedIds: string[], owner: { tenantId: string; memberId: string } | undefined, now: string): { upserted: number; revoked: number } {
    // Authenticated scoped sync supersedes only the same enterprise employee's
    // legacy member-less cache. Never let that old active row shadow a paused/revoked delta.
    const removeLegacyExpert = this.db.prepare("DELETE FROM loaded_employee_projection WHERE employee_id = ? AND tenant_id = ? AND member_id = ''");
    const removeLegacySnapshot = this.db.prepare("DELETE FROM frozen_snapshot WHERE employee_id = ? AND tenant_id = ? AND member_id = ''");
    if (owner) {
      const superseded = new Set([
        ...experts.filter((expert) => expert.tenant_id === owner.tenantId && expert.member_id === owner.memberId).map((expert) => expert.employee_id),
        ...revokedIds,
      ]);
      for (const employeeId of superseded) {
        removeLegacyExpert.run(employeeId, owner.tenantId);
        removeLegacySnapshot.run(employeeId, owner.tenantId);
      }
    }
    const upsertExpert = this.db.prepare("INSERT INTO loaded_employee_projection (employee_id, tenant_id, member_id, version, projection_json, revoked, synced_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(employee_id, tenant_id, member_id) DO UPDATE SET version=excluded.version, projection_json=excluded.projection_json, revoked=0, synced_at=excluded.synced_at");
    for (const expert of experts) upsertExpert.run(expert.employee_id, expert.tenant_id, expert.member_id ?? "", expert.version, JSON.stringify({ ...expert, tenant_id: expert.tenant_id, ...(expert.member_id ? { member_id: expert.member_id } : {}), synced_at: expert.synced_at ?? now, revoked: false }), now);
    const revoke = owner
      ? this.db.prepare("UPDATE loaded_employee_projection SET revoked = 1, synced_at = ? WHERE employee_id = ? AND tenant_id = ? AND (member_id = ? OR member_id = '')")
      : this.db.prepare("UPDATE loaded_employee_projection SET revoked = 1, synced_at = ? WHERE employee_id = ?");
    const removeSnapshots = owner
      ? this.db.prepare("DELETE FROM frozen_snapshot WHERE employee_id = ? AND tenant_id = ? AND (member_id = ? OR member_id = '')")
      : this.db.prepare("DELETE FROM frozen_snapshot WHERE employee_id = ?");
    const removeSolutions = owner
      ? this.db.prepare("DELETE FROM loaded_solution_projection WHERE solution_instance_id = ? AND tenant_id = ? AND (member_id = ? OR member_id = '')")
      : this.db.prepare("DELETE FROM loaded_solution_projection WHERE solution_instance_id = ?");
    const upsertSolution = this.db.prepare("INSERT INTO loaded_solution_projection (solution_instance_id, tenant_id, member_id, version, projection_json, synced_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(solution_instance_id, tenant_id, member_id) DO UPDATE SET version=excluded.version, projection_json=excluded.projection_json, synced_at=excluded.synced_at");
    for (const solution of solutions) upsertSolution.run(solution.solution_instance_id, solution.tenant_id ?? "", solution.member_id ?? "", solution.version, JSON.stringify({ ...solution, ...(solution.tenant_id ? { tenant_id: solution.tenant_id } : {}), ...(solution.member_id ? { member_id: solution.member_id } : {}) }), now);
    const upsertSnapshot = this.db.prepare("INSERT INTO frozen_snapshot (employee_id, tenant_id, member_id, snapshot_version, version, projection_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(employee_id, tenant_id, member_id) DO UPDATE SET snapshot_version=excluded.snapshot_version, version=excluded.version, projection_json=excluded.projection_json, synced_at=excluded.synced_at");
    for (const snapshot of snapshots) upsertSnapshot.run(snapshot.employee_id, snapshot.tenant_id ?? "", snapshot.member_id ?? "", snapshot.snapshot_version, snapshot.version, JSON.stringify({ ...snapshot, ...(snapshot.tenant_id ? { tenant_id: snapshot.tenant_id } : {}), ...(snapshot.member_id ? { member_id: snapshot.member_id } : {}) }), now);
    // Revocation wins over an accidentally repeated stale snapshot/solution in the same pull.
    for (const id of revokedIds) {
      if (owner) {
        revoke.run(now, id, owner.tenantId, owner.memberId);
        removeSnapshots.run(id, owner.tenantId, owner.memberId);
        removeSolutions.run(id, owner.tenantId, owner.memberId);
      } else {
        revoke.run(now, id);
        removeSnapshots.run(id);
        removeSolutions.run(id);
      }
    }
    return { upserted: experts.length + solutions.length + snapshots.length, revoked: revokedIds.length };
  }

  listUsageOutbox(tenantId?: string, memberId?: string): UsageOutboxItem[] {
    const rows = this.db.prepare("SELECT summary_id, tenant_id, member_id, kind, status, attempts, last_error, created_at, claim_token, payload_json FROM usage_summary_outbox WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR member_id = '' OR member_id = ?) ORDER BY created_at DESC").all(tenantId ?? null, tenantId ?? null, memberId ?? null, memberId ?? null) as Array<Omit<UsageOutboxItem, "payload"> & { payload_json: string }>;
    return rows.map((row) => {
      let payload: UsageSummary | undefined;
      try { payload = publicUsageSummary(JSON.parse(row.payload_json)); } catch { /* malformed local data remains visible via status/error */ }
      const { payload_json: _payloadJson, ...item } = row;
      return { ...item, ...(payload ? { payload } : {}) };
    });
  }

  upsertUsageSummary(summary: UsageSummary, preciseCost?: string): void {
    const now = new Date().toISOString();
    // One hourly row/ledger. The numeric wire alias remains compatible; local accumulation is decimal.
    const cost = usdUnits(preciseCost ?? summary.cost_total);
    const cumulativeCost = "add_usage_cost(COALESCE(usage_summary_outbox.cost_total_decimal, json_extract(usage_summary_outbox.payload_json, '$.cost_total')), excluded.cost_total_decimal)";
    this.db.prepare(`
      INSERT INTO usage_summary_outbox (summary_id, tenant_id, member_id, kind, status, attempts, last_error, payload_json, created_at, cost_total_decimal)
      VALUES (?, ?, ?, 'usage', 'pending', 0, NULL, ?, ?, ?)
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
          'cost_minor', CAST(ROUND(CAST(${cumulativeCost} AS REAL) * 100) AS INTEGER),
          'currency', json_extract(usage_summary_outbox.payload_json, '$.currency'),
          'duration_ms_total', json_extract(usage_summary_outbox.payload_json, '$.duration_ms_total') + json_extract(excluded.payload_json, '$.duration_ms_total'),
          'pricing_version', json_extract(usage_summary_outbox.payload_json, '$.pricing_version'),
          'pricing_status', json_extract(usage_summary_outbox.payload_json, '$.pricing_status'),
          'run_count', json_extract(usage_summary_outbox.payload_json, '$.run_count') + json_extract(excluded.payload_json, '$.run_count'),
          'token_total', json_extract(usage_summary_outbox.payload_json, '$.token_total') + json_extract(excluded.payload_json, '$.token_total'),
          'cost_total', CAST(${cumulativeCost} AS REAL),
          'duration_seconds_total', json_extract(usage_summary_outbox.payload_json, '$.duration_seconds_total') + json_extract(excluded.payload_json, '$.duration_seconds_total')
        ), cost_total_decimal = ${cumulativeCost}, status = 'pending', last_error = NULL
    `).run(summary.summary_id, summary.tenant_id, summary.member_id, JSON.stringify(summary), now, cost === undefined ? null : usdDecimal(cost));
  }

  claimUsageOutbox(tenantId: string, memberIdOrLimit?: string | number, limit = 50): Array<{ summary_id: string; tenant_id: string; payload: UsageSummary; claim_token: string }> {
    const memberId = typeof memberIdOrLimit === "string" ? memberIdOrLimit : undefined;
    const effectiveLimit = typeof memberIdOrLimit === "number" ? memberIdOrLimit : limit;
    const claimToken = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT summary_id, tenant_id, payload_json FROM usage_summary_outbox
        WHERE tenant_id = ? AND (? IS NULL OR member_id = '' OR member_id = ?) AND status IN ('pending', 'failed') ORDER BY created_at ASC LIMIT ?`).all(tenantId, memberId ?? null, memberId ?? null, Math.min(Math.max(effectiveLimit, 1), 100)) as { summary_id: string; tenant_id: string; payload_json: string }[];
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
      permissionMode: normalizePermissionMode(row.permission_mode),
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
      permission_mode: normalizePermissionMode(record.permissionMode),
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
