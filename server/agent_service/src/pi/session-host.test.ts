import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";
import { createControlledResourceLoader, hindsightStateDir } from "./resources.js";
import type { HindsightRuntimeConfig, ManagerClient } from "../manager-client.js";

function lease(version: number, token: string): HindsightRuntimeConfig {
  return {
    base_url: "https://manager.test/api/manager/hindsight",
    bank_id: "aiteam-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token,
    lease_id: `lease-${version}`,
    version,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("SessionHost pulls a fresh Hindsight lease for each new session without persisting the secret", async () => {
  const fixture = await createFixture();
  const leases: HindsightRuntimeConfig[] = [lease(1, "lease-one-secret"), lease(2, "lease-two-secret")];
  const received: HindsightRuntimeConfig[] = [];
  let leaseIndex = 0;
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    pullHindsightRuntimeConfig: async () => leases[leaseIndex++]!,
  };
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", memory_policy: { enabled: true }, tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const host = fixture.createHost(undefined, manager, (_id, auth, workspace, agentDir, config) => {
      assert(config);
      received.push(config);
      const loader = createControlledResourceLoader("prompt", undefined, auth, workspace, agentDir, undefined, config);
      loader.reload = async () => {};
      loader.shutdown = async () => {};
      return loader;
    });
    fixture.faux.setResponses([fauxAssistantMessage("first")]);
    await host.prompt("conversation-1", "one", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    fixture.faux.setResponses([fauxAssistantMessage("second")]);
    await host.prompt("conversation-1", "two", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    assert.deepEqual(received.map((item) => item.version), [1, 2]);
    assert.equal(received.some((item) => item.token === "lease-one-secret"), true);
    assert.equal(received.some((item) => item.token === "lease-two-secret"), true);
    const sessionFile = fixture.store.getConversation("conversation-1")?.sessionFile;
    assert(sessionFile);
    assert.equal(readFileSync(sessionFile, "utf8").includes("lease-one-secret"), false);
    assert.equal(readFileSync(sessionFile, "utf8").includes("lease-two-secret"), false);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("production SessionHost fails closed when an enabled memory policy has no Manager lease", async () => {
  const fixture = await createFixture();
  const previousEnvironment = process.env.AITEAM_ENV;
  process.env.AITEAM_ENV = "production";
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", memory_policy: { enabled: true }, tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const manager: ManagerClient = {
      pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
      getOrgTree: async () => ({}),
    };
    const host = fixture.createHost(undefined, manager);
    await assert.rejects(
      host.prompt("conversation-1", "must fail", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" }),
      /Hindsight lease is unavailable/,
    );
    await host.dispose();
  } finally {
    if (previousEnvironment === undefined) delete process.env.AITEAM_ENV;
    else process.env.AITEAM_ENV = previousEnvironment;
    await fixture.close();
  }
});

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

test("SessionHost flushes a controlled lifecycle once before disposing the parent session", async () => {
  const fixture = await createFixture();
  let shutdowns = 0;
  try {
    fixture.faux.setResponses([fauxAssistantMessage("shutdown check")]);
    const host = fixture.createHost(undefined, undefined, () => {
      const loader = createControlledResourceLoader("test system prompt");
      const shutdown = loader.shutdown.bind(loader);
      loader.shutdown = async () => { shutdowns += 1; await shutdown(); };
      return loader;
    });
    await host.prompt("conversation-1", "shutdown");
    assert.equal(shutdowns, 1);
    await host.dispose();
    assert.equal(shutdowns, 1);
  } finally {
    await fixture.close();
  }
});

test("SessionHost.delete waits for pending session initialization before cleanup", async () => {
  const fixture = await createFixture();
  try {
    let startReload!: () => void;
    let releaseReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => { startReload = resolve; });
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    const host = fixture.createHost(undefined, undefined, () => {
      const loader = createControlledResourceLoader("test system prompt");
      loader.reload = async () => {
        startReload();
        await reloadGate;
        throw new Error("initialization stopped");
      };
      return loader;
    });
    const pendingPrompt = host.prompt("conversation-1", "delete while loading");
    const workspace = fixture.store.getConversation("conversation-1")?.workspace;
    assert(workspace);
    let deleted = false;
    const pendingDelete = host.delete("conversation-1", "tenant-1", "member-1").then((value) => {
      deleted = true;
      return value;
    });
    await reloadStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deleted, false);
    releaseReload();
    await assert.rejects(pendingPrompt, /initialization stopped/);
    assert.equal(await pendingDelete, true);
    assert.equal(existsSync(workspace), false);
  } finally {
    await fixture.close();
  }
});

test("SessionHost.delete removes Agent-owned Hindsight state after lifecycle flush", async () => {
  const fixture = await createFixture();
  let shutdowns = 0;
  let stateDir = "";
  try {
    const host = fixture.createHost(undefined, undefined, (_conversationId, _authorization, workspace, agentDir) => {
      assert(workspace);
      assert(agentDir);
      stateDir = hindsightStateDir(agentDir, workspace);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${stateDir}/retain-queue.jsonl`, "failed-retry\n");
      const loader = createControlledResourceLoader("test system prompt");
      const shutdown = loader.shutdown.bind(loader);
      loader.shutdown = async () => { shutdowns += 1; await shutdown(); };
      return loader;
    });
    fixture.faux.setResponses([fauxAssistantMessage("delete cleanup")]);
    await host.prompt("conversation-1", "delete me");
    assert.equal(existsSync(`${stateDir}/retain-queue.jsonl`), true);
    assert.equal(await host.delete("conversation-1", "tenant-1", "member-1"), true);
    assert.equal(shutdowns, 1);
    assert.equal(existsSync(stateDir), false);
  } finally {
    await fixture.close();
  }
});

test("same-tenant members cannot read or prompt each other's projections and sessions", async () => {
  const fixture = await createFixture();
  try {
    const now = new Date().toISOString();
    fixture.store.replaceProjections([
      { employee_id: "member-one-employee", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "one", display_name: "One", revoked: false, synced_at: now, model_policy: { model: "test" } },
      { employee_id: "member-two-employee", tenant_id: "tenant-1", member_id: "member-2", version: "1", handle: "two", display_name: "Two", revoked: false, synced_at: now, model_policy: { model: "test" } },
    ], [], [
      { employee_id: "member-one-employee", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "one", display_name: "One", tool_policy: { allowed_tools: [] } },
      { employee_id: "member-two-employee", tenant_id: "tenant-1", member_id: "member-2", version: "1", snapshot_version: "two", display_name: "Two", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "member-two-session", tenantId: "tenant-1", memberId: "member-2", sessionFile: "", workspace: "", entryEmployeeId: "member-two-employee" });
    assert.deepEqual(fixture.store.listLoadedExperts("tenant-1", "member-1").map((expert) => expert.employee_id), ["member-one-employee"]);
    assert.deepEqual(fixture.store.listSnapshots("tenant-1", "member-1").map((snapshot) => snapshot.employee_id), ["member-one-employee"]);
    const host = fixture.createHost();
    await assert.rejects(host.prompt("member-two-session", "must not run", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" }), /not authorized locally/);
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
    const envelopes: Array<{ conversation_id?: string; source_ref?: string; tool_call_id?: string; source_employee_id?: string; source_employee_display_name?: string; event: { type: string } }> = [];
    await host.subscribe("group-fanout", (envelope) => envelopes.push(envelope as typeof envelopes[number]));
    fixture.faux.setResponses([
      fauxAssistantMessage(["a", "b", "c", "d", "e"].map((employee_id, index) => fauxToolCall("delegate_employee", { employee_id, task: `task-${index}` }, { id: `call-${index}` })), { stopReason: "toolUse" }),
      ...["a", "b", "c", "d"].map((employee_id) => fauxAssistantMessage(`${employee_id} result`)),
      fauxAssistantMessage("coordinator result"),
    ]);
    await host.prompt("group-fanout", "delegate", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    const childEvents = envelopes.filter((envelope) => envelope.source_ref);
    assert(childEvents.length > 0);
    assert(envelopes.every((envelope) => envelope.conversation_id === "group-fanout"));
    assert(childEvents.every((envelope) => envelope.source_ref && envelope.tool_call_id));
    assert(childEvents.every((envelope) => envelope.source_employee_id && envelope.source_employee_display_name));
    assert.deepEqual(
      [...new Set(childEvents.map((envelope) => `${envelope.source_employee_id}:${envelope.source_employee_display_name}`))].sort(),
      ["a:a", "b:b", "c:c", "d:d"],
    );
    assert.equal(new Set(childEvents.map((envelope) => envelope.tool_call_id)).size, 4);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost registers todo_update only for an explicitly authorized parent snapshot", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: ["todo_update"] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const host = fixture.createHost();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo_update", { items: [{ id: "one", title: "Finish", status: "pending" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.prompt("conversation-1", "track this", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    const entries = await host.entries("conversation-1");
    const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert(result && result.type === "message" && result.message.role === "toolResult");
    const text = result.message.content[0]?.type === "text" ? result.message.content[0].text : "";
    assert.match(text, /item_count/);
    assert.match(text, /Finish/);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost does not register todo_update when the snapshot policy omits it", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const host = fixture.createHost();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo_update", { items: [{ id: "one", title: "must not run", status: "pending" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.prompt("conversation-1", "do not track", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    const entries = await host.entries("conversation-1");
    const result = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert(result && result.type === "message" && result.message.role === "toolResult");
    const text = result.message.content[0]?.type === "text" ? result.message.content[0].text : "";
    assert.doesNotMatch(text, /must not run/);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost pulls and disposes a separate Hindsight lease for delegated children", async () => {
  const fixture = await createFixture();
  const received: HindsightRuntimeConfig[] = [];
  let nextVersion = 1;
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    pullHindsightRuntimeConfig: async () => lease(nextVersion++, `child-lease-${nextVersion}`),
  };
  let shutdowns = 0;
  try {
    const snapshot = (employeeId: string, tools: string[]) => ({ employee_id: employeeId, version: "1", snapshot_version: `snapshot-${employeeId}`, display_name: employeeId, memory_policy: { enabled: true }, tool_policy: { allowed_tools: tools } });
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: new Date().toISOString() },
      { employee_id: "worker", tenant_id: "tenant-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: new Date().toISOString() },
    ], [], [snapshot("coordinator", ["delegate_employee"]), snapshot("worker", [])]);
    fixture.store.createConversation({ id: "group-lease-child", sessionFile: "", workspace: "", coordinatorEmployeeId: "coordinator" });
    const host = fixture.createHost(undefined, manager, (_id, auth, workspace, agentDir, config) => {
      assert(config);
      received.push(config);
      const loader = createControlledResourceLoader("prompt", undefined, auth, workspace, agentDir, undefined, config);
      loader.reload = async () => {};
      const shutdown = loader.shutdown.bind(loader);
      loader.shutdown = async () => { shutdowns += 1; await shutdown(); };
      return loader;
    });
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate_employee", { employee_id: "worker", task: "child task" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("child result"),
      fauxAssistantMessage("parent result"),
    ]);
    await host.prompt("group-lease-child", "delegate", undefined, { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" });
    assert(received.length >= 2);
    assert(new Set(received.map((item) => item.lease_id)).size >= 2);
    assert(shutdowns >= 2);
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
