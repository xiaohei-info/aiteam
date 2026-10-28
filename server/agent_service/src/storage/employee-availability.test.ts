import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore } from "./sqlite.js";

test("unavailability survives restart, is member scoped, and successful projection clears it", () => {
  const root = mkdtempSync(join(tmpdir(), "employee-availability-"));
  const filename = join(root, "agent.sqlite");
  let store = new AgentSqliteStore(filename);
  const expert = { employee_id: "e1", tenant_id: "t1", member_id: "m1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() };
  try {
    store.replaceProjections([{ ...expert, availability_reason: "employee_dependency_unavailable", availability_revision: "event-1" }, { ...expert, member_id: "m2" }], [], []);
    store.close();
    store = new AgentSqliteStore(filename);
    assert.equal(store.listLoadedExperts("t1", "m1")[0]!.availability_revision, "event-1");
    assert.match(store.knownProjectionVersions("t1", "m1").e1!, /^unavailable:/);
    assert.equal(store.listLoadedExperts("t1", "m2")[0]!.availability_reason, undefined);
    store.replaceProjections([expert], [], []);
    assert.equal(store.listLoadedExperts("t1", "m1")[0]!.availability_reason, undefined);
    assert.equal(store.knownProjectionVersions("t1", "m1").e1!.startsWith("unavailable:"), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
