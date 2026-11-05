import type { DatabaseSync } from "node:sqlite";

/** The failure summary is already bounded and redacted by the caller; this cap only guards the table. */
const MAX_MESSAGE_CHARS = 240;

/**
 * A run that failed before Pi wrote anything to the session (for example Manager runtime-config
 * returned 404). Such a failure is in no transcript, so without this row a restarted app could not
 * say why the last message got no reply.
 */
export interface ConversationFailure {
  /** Empty for a single chat's own session; the participant in a group. */
  employee_id: string | null;
  work_id: string | null;
  error_code: string;
  error_message: string;
  failed_at: string;
}

interface FailureRow {
  employee_id: string;
  work_id: string | null;
  error_code: string;
  error_message: string;
  failed_at: number;
}

/** One row per conversation participant: its latest failed run, removed when it runs again. */
export class ConversationFailureStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_failure (
      conversation_id TEXT NOT NULL, employee_id TEXT NOT NULL DEFAULT '',
      work_id TEXT, error_code TEXT NOT NULL, error_message TEXT NOT NULL, failed_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, employee_id)
    );`);
  }

  record(input: { conversationId: string; employeeId?: string; workId?: string; errorCode: string; errorMessage: string; failedAt: number }): void {
    this.db.prepare(`INSERT INTO conversation_failure VALUES (?,?,?,?,?,?)
      ON CONFLICT(conversation_id, employee_id) DO UPDATE SET
        work_id=excluded.work_id, error_code=excluded.error_code, error_message=excluded.error_message, failed_at=excluded.failed_at`)
      .run(input.conversationId, input.employeeId ?? "", input.workId ?? null, input.errorCode,
        input.errorMessage.slice(0, MAX_MESSAGE_CHARS), input.failedAt);
  }

  /** A new run of the participant supersedes its last failure, whatever that run's outcome. */
  clear(conversationId: string, employeeId?: string): void {
    this.db.prepare("DELETE FROM conversation_failure WHERE conversation_id=? AND employee_id=?").run(conversationId, employeeId ?? "");
  }

  list(conversationId: string): ConversationFailure[] {
    // SAFETY: callers check conversation ownership before reading its failures.
    const rows = this.db.prepare("SELECT employee_id, work_id, error_code, error_message, failed_at FROM conversation_failure WHERE conversation_id=? ORDER BY failed_at, employee_id")
      .all(conversationId) as unknown as FailureRow[];
    return rows.map((row) => ({
      employee_id: row.employee_id || null,
      work_id: row.work_id,
      error_code: row.error_code,
      error_message: row.error_message,
      failed_at: new Date(row.failed_at).toISOString(),
    }));
  }

  deleteConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM conversation_failure WHERE conversation_id=?").run(conversationId);
  }
}
