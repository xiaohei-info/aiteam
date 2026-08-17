import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore } from "./sqlite.js";

test("SQLite receipts reclaim expired accepted and unknown leases", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    const first = store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f", leaseMs: 0 });
    assert.equal(first.isNew, true);
    const reclaimed = store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" });
    assert.equal(reclaimed.isNew, true);
    store.markUnknown("c", "u", "k", reclaimed.ownerInstance, 0);
    const recovered = store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" });
    assert.equal(recovered.isNew, true);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "different" }), /different request/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
