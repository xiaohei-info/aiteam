import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSqliteStore } from "./sqlite.js";

test("projection ownership schema migrates legacy local databases additively", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-schema-migration-test-"));
  const path = join(root, "agent.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE loaded_employee_projection (employee_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, version TEXT NOT NULL, projection_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL);
    CREATE TABLE loaded_solution_projection (solution_instance_id TEXT PRIMARY KEY, version TEXT NOT NULL, projection_json TEXT NOT NULL, synced_at TEXT NOT NULL);
    CREATE TABLE frozen_snapshot (employee_id TEXT PRIMARY KEY, snapshot_version TEXT NOT NULL, version TEXT NOT NULL, projection_json TEXT NOT NULL, synced_at TEXT NOT NULL);
    CREATE TABLE usage_summary_outbox (summary_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, claim_token TEXT, claimed_at TEXT);
    CREATE TABLE local_file (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  `);
  legacy.prepare("INSERT INTO loaded_employee_projection VALUES (?, ?, ?, ?, 0, ?)").run("old", "tenant-1", "1", JSON.stringify({ employee_id: "old", tenant_id: "tenant-1" }), new Date().toISOString());
  legacy.prepare("INSERT INTO frozen_snapshot VALUES (?, ?, ?, ?, ?)").run("old", "snap", "1", JSON.stringify({ employee_id: "old", tenant_id: "tenant-1" }), new Date().toISOString());
  legacy.close();
  const store = new AgentSqliteStore(path);
  try {
    assert.equal(store.listLoadedExperts("tenant-1", "member-1").length, 1, "legacy rows remain readable for backward-compatible fixtures");
    assert.equal((store.db.prepare("PRAGMA table_info(loaded_employee_projection)").all() as { name: string }[]).some((column) => column.name === "member_id"), true);
    assert.equal((store.db.prepare("PRAGMA table_info(usage_summary_outbox)").all() as { name: string }[]).some((column) => column.name === "member_id"), true);
    assert.equal((store.db.prepare("PRAGMA table_info(local_file)").all() as { name: string }[]).some((column) => column.name === "referenced_at"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge artifacts survive SQLite reopen alongside a legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-knowledge-reopen-test-"));
  const path = join(root, "agent.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)");
  legacy.close();
  const artifact = {
    tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1", knowledge_space_id: "space-1",
    document_id: "doc-1", artifact_version: "v1", source_hash: "a".repeat(64), citation_id: "citation-1",
    chunk_index: 0, title: "Title", source: { type: "file", name: "doc.txt", mime_type: "text/plain" }, content: "content",
  };
  const store = new AgentSqliteStore(path);
  store.replaceKnowledgeArtifacts([artifact], { tenantId: "tenant-1", memberId: "member-1" });
  store.close();
  const reopened = new AgentSqliteStore(path);
  try {
    assert.deepEqual(reopened.listKnowledgeArtifacts("tenant-1", "member-1")[0], artifact);
    assert.equal((reopened.db.prepare("SELECT COUNT(*) AS count FROM legacy_marker").get() as { count: number }).count, 0);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local files are metadata-owned, atomically stored, and deleted by conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-local-file-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  store.createConversation({ id: "conversation-1", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
  try {
    const record = store.createLocalFile({ conversationId: "conversation-1", tenantId: "tenant-1", memberId: "member-1", kind: "attachment", filename: "photo.png", mimeType: "image/png", data: Buffer.from("png") });
    assert.equal(record.byte_size, 3);
    assert.equal(statSync(join(store.attachmentRoot, `${record.id}.bin`)).mode & 0o777, 0o600);
    assert.deepEqual(store.listOwnedLocalFiles("conversation-1", "tenant-1", "member-1").map((item) => item.id), [record.id]);
    assert.equal(store.listOwnedLocalFiles("conversation-1", "tenant-1", "other-member").length, 0);
    assert.equal(store.readOwnedLocalFile(record.id, "conversation-1", "tenant-1", "member-1")?.data.toString(), "png");
    assert.equal(record.referenced_at, null);
    store.markLocalFilesReferenced([record.id], "conversation-1", "tenant-1", "member-1");
    assert(store.getOwnedLocalFile(record.id, "conversation-1", "tenant-1", "member-1")?.referenced_at);
    assert.throws(() => store.createLocalFile({ conversationId: "conversation-1", tenantId: "tenant-1", memberId: "member-1", kind: "attachment", filename: "../escape", mimeType: "text/plain", data: Buffer.from("x") }), /Invalid local file name/);
    rmSync(join(store.attachmentRoot, `${record.id}.bin`), { force: true });
    store.deleteConversationLocalFiles("conversation-1", "tenant-1", "member-1");
    assert.equal(store.listOwnedLocalFiles("conversation-1", "tenant-1", "member-1").length, 0);
    assert.equal(statSync(join(store.attachmentRoot, `${record.id}.bin`), { throwIfNoEntry: false }), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local attachment quotas and startup cleanup keep managed storage bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-local-quota-test-"));
  const path = join(root, "agent.sqlite");
  const store = new AgentSqliteStore(path);
  store.createConversation({ id: "c", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const indexed = store.createLocalFile({ conversationId: "c", tenantId: "t", memberId: "m", kind: "attachment", filename: "one.txt", mimeType: "text/plain", data: Buffer.from("1") });
  store.createConversation({ id: "stale", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const stale = store.createLocalFile({ conversationId: "stale", tenantId: "t", memberId: "m", kind: "artifact", filename: "stale.txt", mimeType: "text/plain", data: Buffer.from("stale") });
  store.createConversation({ id: "known", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const known = store.createLocalFile({ conversationId: "known", tenantId: "t", memberId: "m", kind: "attachment", filename: "known.txt", mimeType: "text/plain", data: Buffer.from("known") });
  store.markLocalFilesReferenced([known.id], "known", "t", "m");
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  store.db.prepare("UPDATE local_file SET created_at = ? WHERE id IN (?, ?)").run(old, stale.id, known.id);
  try {
    for (let index = 1; index < 31; index += 1) store.createLocalFile({ conversationId: "c", tenantId: "t", memberId: "m", kind: "attachment", filename: `${index}.txt`, mimeType: "text/plain", data: Buffer.from("x") });
    const artifact = store.createLocalFile({ conversationId: "c", tenantId: "t", memberId: "m", kind: "artifact", filename: "artifact.txt", mimeType: "text/plain", data: Buffer.from("x") });
    assert.equal(artifact.kind, "artifact");
    assert.throws(() => store.createLocalFile({ conversationId: "c", tenantId: "t", memberId: "m", kind: "artifact", filename: "too-many.txt", mimeType: "text/plain", data: Buffer.from("x") }), /count limit/);
    store.createConversation({ id: "bytes", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
    const fiveMiB = Buffer.alloc(5 * 1024 * 1024);
    for (let index = 0; index < 10; index += 1) store.createLocalFile({ conversationId: "bytes", tenantId: "t", memberId: "m", kind: "attachment", filename: `bytes-${index}.bin`, mimeType: "application/octet-stream", data: fiveMiB });
    assert.throws(() => store.createLocalFile({ conversationId: "bytes", tenantId: "t", memberId: "m", kind: "artifact", filename: "too-large-artifact.bin", mimeType: "application/octet-stream", data: Buffer.from("x") }), /storage limit/);
    store.close();
    writeFileSync(join(root, "attachments", ".stale.tmp"), "stale");
    writeFileSync(join(root, "attachments", "orphan.bin"), "orphan");
    const restarted = new AgentSqliteStore(path);
    try {
      assert.equal(statSync(join(restarted.attachmentRoot, `${indexed.id}.bin`), { throwIfNoEntry: false })?.isFile(), true);
      assert.equal(statSync(join(restarted.attachmentRoot, `${stale.id}.bin`), { throwIfNoEntry: false }), undefined);
      assert.equal(restarted.getOwnedLocalFile(stale.id, "stale", "t", "m"), undefined);
      assert.equal(statSync(join(restarted.attachmentRoot, `${known.id}.bin`), { throwIfNoEntry: false })?.isFile(), true);
      assert(restarted.getOwnedLocalFile(known.id, "known", "t", "m")?.referenced_at);
      assert.equal(statSync(join(restarted.attachmentRoot, ".stale.tmp"), { throwIfNoEntry: false }), undefined);
      assert.equal(statSync(join(restarted.attachmentRoot, "orphan.bin"), { throwIfNoEntry: false }), undefined);
    } finally { restarted.close(); }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup cleanup protects unreferenced files for accepted and unknown prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-file-cleanup-test-"));
  const path = join(root, "agent.sqlite");
  const store = new AgentSqliteStore(path);
  store.createConversation({ id: "ordinary", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const ordinary = store.createLocalFile({ conversationId: "ordinary", tenantId: "t", memberId: "m", kind: "attachment", filename: "ordinary.txt", mimeType: "text/plain", data: Buffer.from("ordinary") });
  store.createConversation({ id: "accepted", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const accepted = store.createLocalFile({ conversationId: "accepted", tenantId: "t", memberId: "m", kind: "attachment", filename: "accepted.txt", mimeType: "text/plain", data: Buffer.from("accepted") });
  store.reservePrompt({ conversationId: "accepted", callerId: "u", key: "accepted-key", fingerprint: "accepted-fingerprint" });
  store.createConversation({ id: "unknown", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
  const unknown = store.createLocalFile({ conversationId: "unknown", tenantId: "t", memberId: "m", kind: "attachment", filename: "unknown.txt", mimeType: "text/plain", data: Buffer.from("unknown") });
  const receipt = store.reservePrompt({ conversationId: "unknown", callerId: "u", key: "unknown-key", fingerprint: "unknown-fingerprint" });
  store.markUnknown("unknown", "u", "unknown-key", receipt.ownerInstance);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  store.db.prepare("UPDATE local_file SET created_at = ?").run(old);
  try {
    store.close();
    const restarted = new AgentSqliteStore(path);
    try {
      assert.equal(statSync(join(restarted.attachmentRoot, `${ordinary.id}.bin`), { throwIfNoEntry: false }), undefined);
      assert.equal(restarted.getOwnedLocalFile(ordinary.id, "ordinary", "t", "m"), undefined);
      assert.equal(statSync(join(restarted.attachmentRoot, `${accepted.id}.bin`), { throwIfNoEntry: false })?.isFile(), true);
      assert.equal(statSync(join(restarted.attachmentRoot, `${unknown.id}.bin`), { throwIfNoEntry: false })?.isFile(), true);
      assert(restarted.getOwnedLocalFile(accepted.id, "accepted", "t", "m"));
      assert(restarted.getOwnedLocalFile(unknown.id, "unknown", "t", "m"));
    } finally { restarted.close(); }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite receipts never replay expired or unknown Pi prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    const first = store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f", leaseMs: 0 });
    assert.equal(first.isNew, true);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" }), /unknown execution state/);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" }), /unknown execution state/);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "different" }), /different request/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
