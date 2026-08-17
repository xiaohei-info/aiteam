import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";
import type { ManagerClient } from "../manager-client.js";

test("SessionHost persists a Pi session and replays entries", async () => {
  const fixture = await createFixture();
  try {
    fixture.faux.setResponses([fauxAssistantMessage("hello from pi")]);
    const events: string[] = [];
    const unsubscribe = await fixture.host.subscribe("conversation-1", (envelope) => {
      events.push(envelope.event.type);
    });

    const leafId = await fixture.host.prompt("conversation-1", "hello");
    assert(leafId);
    assert(events.includes("message_update"));
    assert(events.includes("agent_settled"));
    const entries = await fixture.host.entries("conversation-1");
    assert(entries.some((entry) => entry.type === "message"));
    assert.equal(
      (fixture.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pi_event'").get() as { name?: string } | undefined)?.name,
      undefined,
    );
    unsubscribe();

    const replayed: string[] = [];
    await fixture.host.dispose();
    const reopenedHost = fixture.createHost();
    const unsubscribeReopened = await reopenedHost.subscribe("conversation-1", (envelope) => {
      replayed.push(envelope.event.type);
    });
    assert.deepEqual(replayed, []);
    const reopenedEntries = await reopenedHost.entries("conversation-1");
    assert(reopenedEntries.some((entry) => entry.type === "message"));
    unsubscribeReopened();
    await reopenedHost.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost binds authorized snapshot tools and emits Pi tool events", async () => {
  const fixture = await createFixture();
  try {
    const calls: unknown[][] = [];
    const manager = {
      memoryRecall: async (...args: unknown[]) => (calls.push(args), { memories: [{ content: "remembered" }] }),
    };
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test" } },
    ], [], [{ employee_id: "employee-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", persona: "Be helpful", skill_refs: ["skill-authorized"], tool_policy: { allowed_tools: ["memory_recall"] }, knowledge_refs: ["knowledge-authorized"] }]);
    fixture.store.createConversation({ id: "authorized-conversation", sessionFile: "", workspace: "", entryEmployeeId: "employee-1" });
    const host = fixture.createHost(undefined, manager as ManagerClient);
    const events: string[] = [];
    await host.subscribe("authorized-conversation", (envelope) => events.push(envelope.event.type));
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory_recall", { query: "remembered", limit: 1 }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.prompt("authorized-conversation", "Use memory", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" });
    const entries = await host.entries("authorized-conversation");
    assert.deepEqual(calls[0]?.slice(1), ["employee-1", "remembered", 1], `${events.join(",")} ${JSON.stringify(entries)}`);
    assert(events.includes("tool_execution_start"));
    assert(events.includes("tool_execution_end"));
    await assert.rejects(
      host.prompt("authorized-conversation", "No cross-tenant access", undefined, { callerId: "member-2", userId: "member-2", tenantId: "other-tenant" }),
      /not authorized locally/,
    );
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("delegate_employee rejects cross-tenant or missing local roster targets", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = (employeeId: string, version = "1") => ({ employee_id: employeeId, version, snapshot_version: `snapshot-${employeeId}`, display_name: employeeId, persona: "Delegate", tool_policy: { allowed_tools: ["delegate_employee"] } });
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: new Date().toISOString() },
      { employee_id: "same-tenant", tenant_id: "tenant-1", version: "1", handle: "same", display_name: "Same", revoked: false, synced_at: new Date().toISOString() },
      { employee_id: "other-tenant", tenant_id: "tenant-2", version: "1", handle: "other", display_name: "Other", revoked: false, synced_at: new Date().toISOString() },
    ], [], [snapshot("coordinator"), snapshot("same-tenant"), snapshot("other-tenant")]);
    fixture.store.createConversation({ id: "group-auth", sessionFile: "", workspace: "", coordinatorEmployeeId: "coordinator" });
    const host = fixture.createHost();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate_employee", { employee_id: "other-tenant", task: "do not run" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.prompt("group-auth", "delegate", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    const entries = await host.entries("group-auth");
    const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert(result && result.type === "message" && result.message.role === "toolResult");
    assert.match(result.message.content[0]?.type === "text" ? result.message.content[0].text : "", /authorized local roster/);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("delegate_employee forwards child events with opaque attribution and bounds fanout", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = (employeeId: string) => ({ employee_id: employeeId, version: "1", snapshot_version: `snapshot-${employeeId}`, display_name: employeeId, persona: "Delegate", tool_policy: { allowed_tools: ["delegate_employee"] } });
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: new Date().toISOString() },
      ...["a", "b", "c", "d", "e"].map((employee_id) => ({ employee_id, tenant_id: "tenant-1", version: "1", handle: employee_id, display_name: employee_id, revoked: false, synced_at: new Date().toISOString() })),
    ], [], [snapshot("coordinator"), ...["a", "b", "c", "d", "e"].map(snapshot)]);
    fixture.store.createConversation({ id: "group-fanout", sessionFile: "", workspace: "", coordinatorEmployeeId: "coordinator" });
    const host = fixture.createHost();
    const envelopes: Array<{ source_ref?: string; tool_call_id?: string; event: { type: string } }> = [];
    await host.subscribe("group-fanout", (envelope) => envelopes.push(envelope as typeof envelopes[number]));
    fixture.faux.setResponses([
      fauxAssistantMessage(["a", "b", "c", "d", "e"].map((employee_id, index) => fauxToolCall("delegate_employee", { employee_id, task: `task-${index}` }, { id: `call-${index}` })), { stopReason: "toolUse" }),
      ...["a", "b", "c", "d"].map((employee_id) => fauxAssistantMessage(`${employee_id} result`)),
      fauxAssistantMessage("coordinator result"),
    ]);
    await host.prompt("group-fanout", "delegate", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    const childEvents = envelopes.filter((envelope) => envelope.source_ref);
    assert(childEvents.length > 0);
    assert(childEvents.every((envelope) => envelope.source_ref && envelope.tool_call_id));
    assert.equal(new Set(childEvents.map((envelope) => envelope.tool_call_id)).size, 4);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost aborts active delegated child sessions", async () => {
  const fixture = await createFixture();
  try {
    const slow = fauxProvider({
      api: "aiteam-delegate-slow-api",
      provider: "aiteam-delegate-slow",
      models: [{ id: "aiteam-delegate-slow-1", name: "AI Team Delegate Slow" }],
      tokensPerSecond: 50,
    });
    fixture.modelRuntime.registerNativeProvider(slow.provider);
    const host = fixture.createHost(slow.getModel());
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: new Date().toISOString() },
      { employee_id: "worker", tenant_id: "tenant-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: new Date().toISOString() },
    ], [], [
      { employee_id: "coordinator", version: "1", snapshot_version: "snapshot-coordinator", display_name: "Coordinator", tool_policy: { allowed_tools: ["delegate_employee"] } },
      { employee_id: "worker", version: "1", snapshot_version: "snapshot-worker", display_name: "Worker", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "group-abort", sessionFile: "", workspace: "", coordinatorEmployeeId: "coordinator" });
    slow.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate_employee", { employee_id: "worker", task: "slow task" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("slow ".repeat(200)),
      fauxAssistantMessage("parent result"),
    ]);
    const pending = host.prompt("group-abort", "delegate", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await host.abort("group-abort"), true);
    await pending;
    assert.equal(host.isPrompting("group-abort"), false);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost aborts an active Pi prompt", async () => {
  const fixture = await createFixture();
  try {
    const slow = fauxProvider({
      api: "aiteam-slow-api",
      provider: "aiteam-slow",
      models: [{ id: "aiteam-slow-1", name: "AI Team Slow" }],
      tokensPerSecond: 50,
    });
    fixture.modelRuntime.registerNativeProvider(slow.provider);
    const slowHost = fixture.createHost(slow.getModel());
    const events: string[] = [];
    await slowHost.subscribe("conversation-2", (envelope) => events.push(envelope.event.type));
    slow.setResponses([fauxAssistantMessage("slow ".repeat(200))]);

    const pending = slowHost.prompt("conversation-2", "start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await slowHost.abort("conversation-2"), true);
    await pending;
    assert(events.includes("agent_end"));
    assert.equal(slowHost.isPrompting("conversation-2"), false);
    await slowHost.dispose();
  } finally {
    await fixture.close();
  }
});
