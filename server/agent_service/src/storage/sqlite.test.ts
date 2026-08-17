import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore } from "./sqlite.js";

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
