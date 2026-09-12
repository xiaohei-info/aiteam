import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { AgentSqliteStore } from "./storage/sqlite.js";

test("Agent restart converts an accepted receipt from a prior owner process into unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-restart-"));
  const path = join(root, "agent.sqlite");
  let store = new AgentSqliteStore(path);
  store.createConversation({ id: "conversation-1", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
  const accepted = store.reservePrompt({ conversationId: "conversation-1", callerId: "member-1", key: "restart-key", fingerprint: "fingerprint" });
  store.close();
  store = new AgentSqliteStore(path);
  try {
    const receipt = store.getPromptReceipt("conversation-1", "member-1", "restart-key");
    assert.equal(receipt?.state, "unknown");
    assert.equal(receipt?.failureCode, "process_restart");
    assert.throws(() => store.reservePrompt({ conversationId: "conversation-1", callerId: "member-1", key: "restart-key", fingerprint: "fingerprint" }), /unknown execution state/);
    assert.equal(store.getPromptReceipt("conversation-1", "member-1", "restart-key")?.ownerInstance, accepted.ownerInstance);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reading an expired accepted receipt normalizes it without replay", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-expired-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    store.createConversation({ id: "conversation-1", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
    store.reservePrompt({ conversationId: "conversation-1", callerId: "member-1", key: "expired-key", fingerprint: "fingerprint", leaseMs: 0 });
    const receipt = store.getPromptReceipt("conversation-1", "member-1", "expired-key");
    assert.equal(receipt?.state, "unknown");
    assert.equal(receipt?.failureCode, "execution_unknown");
    assert.throws(() => store.reservePrompt({ conversationId: "conversation-1", callerId: "member-1", key: "expired-key", fingerprint: "fingerprint" }), /unknown execution state/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
