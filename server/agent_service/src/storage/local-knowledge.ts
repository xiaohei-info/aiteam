import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface KnowledgeOwner { tenantId: string; memberId: string }
export interface LocalKnowledgeBase { id: string; name: string; description: string; created_at: string; updated_at: string }
export interface LocalKnowledgeDocument { id: string; base_id: string; name: string; size: number; created_at: string; status: "ready" }
export interface LocalKnowledgeHit { document_id: string; base_id: string; title: string; snippet: string; offset: number; citation_id: string }
export class LocalKnowledgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const missing = () => new LocalKnowledgeError(404, "local_knowledge_not_found", "本机知识资源不存在或未授权");

/** Agent-owned user imports only; never an enterprise knowledge cache. */
export class LocalKnowledgeRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_kb (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_kb_owner ON local_kb(tenant_id, member_id);
      CREATE TABLE IF NOT EXISTS local_kb_document (id TEXT PRIMARY KEY, base_id TEXT NOT NULL REFERENCES local_kb(id) ON DELETE CASCADE,
        name TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(base_id, digest));
      CREATE TABLE IF NOT EXISTS local_kb_binding (base_id TEXT NOT NULL REFERENCES local_kb(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL, PRIMARY KEY(base_id, employee_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS local_kb_fts USING fts5(content, content='local_kb_document', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS local_kb_doc_insert AFTER INSERT ON local_kb_document BEGIN
        INSERT INTO local_kb_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TRIGGER IF NOT EXISTS local_kb_doc_delete AFTER DELETE ON local_kb_document BEGIN
        INSERT INTO local_kb_fts(local_kb_fts,rowid,content) VALUES ('delete',old.rowid,old.content); END;
    `);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  base(owner: KnowledgeOwner, id: string): LocalKnowledgeBase {
    // SAFETY: the SELECT matches LocalKnowledgeBase and all selected columns are NOT NULL TEXT.
    const row = this.db.prepare("SELECT id,name,description,created_at,updated_at FROM local_kb WHERE id=? AND tenant_id=? AND member_id=?").get(id, owner.tenantId, owner.memberId) as unknown as LocalKnowledgeBase | undefined;
    if (!row) throw missing();
    return row;
  }
  list(owner: KnowledgeOwner): LocalKnowledgeBase[] {
    // SAFETY: every selected column is NOT NULL TEXT with the LocalKnowledgeBase field names.
    return this.db.prepare("SELECT id,name,description,created_at,updated_at FROM local_kb WHERE tenant_id=? AND member_id=? ORDER BY created_at DESC,id DESC").all(owner.tenantId, owner.memberId) as unknown as LocalKnowledgeBase[];
  }
  create(owner: KnowledgeOwner, name: string, description: string): LocalKnowledgeBase {
    if (this.list(owner).length >= 30) throw new LocalKnowledgeError(409, "local_knowledge_quota", "最多创建 30 个本机知识库");
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO local_kb VALUES (?,?,?,?,?,?,?)").run(id, owner.tenantId, owner.memberId, name, description, now, now);
    return this.base(owner, id);
  }
  documents(owner: KnowledgeOwner, baseId: string): LocalKnowledgeDocument[] {
    this.base(owner, baseId);
    // SAFETY: size is INTEGER, other columns NOT NULL TEXT, and status is the literal ready.
    return this.db.prepare("SELECT id,base_id,name,size,created_at,'ready' AS status FROM local_kb_document WHERE base_id=? ORDER BY created_at DESC,id DESC").all(baseId) as unknown as LocalKnowledgeDocument[];
  }
  bindings(owner: KnowledgeOwner, baseId: string): string[] {
    this.base(owner, baseId);
    return this.db.prepare("SELECT employee_id FROM local_kb_binding WHERE base_id=? ORDER BY employee_id").all(baseId).map(row => String(row.employee_id));
  }
  bind(owner: KnowledgeOwner, baseId: string, employeeId: string, enabled: boolean): void {
    this.base(owner, baseId);
    this.db.prepare(enabled ? "INSERT OR IGNORE INTO local_kb_binding VALUES (?,?)" : "DELETE FROM local_kb_binding WHERE base_id=? AND employee_id=?").run(baseId, employeeId);
  }
  import(owner: KnowledgeOwner, baseId: string, name: string, content: string, size: number): LocalKnowledgeDocument {
    this.base(owner, baseId);
    const digest = createHash("sha256").update(content).digest("hex");
    const previous = this.db.prepare("SELECT id FROM local_kb_document WHERE base_id=? AND digest=?").get(baseId, digest);
    if (previous) return this.documents(owner, baseId).find(row => row.id === previous.id)!;
    const usage = this.db.prepare("SELECT count(*) AS count,coalesce(sum(d.size),0) AS bytes FROM local_kb_document d JOIN local_kb b ON b.id=d.base_id WHERE b.tenant_id=? AND b.member_id=?").get(owner.tenantId, owner.memberId)!;
    if (Number(usage.count) >= 300 || Number(usage.bytes) + size > 50 * 1024 * 1024) throw new LocalKnowledgeError(409, "local_knowledge_quota", "本机知识库最多 300 个文档、总计 50 MiB");
    const id = randomUUID(), now = new Date().toISOString();
    // Content and FTS index become visible atomically; no fake asynchronous ready state.
    this.transaction(() => {
      this.db.prepare("INSERT INTO local_kb_document VALUES (?,?,?,?,?,?,?)").run(id, baseId, name, size, digest, content, now);
      this.db.prepare("UPDATE local_kb SET updated_at=? WHERE id=?").run(now, baseId);
    });
    return { id, base_id: baseId, name, size, created_at: now, status: "ready" };
  }
  remove(owner: KnowledgeOwner, baseId: string, documentId?: string): void {
    this.base(owner, baseId);
    this.transaction(() => {
      if (documentId) {
        const result = this.db.prepare("DELETE FROM local_kb_document WHERE id=? AND base_id=?").run(documentId, baseId);
        if (!result.changes) throw missing();
      } else {
        this.db.prepare("DELETE FROM local_kb_document WHERE base_id=?").run(baseId);
        this.db.prepare("DELETE FROM local_kb_binding WHERE base_id=?").run(baseId);
        this.db.prepare("DELETE FROM local_kb WHERE id=?").run(baseId);
      }
    });
  }
  search(owner: KnowledgeOwner, query: string, employeeId?: string, baseId?: string): LocalKnowledgeHit[] {
    if (baseId) this.base(owner, baseId);
    // Escape the FTS expression to a literal phrase. Short Chinese terms use bounded owner-scoped LIKE.
    const useFts = [...query].length >= 3;
    const match = useFts ? `"${query.replaceAll('"', '""')}"` : `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const statement = useFts
      ? this.db.prepare(`SELECT d.id,d.base_id,d.name,d.content FROM local_kb_document d
          JOIN local_kb b ON b.id=d.base_id JOIN local_kb_fts f ON f.rowid=d.rowid
          WHERE b.tenant_id=? AND b.member_id=? AND (? IS NULL OR b.id=?)
          AND (? IS NULL OR EXISTS(SELECT 1 FROM local_kb_binding k WHERE k.base_id=b.id AND k.employee_id=?))
          AND local_kb_fts MATCH ? ORDER BY rank,d.id LIMIT 20`)
      : this.db.prepare(`SELECT d.id,d.base_id,d.name,d.content FROM local_kb_document d
          JOIN local_kb b ON b.id=d.base_id WHERE b.tenant_id=? AND b.member_id=? AND (? IS NULL OR b.id=?)
          AND (? IS NULL OR EXISTS(SELECT 1 FROM local_kb_binding k WHERE k.base_id=b.id AND k.employee_id=?))
          AND d.content LIKE ? ESCAPE '\\' ORDER BY d.id LIMIT 20`);
    const rows = statement.all(owner.tenantId, owner.memberId, baseId ?? null, baseId ?? null, employeeId ?? null, employeeId ?? null, match);
    return rows.map(row => {
      const content = String(row.content), offset = Math.max(0, content.toLowerCase().indexOf(query.toLowerCase()) - 100);
      return { document_id: String(row.id), base_id: String(row.base_id), title: String(row.name), snippet: content.slice(offset, offset + 800), offset, citation_id: `local:${row.id}` };
    });
  }
  read(owner: KnowledgeOwner, documentId: string, offset: number, employeeId?: string) {
    const row = this.db.prepare(`SELECT d.* FROM local_kb_document d JOIN local_kb b ON b.id=d.base_id
      WHERE d.id=? AND b.tenant_id=? AND b.member_id=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM local_kb_binding k WHERE k.base_id=b.id AND k.employee_id=?))`).get(documentId, owner.tenantId, owner.memberId, employeeId ?? null, employeeId ?? null);
    if (!row) throw missing();
    const text = String(row.content), content = text.slice(offset, offset + 12000);
    return { document_id: documentId, title: String(row.name), citation_id: `local:${documentId}`, content, offset, next_offset: offset + content.length < text.length ? offset + content.length : null };
  }
}
