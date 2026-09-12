import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] };

async function waitForEntries(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: "Bearer test" } });
    const body = await response.json() as { data: { entries: unknown[] } };
    if (body.data.entries.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("entries did not settle");
}

async function readReconciliation(response: Response): Promise<{ payload: Record<string, unknown>; text: string }> {
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let attempt = 0; attempt < 100 && !text.includes("event: reconciliation"); attempt += 1) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1000)),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  const dataLine = text.split("\n").find((line) => line.startsWith("data: {\"schema_version\":\"1\""));
  assert(dataLine, text);
  return { payload: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>, text };
}

test("SSE reconnect emits bounded durable entries, receipt, and runtime state reconciliation after a missed terminal event", async () => {
  const fixture = await createFixture();
  fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => caller });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    fixture.faux.setResponses([fauxAssistantMessage("terminal reply")]);
    const submitted = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "reconcile-terminal" },
      body: JSON.stringify({ text: "missed terminal" }),
    });
    assert.equal(submitted.status, 202);
    await waitForEntries(`${base}/api/agent/conversations/c1/entries`);

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/agent/conversations/c1/events`, { headers: { Authorization: "Bearer test" }, signal: controller.signal });
    const { payload, text } = await readReconciliation(stream);
    assert.match(text, /: connected/);
    assert.equal(payload.type, "reconciliation");
    assert.equal(payload.prompting, false);
    assert(Array.isArray(payload.entries) && payload.entries.length > 0);
    const receipts = payload.receipts as Array<Record<string, unknown>>;
    assert.deepEqual(receipts, [{ idempotency_key: "reconcile-terminal", state: "completed", last_entry_id: receipts[0]?.last_entry_id ?? null, failure_code: null, failure_detail: null }]);
    controller.abort();
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("SSE waits for receipt settlement before pairing durable entries with a receipt", async () => {
  const fixture = await createFixture();
  fixture.store.replaceProjections([{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } }], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "employee-1" });
  fixture.faux.setResponses([fauxAssistantMessage("durable prior reply")]);
  await fixture.host.prompt("c1", "prior", undefined, caller);
  const receipt = fixture.store.reservePrompt({ conversationId: "c1", callerId: caller.callerId, key: "delayed-settlement", fingerprint: "delayed" });
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => caller });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const controller = new AbortController();
  try {
    setTimeout(() => fixture.store.markCompleted("c1", caller.callerId, "delayed-settlement", "prior-entry", receipt.ownerInstance), 40);
    const stream = await fetch(`http://127.0.0.1:${address.port}/api/agent/conversations/c1/events`, { headers: { Authorization: "Bearer test" }, signal: controller.signal });
    const { payload } = await readReconciliation(stream);
    const receipts = payload.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts[0]?.state, "completed");
    assert(Array.isArray(payload.entries) && payload.entries.length > 0);
    assert.equal(payload.receipt_settlement_pending, undefined);
  } finally {
    controller.abort();
    await http.close();
    await fixture.close();
  }
});

test("SSE forces a second durable reconciliation read when the bounded pre-fence buffer overflows", async () => {
  const fixture = await createFixture();
  let entriesReads = 0;
  const host = {
    subscribe: async (_conversationId: string, listener: (envelope: unknown) => void) => {
      for (let index = 0; index < 600; index += 1) listener({ id: `event-${index}`, event: { type: "message_update", message: { role: "assistant", content: [] } } });
      return () => undefined;
    },
    entries: async () => { entriesReads += 1; return []; },
    isPrompting: () => false,
    abortAll: async () => undefined,
  };
  const http = new AgentHttpServer({ host: host as never, store: fixture.store, authenticate: () => caller });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const stream = await fetch(`http://127.0.0.1:${address.port}/api/agent/conversations/c1/events`, { headers: { Authorization: "Bearer test" }, signal: controller.signal });
    const { payload } = await readReconciliation(stream);
    assert.equal(entriesReads, 2);
    assert.equal(payload.overflowed, true);
  } finally {
    controller.abort();
    await http.close();
    await fixture.close();
  }
});

test("SSE never drops terminal-only overflow and emits a deterministic terminal recovery signal", async () => {
  const fixture = await createFixture();
  const terminalTypes = ["agent_end", "agent_settled", "approval_required"] as const;
  const host = {
    subscribe: async (_conversationId: string, listener: (envelope: unknown) => void) => {
      for (let index = 0; index < 600; index += 1) {
        const type = terminalTypes[index % terminalTypes.length];
        listener({
          id: `terminal-${index}`,
          event: type === "approval_required"
            ? { type, approvalId: `approval-${index}` }
            : { type },
        });
      }
      return () => undefined;
    },
    entries: async () => [],
    isPrompting: () => false,
    abortAll: async () => undefined,
  };
  const http = new AgentHttpServer({ host: host as never, store: fixture.store, authenticate: () => caller });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const stream = await fetch(`http://127.0.0.1:${address.port}/api/agent/conversations/c1/events`, { headers: { Authorization: "Bearer test" }, signal: controller.signal });
    const { payload, text } = await readReconciliation(stream);
    // The last terminal arrives after the terminal queue is full. It must still
    // be streamed (rather than being discarded because no transient event can
    // be evicted), and the payload tells the Web consumer to reconcile.
    assert.match(text, /id: terminal-599\nevent: pi\ndata: .*"type":"approval_required"/);
    const deliveredTerminalIds = [...text.matchAll(/^id: terminal-(\d+)$/gmu)].map((match) => Number(match[1]));
    assert.deepEqual(deliveredTerminalIds, Array.from({ length: 600 }, (_, index) => index));
    assert.equal(payload.overflowed, true);
    assert.equal(payload.terminal_overflowed, true);
  } finally {
    controller.abort();
    await http.close();
    await fixture.close();
  }
});
