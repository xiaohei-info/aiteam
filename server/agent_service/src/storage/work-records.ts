import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkUsage, UsageSummary } from "../usage.js";

export type WorkOutcome = "active" | "succeeded" | "error" | "aborted" | "unknown";
export interface WorkOwner { tenantId: string; memberId: string }
export interface WorkFilter extends WorkOwner { employeeId?: string; start?: number; end?: number }
export interface WorkRecordRow {
  created_seq: number;
  id: string;
  tenant_id: string;
  member_id: string;
  employee_id: string;
  conversation_id: string;
  provenance: "live" | "pi_history";
  outcome: WorkOutcome;
  reason: "process_restart" | null;
  occurred_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
  start_ordinal: number;
  end_ordinal: number | null;
  first_entry_id: string | null;
  last_entry_id: string | null;
  first_entry_at: number | null;
  last_entry_at: number | null;
  usage_json: string | null;
}
export interface WorkChangeRow {
  seq: number;
  record_id: string;
  tenant_id: string;
  member_id: string;
  employee_id: string;
  deleted: number;
}
export interface WorkStart extends WorkOwner {
  conversationId: string;
  employeeId: string;
  startedAt: number;
  startOrdinal: number;
}
export interface WorkHistorySegment {
  startOrdinal: number;
  endOrdinal: number;
  firstEntryId: string;
  lastEntryId: string;
  firstEntryAt: number | null;
  lastEntryAt: number | null;
  outcome: Exclude<WorkOutcome, "active">;
}
export interface WorkFinish {
  outcome: Exclude<WorkOutcome, "active">;
  endedAt: number;
  endOrdinal: number;
  firstEntryId: string | null;
  lastEntryId: string | null;
  firstEntryAt: number | null;
  lastEntryAt: number | null;
  usage: WorkUsage | null;
}

/** Derived observations only. Pi owns execution; no bodies, runtime commands or replay state. */
export class WorkRecordRepository {
  constructor(private readonly db: DatabaseSync, private readonly accumulateUsage: (summary: UsageSummary, preciseCost?: string) => void) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_record (
        created_seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, employee_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        provenance TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT,
        occurred_at INTEGER, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL,
        start_ordinal INTEGER NOT NULL, end_ordinal INTEGER,
        first_entry_id TEXT, last_entry_id TEXT, first_entry_at INTEGER, last_entry_at INTEGER, usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS work_record_owner ON work_record(tenant_id, member_id, employee_id, occurred_at DESC, created_seq DESC);
      CREATE INDEX IF NOT EXISTS work_record_conversation ON work_record(conversation_id, employee_id);
      CREATE UNIQUE INDEX IF NOT EXISTS work_record_history ON work_record(conversation_id, employee_id, first_entry_id) WHERE provenance = 'pi_history';
      CREATE TABLE IF NOT EXISTS work_record_change (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, employee_id TEXT NOT NULL, deleted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_change_owner ON work_record_change(tenant_id, member_id, seq);
    `);
    this.transaction(() => {
      const active = db.prepare("SELECT * FROM work_record WHERE outcome = 'active'").all() as unknown as WorkRecordRow[];
      for (const row of active) {
        db.prepare("UPDATE work_record SET outcome = 'unknown', reason = 'process_restart', ended_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
        this.change(row, false);
      }
    });
  }

  start(input: WorkStart): string {
    return this.transaction(() => {
      this.requireOwner(input.conversationId, input);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO work_record
        (id, tenant_id, member_id, employee_id, conversation_id, provenance, outcome, occurred_at, started_at, updated_at, start_ordinal)
        VALUES (?, ?, ?, ?, ?, 'live', 'active', ?, ?, ?, ?)`)
        .run(id, input.tenantId, input.memberId, input.employeeId, input.conversationId, input.startedAt, input.startedAt, input.startedAt, input.startOrdinal);
      this.change(this.get(id, input)!, false);
      return id;
    });
  }

  /** The observation transition is the idempotency guard; it commits with hourly usage. */
  finish(id: string, owner: WorkOwner, finish: WorkFinish, summary?: UsageSummary): boolean {
    return this.transaction(() => {
      const row = this.get(id, owner);
      if (!row || row.outcome !== "active") return false;
      if (summary && (summary.tenant_id !== row.tenant_id || summary.member_id !== row.member_id || summary.employee_id !== row.employee_id)) throw new Error("Work usage owner mismatch");
      this.db.prepare(`UPDATE work_record SET outcome = ?, ended_at = ?, updated_at = ?, end_ordinal = ?,
        first_entry_id = ?, last_entry_id = ?, first_entry_at = ?, last_entry_at = ?, usage_json = ? WHERE id = ?`)
        .run(finish.outcome, finish.endedAt, finish.endedAt, finish.endOrdinal, finish.firstEntryId, finish.lastEntryId,
          finish.firstEntryAt, finish.lastEntryAt, finish.usage ? JSON.stringify(finish.usage) : null, id);
      if (summary) this.accumulateUsage(summary, finish.usage?.cost_total ?? undefined);
      this.change(row, false);
      return true;
    });
  }

  /** One metadata read per participant; known history does not acquire a write transaction. */
  importHistory(input: WorkOwner & { conversationId: string; employeeId: string }, segments: readonly WorkHistorySegment[]): void {
    if (!segments.length) return;
    const rows = this.db.prepare(`SELECT provenance, start_ordinal, end_ordinal, first_entry_id FROM work_record
      WHERE conversation_id = ? AND tenant_id = ? AND member_id = ? AND employee_id = ? ORDER BY start_ordinal ASC`)
      .all(input.conversationId, input.tenantId, input.memberId, input.employeeId) as unknown as Array<Pick<WorkRecordRow, "provenance" | "start_ordinal" | "end_ordinal" | "first_entry_id">>;
    const anchors = new Set(rows.filter((row) => row.provenance === "pi_history").map((row) => row.first_entry_id));
    const live = rows.filter((row) => row.provenance === "live");
    const starts = [...new Set(live.map((row) => row.start_ordinal))];
    // A recovered open interval extends to the next distinct live start, not past later work.
    const nextStarts = new Map(starts.map((start, index) => [start, starts[index + 1] ?? Infinity]));
    let liveIndex = 0;
    let coveredUntil = -Infinity;
    const pending = [...segments].sort((left, right) => left.startOrdinal - right.startOrdinal).filter((segment) => {
      while (liveIndex < live.length && live[liveIndex]!.start_ordinal <= segment.startOrdinal) {
        const row = live[liveIndex++]!;
        coveredUntil = Math.max(coveredUntil, row.end_ordinal ?? nextStarts.get(row.start_ordinal)!);
      }
      if (anchors.has(segment.firstEntryId) || segment.startOrdinal < coveredUntil) return false;
      anchors.add(segment.firstEntryId);
      return true;
    });
    if (!pending.length) return;
    this.transaction(() => {
      this.requireOwner(input.conversationId, input);
      const insert = this.db.prepare(`INSERT INTO work_record
        (id, tenant_id, member_id, employee_id, conversation_id, provenance, outcome, occurred_at, updated_at,
         start_ordinal, end_ordinal, first_entry_id, last_entry_id, first_entry_at, last_entry_at)
        VALUES (?, ?, ?, ?, ?, 'pi_history', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const segment of pending) {
        const id = randomUUID();
        insert.run(id, input.tenantId, input.memberId, input.employeeId, input.conversationId, segment.outcome, segment.firstEntryAt, Date.now(),
          segment.startOrdinal, segment.endOrdinal, segment.firstEntryId, segment.lastEntryId, segment.firstEntryAt, segment.lastEntryAt);
        this.change({ id, tenant_id: input.tenantId, member_id: input.memberId, employee_id: input.employeeId }, false);
      }
    });
  }

  get(id: string, owner: WorkOwner): WorkRecordRow | undefined {
    return this.db.prepare("SELECT * FROM work_record WHERE id = ? AND tenant_id = ? AND member_id = ?").get(id, owner.tenantId, owner.memberId) as WorkRecordRow | undefined;
  }

  forConversation(conversationId: string, owner: WorkOwner): WorkRecordRow[] {
    return this.db.prepare("SELECT * FROM work_record WHERE conversation_id = ? AND tenant_id = ? AND member_id = ?").all(conversationId, owner.tenantId, owner.memberId) as unknown as WorkRecordRow[];
  }

  history(filter: WorkFilter, limit: number, boundary?: [number, number]): WorkRecordRow[] {
    return this.db.prepare(`SELECT * FROM work_record WHERE tenant_id = ? AND member_id = ?
      AND (? IS NULL OR employee_id = ?) AND (? IS NULL OR (occurred_at >= ? AND occurred_at < ?))
      AND (? IS NULL OR (COALESCE(occurred_at, -8640000000000000), created_seq) < (?, ?))
      ORDER BY COALESCE(occurred_at, -8640000000000000) DESC, created_seq DESC LIMIT ?`)
      .all(filter.tenantId, filter.memberId, filter.employeeId ?? null, filter.employeeId ?? null,
        filter.start ?? null, filter.start ?? null, filter.end ?? null, boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[1] ?? null, limit) as unknown as WorkRecordRow[];
  }

  changes(filter: WorkFilter, after: number, limit: number): WorkChangeRow[] {
    return this.db.prepare(`SELECT * FROM work_record_change WHERE tenant_id = ? AND member_id = ?
      AND (? IS NULL OR employee_id = ?) AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(filter.tenantId, filter.memberId, filter.employeeId ?? null, filter.employeeId ?? null, after, limit) as unknown as WorkChangeRow[];
  }

  watermark(filter?: WorkFilter): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM work_record_change
      WHERE (? IS NULL OR tenant_id = ?) AND (? IS NULL OR member_id = ?) AND (? IS NULL OR employee_id = ?)`)
      .get(filter?.tenantId ?? null, filter?.tenantId ?? null, filter?.memberId ?? null, filter?.memberId ?? null, filter?.employeeId ?? null, filter?.employeeId ?? null) as { seq: number }).seq;
  }

  /** Caller holds the conversation deletion transaction. Retain only the polling scope and opaque ID. */
  deleteConversation(conversationId: string, owner: WorkOwner): void {
    for (const row of this.forConversation(conversationId, owner)) this.change(row, true);
    this.db.prepare("DELETE FROM work_record WHERE conversation_id = ? AND tenant_id = ? AND member_id = ?").run(conversationId, owner.tenantId, owner.memberId);
  }

  private change(row: Pick<WorkRecordRow, "id" | "tenant_id" | "member_id" | "employee_id">, deleted: boolean): void {
    this.db.prepare(`INSERT INTO work_record_change (record_id, tenant_id, member_id, employee_id, deleted) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET seq = excluded.seq, deleted = excluded.deleted`)
      .run(row.id, row.tenant_id, row.member_id, row.employee_id, deleted ? 1 : 0);
  }

  private requireOwner(conversationId: string, owner: WorkOwner): void {
    if (!this.db.prepare("SELECT 1 FROM conversation WHERE id = ? AND tenant_id = ? AND member_id = ?").get(conversationId, owner.tenantId, owner.memberId)) throw new Error("Work conversation is not owned");
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
