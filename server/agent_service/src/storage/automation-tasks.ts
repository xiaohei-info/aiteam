import type { DatabaseSync } from "node:sqlite";

export interface TaskOwner { tenantId: string; memberId: string }
export interface AutomationTaskRow {
  id: string; tenant_id: string; member_id: string; name: string; category: string;
  conversation_id: string; connector_ids: string; revision: number;
  created_at: string; updated_at: string; deleted_at: string | null;
}
export class AutomationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Configuration and trigger indexes only; execution and bodies remain in SessionHost/Pi. */
export class AutomationTaskRepository {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_task (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
        name TEXT NOT NULL, category TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
        connector_ids TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS automation_task_owner ON automation_task(tenant_id, member_id);
      CREATE TABLE IF NOT EXISTS automation_binding (conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_creation (
        tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        response_json TEXT, PRIMARY KEY (tenant_id, member_id, key)
      );
      CREATE TABLE IF NOT EXISTS schedule_occurrence (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, revision INTEGER NOT NULL,
        caller_id TEXT, receipt_key TEXT, reason TEXT,
        UNIQUE(conversation_id, schedule_id, scheduled_at)
      );
      CREATE INDEX IF NOT EXISTS schedule_occurrence_owner ON schedule_occurrence(tenant_id, member_id, scheduled_at DESC);
    `);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT automation_write");
    try { const result = operation(); this.db.exec("RELEASE automation_write"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO automation_write; RELEASE automation_write"); throw error; }
  }
  get(id: string, owner: TaskOwner): AutomationTaskRow | undefined {
    return this.db.prepare("SELECT * FROM automation_task WHERE id = ? AND tenant_id = ? AND member_id = ?").get(id, owner.tenantId, owner.memberId) as unknown as AutomationTaskRow | undefined;
  }
  forConversation(id: string): AutomationTaskRow | undefined {
    return this.db.prepare("SELECT t.* FROM automation_task t JOIN automation_binding b ON b.task_id = t.id WHERE b.conversation_id = ?").get(id) as unknown as AutomationTaskRow | undefined;
  }
  list(owner: TaskOwner): AutomationTaskRow[] {
    return this.db.prepare("SELECT * FROM automation_task WHERE tenant_id = ? AND member_id = ?").all(owner.tenantId, owner.memberId) as unknown as AutomationTaskRow[];
  }
  insert(row: AutomationTaskRow): void {
    this.db.prepare("INSERT INTO automation_task VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.tenant_id, row.member_id, row.name, row.category, row.conversation_id, row.connector_ids, row.revision, row.created_at, row.updated_at, row.deleted_at);
    this.bind(row.id, row.conversation_id);
  }
  bind(taskId: string, conversationId: string): void {
    this.db.prepare("INSERT INTO automation_binding VALUES (?, ?)").run(conversationId, taskId);
  }
  update(row: AutomationTaskRow): void {
    this.db.prepare("UPDATE automation_task SET name = ?, category = ?, conversation_id = ?, connector_ids = ?, revision = revision + 1, updated_at = ?, deleted_at = ? WHERE id = ? AND tenant_id = ? AND member_id = ?")
      .run(row.name, row.category, row.conversation_id, row.connector_ids, new Date().toISOString(), row.deleted_at, row.id, row.tenant_id, row.member_id);
  }
  guardSchedule(conversationId: string): void {
    const task = this.forConversation(conversationId);
    if (task && this.db.prepare("SELECT 1 FROM automation_creation WHERE task_id = ? AND completed = 0").get(task.id)) throw new AutomationError(409, "task_creation_pending", "Task initialization is not complete");
    if (task && (task.deleted_at || task.conversation_id !== conversationId)) throw new AutomationError(409, "task_binding_retired", "This task binding is no longer active");
  }
  conversationDeleted(conversationId: string): void {
    this.db.prepare("UPDATE automation_task SET deleted_at = COALESCE(deleted_at, ?), revision = revision + 1 WHERE conversation_id = ?").run(new Date().toISOString(), conversationId);
    this.db.prepare("UPDATE schedule_occurrence SET reason = 'conversation_deleted' WHERE conversation_id = ?").run(conversationId);
  }
  occurrence(input: { id: string; conversationId: string; tenantId: string; memberId: string; scheduleId: string; at: string; revision: number; callerId?: string; reason?: string }): void {
    this.db.prepare(`INSERT INTO schedule_occurrence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, schedule_id, scheduled_at) DO UPDATE SET
      caller_id = COALESCE(excluded.caller_id, caller_id), receipt_key = COALESCE(excluded.receipt_key, receipt_key), reason = excluded.reason
      WHERE schedule_occurrence.receipt_key IS NULL OR excluded.receipt_key IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM idempotency_receipt r WHERE r.conversation_id = schedule_occurrence.conversation_id
          AND r.caller_id = schedule_occurrence.caller_id AND r.idempotency_key = schedule_occurrence.receipt_key
      )`)
      .run(input.id, input.conversationId, input.tenantId, input.memberId, input.scheduleId, input.at, input.revision, input.callerId ?? null, input.callerId ? input.id : null, input.reason ?? null);
  }
}
