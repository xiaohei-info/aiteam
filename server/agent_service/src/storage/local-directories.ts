import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface DirectoryOwner { tenantId: string; memberId: string }
export interface DirectoryResource {
  directory_id: string; tenant_id: string; member_id: string; canonical_path: string;
  display_name: string; root_identity: string; revision: number; created_at: string; revoked_at: string | null;
}
export interface DirectoryBinding { employee_id: string; directory_id: string; enabled: boolean; revision: number }
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
    CREATE TABLE IF NOT EXISTS local_directory_binding (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, employee_id TEXT NOT NULL, directory_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, member_id, employee_id, directory_id)
    );`);
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

  bindings(owner: DirectoryOwner, id: string): DirectoryBinding[] {
    this.get(owner, id);
    // SAFETY: selected columns have the types enforced by the binding DDL.
    return (this.db.prepare("SELECT employee_id,directory_id,enabled,revision FROM local_directory_binding WHERE tenant_id=? AND member_id=? AND directory_id=? ORDER BY employee_id")
      .all(owner.tenantId, owner.memberId, id) as unknown as Array<Omit<DirectoryBinding, "enabled"> & { enabled: number }>)
      .map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  bind(owner: DirectoryOwner, id: string, employee: string, enabled: boolean, expectedRevision: number): DirectoryBinding {
    this.get(owner, id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new LocalDirectoryError("invalid_revision");
    const current = this.bindings(owner, id).find((row) => row.employee_id === employee);
    if ((current?.revision ?? 0) !== expectedRevision) throw new LocalDirectoryError("revision_conflict");
    if (current?.enabled === enabled) return current;
    const revision = expectedRevision + 1;
    // Synchronous SQLite operations cannot interleave in this Agent process.
    this.db.prepare(`INSERT INTO local_directory_binding VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,member_id,employee_id,directory_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(owner.tenantId, owner.memberId, employee, id, enabled ? 1 : 0, revision, new Date().toISOString());
    return { employee_id: employee, directory_id: id, enabled, revision };
  }

  revoke(owner: DirectoryOwner, id: string): void {
    this.get(owner, id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE local_directory_resource SET revoked_at=?,revision=revision+1 WHERE directory_id=? AND tenant_id=? AND member_id=?")
        .run(new Date().toISOString(), id, owner.tenantId, owner.memberId);
      this.db.prepare("UPDATE local_directory_binding SET enabled=0,revision=revision+1,updated_at=? WHERE directory_id=? AND tenant_id=? AND member_id=?")
        .run(new Date().toISOString(), id, owner.tenantId, owner.memberId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
