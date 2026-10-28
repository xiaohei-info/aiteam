import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixture } from "../test-fixture.js";

for (const state of [{ status: "archived" }, { status: "paused" }, { status: "active", availability_reason: "employee_dependency_unavailable" }]) {
  test(`execution rejects unavailable employee ${JSON.stringify(state)} while preserving history`, async () => {
    const fixture = await createFixture();
    const host = fixture.createHost();
    try {
      fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), ...state }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "s1", display_name: "Helper" }]);
      fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
      await assert.rejects(host.prompt("conversation-1", "must not run", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" }), /unavailable/i);
      assert(fixture.store.getConversation("conversation-1"));
      assert.equal(fixture.store.listSnapshots("tenant-1", "member-1").length, 1);
    } finally { await host.dispose(); await fixture.close(); }
  });
}
