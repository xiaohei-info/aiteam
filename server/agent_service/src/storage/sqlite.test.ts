import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSqliteStore } from "./sqlite.js";

test("conversation cursors preserve timestamp ties, frozen anchors, legacy IDs and owner scope across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-conversation-cursor-test-"));
  const path = join(root, "agent.sqlite");
  let store = new AgentSqliteStore(path);
  try {
    const time = "2026-09-05T08:00:00.000Z";
    for (const id of ["a", "b", "c", "d"]) store.saveConversation({ id, tenantId: "t", memberId: "m", sessionFile: "", workspace: "", updatedAt: time });
    store.saveConversation({ id: "foreign", tenantId: "t", memberId: "other", sessionFile: "", workspace: "", updatedAt: time });
    const first = store.listConversations(2, undefined, "t", "m");
    assert.deepEqual(first.items.map((item) => item.id), ["d", "c"]);
    assert(first.nextCursor?.startsWith("page_v1."));
    assert.deepEqual(store.listConversations(2, "c", "t", "m").items.map((item) => item.id), ["b", "a"]);
    store.updateConversation("c", { title: "anchor moved" });
    assert.deepEqual(store.listConversations(2, first.nextCursor!, "t", "m").items.map((item) => item.id), ["b", "a"]);
    for (const cursor of ["foreign", "invalid", "page_v1.invalid"]) assert.throws(() => store.listConversations(2, cursor, "t", "m"), /Invalid cursor/);
    assert.throws(() => store.listConversations(2, first.nextCursor!, "t", "other"), /Invalid cursor/);
    assert.throws(() => store.listConversations(2, first.nextCursor!, "other", "m"), /Invalid cursor/);
    store.deleteConversation("c", "t", "m");
    store.close();
    store = new AgentSqliteStore(path);
    const next = store.listConversations(2, first.nextCursor!, "t", "m");
    assert.deepEqual(next.items.map((item) => item.id), ["b", "a"]);
    assert.equal(next.nextCursor, null);
    assert.equal(next.hasMore, false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

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

test("participant session index is additive, ordered, and removed with its conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-participant-session-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    store.createConversation({ id: "group", kind: "group", tenantId: "tenant-1", memberId: "member-1", sessionFile: "", workspace: "", coordinatorEmployeeId: "coord" });
    store.upsertConversationParticipant({ conversation_id: "group", employee_id: "worker", role: "member", session_file: "/tmp/worker.jsonl", workspace: "/tmp/worker", pi_session_id: "session-worker", employee_version: "1" });
    store.upsertConversationParticipant({ conversation_id: "group", employee_id: "coord", role: "coordinator", session_file: "/tmp/coord.jsonl", workspace: "/tmp/coord", pi_session_id: "session-coord", employee_version: "2" });
    assert.deepEqual(store.listConversationParticipants("group").map((item) => item.employee_id), ["coord", "worker"]);
    assert.equal(store.getConversationParticipant("group", "worker")?.pi_session_id, "session-worker");
    assert.equal(store.deleteConversation("group", "tenant-1", "member-1"), true);
    assert.deepEqual(store.listConversationParticipants("group"), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation permissions default to read-only and survive updates", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-conversation-permission-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    const created = store.createConversation({ id: "permissioned", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
    assert.equal(created.permission_mode, "read-only");
    const updated = store.updateConversation("permissioned", { permissionMode: "workspace-write" });
    assert.equal(updated?.permission_mode, "workspace-write");
    assert.equal(store.getConversation("permissioned")?.permissionMode, "workspace-write");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Agent startup drops legacy Manager knowledge content while preserving local tables", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-knowledge-cleanup-test-"));
  const path = join(root, "agent.sqlite");
  const legacy = new DatabaseSync(path);
  const legacyKnowledgeTable = ["knowledge", "artifact"].join("_");
  legacy.exec(`
    CREATE TABLE ${legacyKnowledgeTable} (tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, content TEXT NOT NULL);
    INSERT INTO ${legacyKnowledgeTable} VALUES ('tenant-1', 'member-1', 'must be removed');
  `);
  legacy.close();
  const store = new AgentSqliteStore(path);
  try {
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((table) => table.name);
    assert.equal(tables.includes(legacyKnowledgeTable), false);
    for (const table of ["frozen_snapshot", "local_file", "usage_summary_outbox"]) assert.equal(tables.includes(table), true, table);
  } finally {
    store.close();
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

test("projection revocation removes solution/snapshot access and outbox exposes only aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-projection-revoke-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    store.replaceProjections(
      [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "one", display_name: "One", revoked: false, synced_at: new Date().toISOString() }],
      [{ solution_instance_id: "solution-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: "Solution", expert_employee_ids: ["employee-1"] }],
      [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "One" }],
      [],
      { tenantId: "tenant-1", memberId: "member-1" },
    );
    store.replaceProjections([], [], [], ["solution-1", "employee-1"], { tenantId: "tenant-1", memberId: "member-1" });
    assert.equal(store.listSolutions("tenant-1", "member-1").length, 0);
    assert.equal(store.listSnapshots("tenant-1", "member-1").length, 0);
    assert.equal(store.listLoadedExperts("tenant-1", "member-1").length, 0);

    store.upsertUsageSummary({
      schema_version: "1", summary_id: "summary-1", tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1",
      window_start: "2026-01-01T00:00:00.000Z", window_end: "2026-01-01T01:00:00.000Z", prompt_count: 1, settled_count: 1,
      error_count: 0, input_tokens: 2, output_tokens: 3, cache_tokens: 0, cost_minor: 1, currency: "USD", duration_ms_total: 10,
      pricing_version: 1, pricing_status: "known",
      run_count: 1, token_total: 5, cost_total: "0.010000000000", duration_seconds_total: 1,
    });
    const item = store.listUsageOutbox("tenant-1", "member-1")[0];
    assert.equal(item.payload?.summary_id, "summary-1");
    assert.equal("prompt" in (item.payload ?? {}), false);
  } finally {
    store.close();
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

test("authenticated scoped projection sync retires only matching legacy metadata and rolls back atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-legacy-projection-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  const expert = (tenant: string, member?: string, id = "e1") => ({ employee_id: id, tenant_id: tenant, ...(member ? { member_id: member } : {}), version: "1", status: "active", handle: id, display_name: id, revoked: false, synced_at: "2026-09-06T00:00:00Z" });
  const snapshot = (tenant: string, member?: string) => ({ employee_id: "e1", tenant_id: tenant, ...(member ? { member_id: member } : {}), version: "1", snapshot_version: "s1", display_name: "Employee" });
  const owner = { tenantId: "t1", memberId: "m1" };
  try {
    store.replaceProjections([expert("t1"), expert("t1", "m2"), expert("t2"), expert("t1", undefined, "e2")], [], [snapshot("t1"), snapshot("t1", "m2"), snapshot("t2"), snapshot("")]);
    const held = store.listSnapshots("t1", "m1").find((item) => item.tenant_id === "t1")!;
    const heldBefore = structuredClone(held);
    const paused = { ...expert("t1", "m1"), version: "2", status: "paused" };
    // A compatibility write without authenticated owner must not perform cleanup.
    store.replaceProjections([paused], [], []);
    const legacyCount = () => (store.db.prepare("SELECT count(*) AS n FROM loaded_employee_projection WHERE tenant_id = 't1' AND employee_id = 'e1' AND member_id = ''").get() as { n: number }).n;
    assert.equal(legacyCount(), 1);
    store.replaceProjections([], [], [], [], owner);
    assert.equal(legacyCount(), 1, "empty delta is not an implicit revocation");
    const rowsBefore = store.listLoadedExperts(undefined, undefined, true);
    const badSnapshot = { ...snapshot("t1", "m1"), toJSON() { throw new Error("injected projection serialization failure"); } };
    assert.throws(() => store.replaceProjections([paused], [], [badSnapshot], [], owner), /injected/);
    assert.equal(legacyCount(), 1);
    assert.deepEqual(store.listLoadedExperts(undefined, undefined, true), rowsBefore);
    store.replaceProjections([paused], [], [{ ...snapshot("t1", "m1"), version: "2", snapshot_version: "s2" }], [], owner);
    assert.equal(legacyCount(), 0);
    assert.equal(store.listLoadedExperts("t1", "m1").find((row) => row.employee_id === "e1")!.status, "paused");
    assert.equal(store.listLoadedExperts("t1", "m2").find((row) => row.employee_id === "e1")!.status, "active");
    assert.equal(store.listLoadedExperts("t2").length, 1);
    assert.equal(store.listLoadedExperts("t1", "m1").some((row) => row.employee_id === "e2"), true);
    const snapshots = store.listSnapshots();
    assert.equal(snapshots.some((row) => row.tenant_id === "t1" && !row.member_id), false);
    assert.equal(snapshots.some((row) => row.tenant_id === "t1" && row.member_id === "m2"), true);
    assert.equal(snapshots.some((row) => !row.tenant_id), true, "unknown tenant is not guessed or deleted");
    assert.deepEqual(held, heldBefore);
    // Explicit revocation also retires a legacy-only cache, without touching another member.
    store.replaceProjections([expert("t1")], [], [snapshot("t1")]);
    store.replaceProjections([], [], [], ["e1"], owner);
    assert.equal(legacyCount(), 0);
    assert.equal(store.listLoadedExperts("t1", "m1").some((row) => row.employee_id === "e1"), false);
    assert.equal(store.listLoadedExperts("t1", "m2").some((row) => row.employee_id === "e1"), true);
    assert.deepEqual(held, heldBefore);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
