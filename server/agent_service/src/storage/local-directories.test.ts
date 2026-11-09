import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LocalDirectoryStore } from "./local-directories.js";

type FolderRow = { conversation_id: string; directory_id: string; enabled: number; revision: number };
function folderRows(db: DatabaseSync): FolderRow[] {
  // SAFETY: selected columns come from the local_directory_conversation_folder DDL.
  return (db.prepare("SELECT conversation_id, directory_id, enabled, revision FROM local_directory_conversation_folder ORDER BY conversation_id, directory_id")
    .all() as unknown as FolderRow[]).map((row) => ({ ...row }));
}
const tableExists = (db: DatabaseSync, name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

test("directory metadata isolates tenants and members, versions bindings, and revokes without an active employee", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new LocalDirectoryStore(db);
    const owner = { tenantId: "tenant-a", memberId: "member-a" };
    const source = { canonical_path: "/private/test/docs", display_name: "docs", root_identity: "1:2" };
    const directory = store.register(owner, source);
    assert.equal(store.register(owner, source).directory_id, directory.directory_id);
    assert.throws(() => store.register(owner, { ...source, root_identity: "1:3" }), /source_changed/);
    for (const stranger of [{ ...owner, memberId: "member-b" }, { ...owner, tenantId: "tenant-b" }]) {
      assert.deepEqual(store.list(stranger), []);
      assert.throws(() => store.get(stranger, directory.directory_id), /unauthorized/);
      assert.throws(() => store.bind(stranger, directory.directory_id, "conv-1", true, 0), /unauthorized/);
      assert.throws(() => store.revoke(stranger, directory.directory_id), /unauthorized/);
    }
    const enabled = store.bind(owner, directory.directory_id, "conv-1", true, 0);
    assert.equal(enabled.revision, 1);
    assert.equal(enabled.conversation_id, "conv-1");
    assert.deepEqual(store.bind(owner, directory.directory_id, "conv-1", true, 1), enabled);
    assert.throws(() => store.bind(owner, directory.directory_id, "conv-1", false, 0), /revision_conflict/);
    assert.equal(store.bind(owner, directory.directory_id, "conv-1", false, 1).revision, 2);
    store.revoke(owner, directory.directory_id);
    assert.deepEqual(store.list(owner), []);
    assert.throws(() => store.get(owner, directory.directory_id), /unauthorized/);
    assert.throws(() => store.bind(owner, directory.directory_id, "conv-1", true, 2), /unauthorized/);
    assert.notEqual(store.register(owner, source).directory_id, directory.directory_id);
  } finally { db.close(); }
});

test("a binding belongs to one conversation (all its employees) and is removed with that conversation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new LocalDirectoryStore(db);
    const owner = { tenantId: "tenant-a", memberId: "member-a" };
    const directory = store.register(owner, { canonical_path: "/private/test/docs", display_name: "docs", root_identity: "1:2" });
    store.bind(owner, directory.directory_id, "conv-1", true, 0);
    assert.equal(store.binding(owner, directory.directory_id, "conv-1")?.enabled, true);
    assert.equal(store.binding(owner, directory.directory_id, "conv-2"), undefined, "other conversation: no binding");
    // Each conversation versions its own binding from 0.
    assert.equal(store.bind(owner, directory.directory_id, "conv-2", true, 0).revision, 1);
    store.deleteConversation("conv-1");
    assert.equal(store.binding(owner, directory.directory_id, "conv-1"), undefined);
    assert.equal(store.binding(owner, directory.directory_id, "conv-2")?.enabled, true);
    assert.equal(store.list(owner).length, 1, "deleting a conversation keeps the directory authorization");
  } finally { db.close(); }
});

test("old employee-wide bindings are copied onto that employee's existing conversations, then dropped", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE conversation (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entry_employee_id TEXT, tenant_id TEXT, member_id TEXT);
      CREATE TABLE conversation_participant_session (conversation_id TEXT NOT NULL, employee_id TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (conversation_id, employee_id));
      CREATE TABLE local_directory_binding (
        tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, employee_id TEXT NOT NULL, directory_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, member_id, employee_id, directory_id));
      INSERT INTO conversation VALUES
        ('chat-a1', 'chat', 'emp-a', 't', 'm'),
        ('chat-a2', 'chat', 'emp-a', 't', 'm'),
        ('chat-b', 'chat', 'emp-b', 't', 'm'),
        ('group-1', 'group', 'emp-c', 't', 'm'),
        ('group-2', 'group', 'emp-c', 't', 'm'),
        ('other-member', 'chat', 'emp-a', 't', 'm2');
      INSERT INTO conversation_participant_session VALUES
        ('group-1', 'emp-a', NULL), ('group-1', 'emp-d', NULL), ('group-2', 'emp-a', '2026-11-01T00:00:00Z');
      INSERT INTO local_directory_binding VALUES
        ('t', 'm', 'emp-a', 'dir-1', 1, 3, 'x'),
        ('t', 'm', 'emp-d', 'dir-1', 1, 1, 'x'),
        ('t', 'm', 'emp-b', 'dir-1', 0, 2, 'x');
    `);
    new LocalDirectoryStore(db);
    assert.deepEqual(folderRows(db), [
      { conversation_id: "chat-a1", directory_id: "dir-1", enabled: 1, revision: 1 },
      { conversation_id: "chat-a2", directory_id: "dir-1", enabled: 1, revision: 1 },
      { conversation_id: "group-1", directory_id: "dir-1", enabled: 1, revision: 1 },
    ], "only enabled bindings, only the member's own private chats and active group seats; one row per group");
    assert.equal(tableExists(db, "local_directory_binding"), false);
    // Re-opening is a no-op once the old table is gone.
    new LocalDirectoryStore(db);
    assert.equal(folderRows(db).length, 3);
  } finally { db.close(); }
});

test("per-conversation-and-employee bindings collapse to one row per conversation, on when any employee had it on", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE local_directory_conversation_binding (
        tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, conversation_id TEXT NOT NULL, employee_id TEXT NOT NULL, directory_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, member_id, conversation_id, employee_id, directory_id));
      INSERT INTO local_directory_conversation_binding VALUES
        ('t', 'm', 'group-1', 'emp-a', 'dir-1', 0, 2, 'x'),
        ('t', 'm', 'group-1', 'emp-b', 'dir-1', 1, 1, 'x'),
        ('t', 'm', 'chat-1', 'emp-a', 'dir-1', 0, 3, 'x'),
        ('t', 'm', 'chat-2', 'emp-a', 'dir-2', 1, 1, 'x');
    `);
    const store = new LocalDirectoryStore(db);
    assert.deepEqual(folderRows(db), [
      { conversation_id: "chat-1", directory_id: "dir-1", enabled: 0, revision: 3 },
      { conversation_id: "chat-2", directory_id: "dir-2", enabled: 1, revision: 1 },
      { conversation_id: "group-1", directory_id: "dir-1", enabled: 1, revision: 2 },
    ]);
    assert.equal(tableExists(db, "local_directory_conversation_binding"), false);
    assert.ok(store);
  } finally { db.close(); }
});
