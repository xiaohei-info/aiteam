import type { DatabaseSync } from "node:sqlite";

export type SegmentOutcome = "resolved" | "unresolved";
export const SEGMENT_OUTCOME_REASONS = ["off_topic", "missing_info", "execution_failed", "wrong_result", "too_slow", "other"] as const;
export type SegmentOutcomeReason = typeof SEGMENT_OUTCOME_REASONS[number];
/** Evaluations stay editable this long after the reset that ended the segment. */
export const SEGMENT_EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Fewer evaluated segments than this never yield a published resolution rate. */
export const RESOLUTION_RATE_MIN_SAMPLE = 10;

export interface SegmentOwner { tenantId: string; memberId: string }
export interface SegmentEvaluation {
  outcome: SegmentOutcome | null;
  reasons: SegmentOutcomeReason[];
  note: string | null;
  followUp: boolean;
}
export interface ContextSegment {
  segment_id: string;
  conversation_id: string;
  employee_ids: string[];
  message_count: number;
  outcome: SegmentOutcome | null;
  outcome_reasons: SegmentOutcomeReason[];
  outcome_note: string | null;
  follow_up: boolean;
  revision: number;
  ended_at: string;
  evaluated_at: string | null;
  editable_until: string;
}
interface SegmentRow {
  segment_id: string; conversation_id: string; employee_ids_json: string; message_count: number;
  outcome: SegmentOutcome | null; reasons_json: string; note: string | null; follow_up: number;
  revision: number; created_at: number; evaluated_at: number | null;
}
export interface OutcomeFilter extends SegmentOwner { employeeId?: string; start?: number; end?: number }
/** One employee's UTC hour whose evaluated/resolved counts may have changed. */
export interface SegmentOutcomeBucket { employeeId: string; hourStart: number }
export type SegmentOutcomeListener = (owner: SegmentOwner, buckets: SegmentOutcomeBucket[]) => void;
export class ContextSegmentError extends Error {
  constructor(readonly code: "segment_not_found" | "revision_conflict" | "edit_window_closed") { super(code); }
}

/**
 * One row per context reset: the segment that reset ended and the member's verdict on it.
 * Holds no message bodies; the note is the member's own words about the result.
 */
export class ContextSegmentStore {
  /** The listener runs on the same connection, inside any transaction the caller holds. */
  constructor(private readonly db: DatabaseSync, private readonly onOutcomesChanged?: SegmentOutcomeListener) {
    db.exec(`CREATE TABLE IF NOT EXISTS context_segment (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL,
      employee_ids_json TEXT NOT NULL, message_count INTEGER NOT NULL,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('resolved','unresolved')), reasons_json TEXT NOT NULL DEFAULT '[]',
      note TEXT, follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1)),
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL, evaluated_at INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, member_id, conversation_id, segment_id)
    );
    CREATE INDEX IF NOT EXISTS context_segment_time ON context_segment(tenant_id, member_id, created_at);`);
  }

  /** Idempotent per reset: a replayed request returns the row the first one wrote. */
  record(owner: SegmentOwner, input: { conversationId: string; segmentId: string; employeeIds: string[]; messageCount: number; endedAt: number; evaluation?: SegmentEvaluation }): ContextSegment {
    const evaluation = input.evaluation;
    const inserted = this.db.prepare(`INSERT INTO context_segment VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(tenant_id,member_id,conversation_id,segment_id) DO NOTHING`)
      .run(owner.tenantId, owner.memberId, input.conversationId, input.segmentId, JSON.stringify(input.employeeIds), input.messageCount,
        evaluation?.outcome ?? null, JSON.stringify(evaluation?.reasons ?? []), evaluation?.note ?? null, evaluation?.followUp ? 1 : 0,
        input.endedAt, evaluation?.outcome ? input.endedAt : null, input.endedAt);
    if (Number(inserted.changes) > 0 && evaluation?.outcome) this.notify(owner, [{ employeeIds: input.employeeIds, createdAt: input.endedAt }]);
    return this.get(owner, input.conversationId, input.segmentId)!;
  }

  get(owner: SegmentOwner, conversationId: string, segmentId: string): ContextSegment | undefined {
    // SAFETY: owner-scoped primary-key lookup on this module's table.
    const row = this.db.prepare("SELECT * FROM context_segment WHERE tenant_id=? AND member_id=? AND conversation_id=? AND segment_id=?")
      .get(owner.tenantId, owner.memberId, conversationId, segmentId) as unknown as SegmentRow | undefined;
    return row ? publicSegment(row) : undefined;
  }

  list(owner: SegmentOwner, conversationId: string): ContextSegment[] {
    // SAFETY: owner-scoped query on this module's table.
    return (this.db.prepare("SELECT * FROM context_segment WHERE tenant_id=? AND member_id=? AND conversation_id=? ORDER BY created_at, segment_id")
      .all(owner.tenantId, owner.memberId, conversationId) as unknown as SegmentRow[]).map(publicSegment);
  }

  /** Changes or clears (outcome null) the verdict; revision guards concurrent edits. */
  evaluate(owner: SegmentOwner, conversationId: string, segmentId: string, evaluation: SegmentEvaluation, expectedRevision: number, now = Date.now()): ContextSegment {
    const current = this.get(owner, conversationId, segmentId);
    if (!current) throw new ContextSegmentError("segment_not_found");
    if (current.revision !== expectedRevision) throw new ContextSegmentError("revision_conflict");
    if (now > Date.parse(current.editable_until)) throw new ContextSegmentError("edit_window_closed");
    const cleared = evaluation.outcome === null;
    this.db.prepare(`UPDATE context_segment SET outcome=?, reasons_json=?, note=?, follow_up=?, revision=revision+1, evaluated_at=?, updated_at=?
      WHERE tenant_id=? AND member_id=? AND conversation_id=? AND segment_id=? AND revision=?`)
      .run(evaluation.outcome, JSON.stringify(cleared ? [] : evaluation.reasons), cleared ? null : evaluation.note, !cleared && evaluation.followUp ? 1 : 0,
        cleared ? null : now, now, owner.tenantId, owner.memberId, conversationId, segmentId, expectedRevision);
    // Reasons, notes and follow-up never leave the machine; only an outcome change moves the counts.
    if (current.outcome !== evaluation.outcome) this.notify(owner, [{ employeeIds: current.employee_ids, createdAt: Date.parse(current.ended_at) }]);
    return this.get(owner, conversationId, segmentId)!;
  }

  /** Evaluated segments in the window; a group segment counts once for every employee in it. */
  evaluated(filter: OutcomeFilter): Array<{ employeeIds: string[]; outcome: SegmentOutcome; reasons: SegmentOutcomeReason[] }> {
    const start = filter.start ?? null;
    const end = filter.start === undefined ? null : filter.end ?? null;
    // SAFETY: owner-scoped query on this module's table; a null bound disables the range.
    const rows = this.db.prepare(`SELECT employee_ids_json, outcome, reasons_json FROM context_segment
      WHERE tenant_id=? AND member_id=? AND outcome IS NOT NULL AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)`)
      .all(filter.tenantId, filter.memberId, start, start, end, end) as unknown as Array<{ employee_ids_json: string; outcome: SegmentOutcome; reasons_json: string }>;
    return rows
      .map((row) => ({ employeeIds: parseStrings(row.employee_ids_json), outcome: row.outcome, reasons: parseStrings(row.reasons_json).filter(isOutcomeReason) }))
      .filter((row) => !filter.employeeId || row.employeeIds.includes(filter.employeeId));
  }

  /** Absolute counts for one employee's UTC hour [hourStart, hourStart + 1h), keyed by segment end. */
  hourlyCounts(owner: SegmentOwner, employeeId: string, hourStart: number): { evaluated: number; resolved: number } {
    // SAFETY: owner-scoped query on this module's table.
    const row = this.db.prepare(`SELECT COUNT(*) AS evaluated, COALESCE(SUM(outcome = 'resolved'), 0) AS resolved FROM context_segment
      WHERE tenant_id=? AND member_id=? AND outcome IS NOT NULL AND created_at >= ? AND created_at < ?
        AND EXISTS (SELECT 1 FROM json_each(employee_ids_json) WHERE value = ?)`)
      .get(owner.tenantId, owner.memberId, hourStart, hourStart + HOUR_MS, employeeId) as { evaluated: number; resolved: number };
    return { evaluated: Number(row.evaluated), resolved: Number(row.resolved) };
  }

  deleteConversation(owner: SegmentOwner, conversationId: string): void {
    // SAFETY: owner-scoped query on this module's table.
    const evaluated = this.db.prepare("SELECT employee_ids_json, created_at FROM context_segment WHERE tenant_id=? AND member_id=? AND conversation_id=? AND outcome IS NOT NULL")
      .all(owner.tenantId, owner.memberId, conversationId) as unknown as Array<{ employee_ids_json: string; created_at: number }>;
    this.db.prepare("DELETE FROM context_segment WHERE tenant_id=? AND member_id=? AND conversation_id=?").run(owner.tenantId, owner.memberId, conversationId);
    this.notify(owner, evaluated.map((row) => ({ employeeIds: parseStrings(row.employee_ids_json), createdAt: row.created_at })));
  }

  private notify(owner: SegmentOwner, segments: Array<{ employeeIds: string[]; createdAt: number }>): void {
    if (!this.onOutcomesChanged || segments.length === 0) return;
    const buckets = new Map<string, SegmentOutcomeBucket>();
    for (const segment of segments) {
      const hourStart = segment.createdAt - (segment.createdAt % HOUR_MS);
      for (const employeeId of segment.employeeIds) buckets.set(`${employeeId}\u0000${hourStart}`, { employeeId, hourStart });
    }
    this.onOutcomesChanged(owner, [...buckets.values()]);
  }
}

const HOUR_MS = 60 * 60 * 1000;

export function isOutcomeReason(value: unknown): value is SegmentOutcomeReason {
  return typeof value === "string" && (SEGMENT_OUTCOME_REASONS as readonly string[]).includes(value);
}

function parseStrings(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function publicSegment(row: SegmentRow): ContextSegment {
  return {
    segment_id: row.segment_id,
    conversation_id: row.conversation_id,
    employee_ids: parseStrings(row.employee_ids_json),
    message_count: row.message_count,
    outcome: row.outcome,
    outcome_reasons: parseStrings(row.reasons_json).filter(isOutcomeReason),
    outcome_note: row.note,
    follow_up: row.follow_up === 1,
    revision: row.revision,
    ended_at: new Date(row.created_at).toISOString(),
    evaluated_at: row.evaluated_at === null ? null : new Date(row.evaluated_at).toISOString(),
    editable_until: new Date(row.created_at + SEGMENT_EDIT_WINDOW_MS).toISOString(),
  };
}
