import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface DirectoryOwner { tenantId: string; memberId: string }
export interface DirectoryResource {
  directory_id: string; tenant_id: string; member_id: string; canonical_path: string;
  display_name: string; root_identity: string; revision: number; created_at: string; revoked_at: string | null;
}
/**
 * A directory is authorized once per member; each conversation chooses whether it uses it. The
 * choice belongs to the conversation, not an employee: a private chat has one employee, and every
 * member of a group shares the group's folders (members who join later too).
 */
export interface DirectoryBinding { conversation_id: string; directory_id: string; enabled: boolean; revision: number }
export class LocalDirectoryError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Agent-owned metadata only. Source text and citation handles never enter SQLite. */
export class LocalDirectoryStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_directory_resource (
      directory_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
      canonical_path TEXT NOT NULL, display_name TEXT NOT NULL, root_identity TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS local_directory_owner ON local_directory_resource(tenant_id, member_id);
    CREATE TABLE IF NOT EXISTS local_directory_conversation_folder (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, conversation_id TEXT NOT NULL, directory_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, member_id, conversation_id, directory_id)
    );
    CREATE INDEX IF NOT EXISTS local_directory_conversation_folder_conversation ON local_directory_conversation_folder(conversation_id);`);
    this.migrateBindings();
  }

  /**
   * Older Agents stored the choice per employee: first for all of an employee's conversations
   * (`local_directory_binding`), then per conversation and employee
   * (`local_directory_conversation_binding`). Both become per-conversation rows, then the old
   * tables are dropped, in one transaction:
   * - an employee-wide binding is copied to every conversation the employee is in today (private
   *   chats by entry employee, groups by active participant);
   * - a conversation keeps a folder when any of its employees had it on.
   */
  private migrateBindings(): void {
    const exists = (name: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const employeeWide = exists("local_directory_binding");
    const perEmployee = exists("local_directory_conversation_binding");
    if (!employeeWide && !perEmployee) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (perEmployee) {
        this.db.prepare(`INSERT OR IGNORE INTO local_directory_conversation_folder
          SELECT tenant_id, member_id, conversation_id, directory_id, MAX(enabled), MAX(revision), ?
          FROM local_directory_conversation_binding GROUP BY tenant_id, member_id, conversation_id, directory_id`).run(now);
        this.db.exec("DROP TABLE local_directory_conversation_binding");
      }
      if (employeeWide) {
        if (exists("conversation")) {
          this.db.prepare(`INSERT OR IGNORE INTO local_directory_conversation_folder
            SELECT DISTINCT b.tenant_id, b.member_id, c.id, b.directory_id, 1, 1, ?
            FROM local_directory_binding b
            JOIN conversation c ON c.tenant_id = b.tenant_id AND c.member_id = b.member_id
            WHERE b.enabled = 1 AND (
              (c.kind <> 'group' AND c.entry_employee_id = b.employee_id)
              OR (c.kind = 'group' AND EXISTS (SELECT 1 FROM conversation_participant_session p
                WHERE p.conversation_id = c.id AND p.employee_id = b.employee_id AND p.removed_at IS NULL)))`).run(now);
        }
        this.db.exec("DROP TABLE local_directory_binding");
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  list(owner: DirectoryOwner): DirectoryResource[] {
    // SAFETY: table DDL and this module's inserts define every selected column.
    return this.db.prepare("SELECT * FROM local_directory_resource WHERE tenant_id=? AND member_id=? AND revoked_at IS NULL ORDER BY created_at,directory_id")
      .all(owner.tenantId, owner.memberId) as unknown as DirectoryResource[];
  }

  get(owner: DirectoryOwner, id: string): DirectoryResource {
    // SAFETY: the owner-scoped query returns our table row or undefined.
    const row = this.db.prepare("SELECT * FROM local_directory_resource WHERE directory_id=? AND tenant_id=? AND member_id=? AND revoked_at IS NULL")
      .get(id, owner.tenantId, owner.memberId) as unknown as DirectoryResource | undefined;
    if (!row) throw new LocalDirectoryError("unauthorized");
    return row;
  }

  /** Call only after consuming a trusted host registration receipt. */
  register(owner: DirectoryOwner, host: { canonical_path: string; display_name: string; root_identity: string }): DirectoryResource {
    const existing = this.list(owner).find((row) => row.canonical_path === host.canonical_path);
    if (existing) {
      if (existing.root_identity !== host.root_identity) throw new LocalDirectoryError("source_changed");
      return existing;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO local_directory_resource VALUES (?,?,?,?,?,?,1,?,NULL)")
      .run(id, owner.tenantId, owner.memberId, host.canonical_path, host.display_name, host.root_identity, new Date().toISOString());
    return this.get(owner, id);
  }

  /** The conversation's choice for one directory; a removed folder keeps its row (enabled=false) and revision. */
  binding(owner: DirectoryOwner, id: string, conversationId: string): DirectoryBinding | undefined {
    this.get(owner, id);
    // SAFETY: selected columns have the types enforced by the binding DDL.
    const row = this.db.prepare("SELECT conversation_id,directory_id,enabled,revision FROM local_directory_conversation_folder WHERE tenant_id=? AND member_id=? AND directory_id=? AND conversation_id=?")
      .get(owner.tenantId, owner.memberId, id, conversationId) as unknown as (Omit<DirectoryBinding, "enabled"> & { enabled: number }) | undefined;
    return row ? { ...row, enabled: row.enabled === 1 } : undefined;
  }

  bind(owner: DirectoryOwner, id: string, conversationId: string, enabled: boolean, expectedRevision: number): DirectoryBinding {
    this.get(owner, id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new LocalDirectoryError("invalid_revision");
    const current = this.binding(owner, id, conversationId);
    if ((current?.revision ?? 0) !== expectedRevision) throw new LocalDirectoryError("revision_conflict");
    if (current?.enabled === enabled) return current;
    const revision = expectedRevision + 1;
    // Synchronous SQLite operations cannot interleave in this Agent process.
    this.db.prepare(`INSERT INTO local_directory_conversation_folder VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,member_id,conversation_id,directory_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(owner.tenantId, owner.memberId, conversationId, id, enabled ? 1 : 0, revision, new Date().toISOString());
    return { conversation_id: conversationId, directory_id: id, enabled, revision };
  }

  /** Called inside the conversation delete transaction; the directory authorization itself stays. */
  deleteConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM local_directory_conversation_folder WHERE conversation_id=?").run(conversationId);
  }

  revoke(owner: DirectoryOwner, id: string): void {
    this.get(owner, id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE local_directory_resource SET revoked_at=?,revision=revision+1 WHERE directory_id=? AND tenant_id=? AND member_id=?")
        .run(new Date().toISOString(), id, owner.tenantId, owner.memberId);
      this.db.prepare("UPDATE local_directory_conversation_folder SET enabled=0,revision=revision+1,updated_at=? WHERE directory_id=? AND tenant_id=? AND member_id=?")
        .run(new Date().toISOString(), id, owner.tenantId, owner.memberId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
