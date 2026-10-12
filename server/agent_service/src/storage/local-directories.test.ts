import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LocalDirectoryStore } from "./local-directories.js";

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
      assert.throws(() => store.bind(stranger, directory.directory_id, "employee", true, 0), /unauthorized/);
      assert.throws(() => store.revoke(stranger, directory.directory_id), /unauthorized/);
    }
    const enabled = store.bind(owner, directory.directory_id, "employee", true, 0);
    assert.equal(enabled.revision, 1);
    assert.deepEqual(store.bind(owner, directory.directory_id, "employee", true, 1), enabled);
    assert.throws(() => store.bind(owner, directory.directory_id, "employee", false, 0), /revision_conflict/);
    assert.equal(store.bind(owner, directory.directory_id, "employee", false, 1).revision, 2);
    store.revoke(owner, directory.directory_id);
    assert.deepEqual(store.list(owner), []);
    assert.throws(() => store.get(owner, directory.directory_id), /unauthorized/);
    assert.throws(() => store.bind(owner, directory.directory_id, "employee", true, 2), /unauthorized/);
    assert.notEqual(store.register(owner, source).directory_id, directory.directory_id);
  } finally { db.close(); }
});
