import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("group conversations create fixed participant sessions and route @mentions directly", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
      { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: now },
    ], [{ solution_instance_id: "solution-fixed", tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: "Fixed Group", coordinator_employee_id: "coordinator", expert_employee_ids: ["coordinator", "worker"] }], [
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord-snapshot", display_name: "Coordinator", tool_policy: { allowed_tools: ["mention_employee"] } },
      { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "worker-snapshot", display_name: "Worker", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "fixed-group", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", solutionRef: "solution-fixed", sessionFile: "", workspace: "" });
    const host = fixture.createHost();
    const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
    await host.initializeConversationParticipants("fixed-group", caller);
    const participants = fixture.store.listConversationParticipants("fixed-group");
    assert.deepEqual(participants.map((item) => item.employee_id), ["coordinator", "worker"]);
    assert.equal(new Set(participants.map((item) => item.session_file)).size, 2);

    fixture.faux.setResponses([fauxAssistantMessage("worker direct reply")]);
    await host.prompt("fixed-group", "@worker 请直接分析", undefined, caller, ["worker"]);
    const workerSession = fixture.store.getConversationParticipant("fixed-group", "worker");
    assert(workerSession?.session_file);
    const firstWorkerEntries = await host.entries("fixed-group");
    assert(firstWorkerEntries.some((entry) => (entry as unknown as { source_employee_id?: string }).source_employee_id === "worker"));

    fixture.faux.setResponses([fauxAssistantMessage("worker second reply")]);
    await host.prompt("fixed-group", "@worker 再补充", undefined, caller, ["worker"]);
    const workerSessionAfter = fixture.store.getConversationParticipant("fixed-group", "worker");
    assert.equal(workerSessionAfter?.session_file, workerSession?.session_file);
    assert((await host.entries("fixed-group")).length > firstWorkerEntries.length);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost orders persisted entries by ISO timestamps and preserves same-session append order", async () => {
  const fixture = await createFixture();
  const workspace = join(fixture.dataRoot, "workspaces", "ordered");
  const sessionFile = join(fixture.dataRoot, "sessions", "ordered.jsonl");
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  const now = new Date().toISOString();
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
    ], [], [{
      employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord", display_name: "Coordinator", tool_policy: { allowed_tools: [] },
    }]);
    fixture.store.createConversation({ id: "ordered-group", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", sessionFile: "", workspace: "" });
    fixture.store.upsertConversationParticipant({
      conversation_id: "ordered-group", employee_id: "coordinator", role: "coordinator", session_file: sessionFile, workspace, pi_session_id: "session-ordered", employee_version: "1",
    });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "session-ordered", timestamp: "2026-08-26T00:00:00.000Z", cwd: workspace }),
      JSON.stringify({ type: "message", id: "z-first-user", parentId: null, timestamp: "2026-08-26T00:00:00.001Z", message: { role: "user", content: "first", timestamp: 1 } }),
      JSON.stringify({ type: "message", id: "a-first-assistant", parentId: "z-first-user", timestamp: "2026-08-26T00:00:00.002Z", message: { role: "assistant", content: "first reply", timestamp: 2 } }),
      JSON.stringify({ type: "message", id: "z-second-user", parentId: "a-first-assistant", timestamp: "2026-08-26T00:00:00.003Z", message: { role: "user", content: "second", timestamp: 3 } }),
      JSON.stringify({ type: "message", id: "a-second-assistant", parentId: "z-second-user", timestamp: "2026-08-26T00:00:00.004Z", message: { role: "assistant", content: "second reply", timestamp: 4 } }),
      "",
    ].join("\n"));

    const entries = await fixture.host.entries("ordered-group");
    const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    assert(firstUser);
    assert.equal((firstUser as unknown as { source_type?: string }).source_type, "human");
    assert.equal("source_employee_id" in (firstUser as unknown as Record<string, unknown>), false);
    assert.deepEqual(
      entries.filter((entry) => entry.type === "message").map((entry) => {
        const message = entry.message as unknown as { role?: string; content?: unknown };
        return `${message.role}:${typeof message.content === "string" ? message.content : ""}`;
      }),
      ["user:first", "assistant:first reply", "user:second", "assistant:second reply"],
    );
  } finally {
    await fixture.close();
  }
});

test("group prompt without mentions routes to coordinator and multiple mentions fan out", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
      { employee_id: "worker-a", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "a", display_name: "A", revoked: false, synced_at: now },
      { employee_id: "worker-b", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "b", display_name: "B", revoked: false, synced_at: now },
    ], [], [
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord", display_name: "Coordinator", tool_policy: { allowed_tools: [] } },
      { employee_id: "worker-a", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "a", display_name: "A", tool_policy: { allowed_tools: [] } },
      { employee_id: "worker-b", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "b", display_name: "B", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "fanout-group", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", sessionFile: "", workspace: "" });
    const host = fixture.createHost();
    const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
    await host.initializeConversationParticipants("fanout-group", caller);
    fixture.faux.setResponses([fauxAssistantMessage("coordinator reply")]);
    await host.prompt("fanout-group", "请先回答", undefined, caller);
    fixture.faux.setResponses([fauxAssistantMessage("A reply"), fauxAssistantMessage("B reply")]);
    await host.prompt("fanout-group", "@a @b 请分别回答", undefined, caller, ["a", "b"]);
    const entries = await host.entries("fanout-group");
    assert(entries.some((entry) => (entry as unknown as { source_employee_id?: string }).source_employee_id === "coordinator"));
    assert(entries.some((entry) => (entry as unknown as { source_employee_id?: string }).source_employee_id === "worker-a"));
    assert(entries.some((entry) => (entry as unknown as { source_employee_id?: string }).source_employee_id === "worker-b"));
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("coordinator mention_employee uses the fixed peer session and unified delivery", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
      { employee_id: "worker-id", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: now },
    ], [], [
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord", display_name: "Coordinator", tool_policy: { allowed_tools: [] } },
      { employee_id: "worker-id", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "worker", display_name: "Worker", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "tool-group", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", sessionFile: "", workspace: "" });
    const host = fixture.createHost();
    const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
    await host.initializeConversationParticipants("tool-group", caller);
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mention_employee", { employee_id: "worker", task: "请返回固定 Session 结果" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("worker fixed-session reply"),
      fauxAssistantMessage("coordinator final"),
    ]);
    await host.prompt("tool-group", "请咨询 worker", undefined, caller);
    const participant = fixture.store.getConversationParticipant("tool-group", "worker-id");
    assert(participant?.session_file);
    assert((await host.entries("tool-group")).some((entry) => (entry as unknown as { source_employee_id?: string }).source_employee_id === "worker-id"));
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("group participant sessions receive bounded roster and solution context", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  const contexts: string[] = [];
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "协调员", revoked: false, synced_at: now, persona: "负责统筹项目沟通", tools: ["mention_employee"], skills: ["planning"] },
      { employee_id: "tester", tenant_id: "tenant-1", member_id: "member-1", version: "2", handle: "tester", display_name: "测试员", revoked: false, synced_at: now, persona: "负责测试和质量保障", tools: ["read"], skills: ["testing"], knowledge_refs: ["qa-space"], connector_refs: ["issue-tracker"] },
    ], [{
      solution_instance_id: "solution-software", tenant_id: "tenant-1", member_id: "member-1", version: "3:1", solution_id: "software-template", display_name: "软件开发", description: "软件研发协作方案", tags: ["研发", "质量"], status: "applied", coordinator_employee_id: "coordinator", expert_employee_ids: ["coordinator", "tester"], coordinator_instructions: "先分析需求，再安排测试", workflow_skill_ref: { skill_id: "software-workflow", version: "1" }, output_requirements: "输出可执行的开发结论",
    }], [
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord-snapshot", display_name: "协调员", persona: "负责统筹项目沟通", tools: ["mention_employee"], skill_refs: ["planning"], tool_policy: { allowed_tools: ["mention_employee"] } },
      { employee_id: "tester", tenant_id: "tenant-1", member_id: "member-1", version: "2", snapshot_version: "tester-snapshot", display_name: "测试员", persona: "负责测试和质量保障", tools: ["read"], skill_refs: ["testing"], knowledge_refs: ["qa-space"], connector_refs: ["issue-tracker"], tool_policy: { allowed_tools: ["read"] } },
    ]);
    fixture.store.createConversation({ id: "group-context", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", solutionRef: "solution-software", sessionFile: "", workspace: "" });
    const host = fixture.createHost(undefined, undefined, (_id, authorization) => {
      contexts.push(authorization?.groupContext ?? "");
      return createControlledResourceLoader("test system prompt");
    });
    await host.initializeConversationParticipants("group-context", caller);
    fixture.faux.setResponses([fauxAssistantMessage("done")]);
    await host.prompt("group-context", "请开始", undefined, caller);

    assert.equal(contexts.length, 1);
    assert.match(contexts[0]!, /软件开发/);
    assert.match(contexts[0]!, /software-template/);
    assert.match(contexts[0]!, /软件研发协作方案/);
    assert.match(contexts[0]!, /研发、质量/);
    assert.match(contexts[0]!, /software-workflow@1/);
    assert.match(contexts[0]!, /先分析需求，再安排测试/);
    assert.match(contexts[0]!, /输出可执行的开发结论/);
    assert.match(contexts[0]!, /测试员/);
    assert.match(contexts[0]!, /@tester/);
    assert.match(contexts[0]!, /负责测试和质量保障/);
    assert.match(contexts[0]!, /read/);
    assert.match(contexts[0]!, /testing/);
    assert.match(contexts[0]!, /qa-space/);
    await host.dispose();
  } finally {
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
    const envelopes: Array<{ conversation_id?: string; source_ref?: string; tool_call_id?: string; source_employee_id?: string; source_employee_display_name?: string; source_role?: string; event: { type: string } }> = [];
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
    assert(childEvents.every((envelope) => envelope.source_employee_id && envelope.source_employee_display_name && envelope.event));
    assert(childEvents.every((envelope) => envelope.source_role === "child"));
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
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: ["read"] } }]);
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

test("SessionHost exposes local context HUD state, persists thinking changes, and captures safe artifacts", async () => {
  const fixture = await createFixture();
  const reasoning = fauxProvider({
    api: "aiteam-reasoning-api",
    provider: "aiteam-reasoning",
    models: [{ id: "aiteam-reasoning-1", name: "Reasoning Test", reasoning: true, contextWindow: 1_000 }],
  });
  fixture.modelRuntime.registerNativeProvider(reasoning.provider);
  const now = new Date().toISOString();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  let workspace = "";
  const host = fixture.createHost(reasoning.getModel(), undefined, (_id, _authorization, path) => {
    workspace = path ?? "";
    return createControlledResourceLoader("test system prompt");
  });
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now, model_policy: { model: reasoning.getModel().id } },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });

    const initial = await host.getConversationContext("conversation-1", caller);
    assert.equal(initial.model?.id, reasoning.getModel().id);
    assert.equal(initial.context_window, 1_000);
    assert.equal(initial.thinking_level, "off");

    const changed = await host.setThinkingLevel("conversation-1", "high", caller);
    assert.equal(changed.thinking_level, "high");
    reasoning.setResponses([() => {
      writeFileSync(join(workspace, "generated.ts"), "export const answer = 42;\n");
      writeFileSync(join(workspace, ".env"), "API_KEY=must-not-capture\n");
      writeFileSync(join(workspace, "notes.ts"), "const api_key = 'sk-secret-value';\n");
      return fauxAssistantMessage("done");
    }]);
    await host.prompt("conversation-1", "generate", undefined, caller);

    const after = await host.getConversationContext("conversation-1", caller);
    assert.equal(after.thinking_level, "high");
    assert.equal(after.prompting, false);
    assert.equal(after.available_thinking_levels.includes("high"), true);
    const officeActivities = await host.getOfficeActivities("conversation-1");
    assert.equal(officeActivities.length, 1);
    assert.equal(officeActivities[0]?.last_status, "completed");
    assert.equal(typeof officeActivities[0]?.last_activity_at, "string");
    const artifacts = fixture.store.listOwnedLocalFiles("conversation-1", "tenant-1", "member-1", "artifact");
    assert.deepEqual(artifacts.map((item) => item.filename), ["generated.ts"]);
    assert.equal(fixture.store.readOwnedLocalFile(artifacts[0]!.id, "conversation-1", "tenant-1", "member-1")?.data.toString(), "export const answer = 42;\n");
  } finally {
    await host.dispose();
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
