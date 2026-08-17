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
    unsubscribe();

    const replayed: string[] = [];
    await fixture.host.dispose();
    const reopenedHost = fixture.createHost();
    const unsubscribeReopened = await reopenedHost.subscribe("conversation-1", (envelope) => {
      replayed.push(envelope.event.type);
    });
    assert(replayed.includes("entry_appended"));
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
