import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";
import { createControlledResourceLoader, hindsightStateDir } from "./resources.js";
import { ManagerAuthorizationError, ManagerPolicyDeniedError, ManagerTimeoutError, ManagerUnavailableError, MemoryRetainUnverifiedError, type HindsightRuntimeConfig, type ManagerClient } from "../manager-client.js";
import { appLogger } from "../observability.js";
import { resetTranscript } from "./session-host.js";

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

test("SessionHost publishes a terminal event when Manager runtime setup fails", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  try {
    const now = new Date().toISOString();
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now, model_policy: { model: "model-1", provider_ref: "provider-1" } },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", model_policy: { model: "model-1", provider_ref: "provider-1" } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const manager: ManagerClient = {
      pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
      getOrgTree: async () => ({}),
      pullRuntimeConfig: async () => { throw new Error("Manager returned HTTP 404"); },
    };
    const host = fixture.createHost(undefined, manager);
    const events: string[] = [];
    await host.subscribe("conversation-1", (envelope) => events.push(envelope.event.type));

    await assert.rejects(
      host.prompt("conversation-1", "hello", undefined, caller),
      /Manager returned HTTP 404/,
    );
    assert(events.includes("agent_settled"));
    assert.equal(host.isPrompting("conversation-1"), false);
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
      writeFileSync(join(workspace, "config.json"), JSON.stringify({ apiKey: "0123456789" }));
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
    let activeRuns: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 20 && activeRuns.length === 0; attempt += 1) {
      activeRuns = slowHost.activeRuns("conversation-2");
      if (activeRuns.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(activeRuns.length, 1);
    assert(["thinking", "text", "tool"].includes(String(activeRuns[0]?.status)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await slowHost.abort("conversation-2"), true);
    await pending;
    assert(events.includes("agent_end"));
    assert.equal(slowHost.isPrompting("conversation-2"), false);
    assert.deepEqual(slowHost.activeRuns("conversation-2"), []);
    await slowHost.dispose();
  } finally {
    await fixture.close();
  }
});

function resetFixtureProjections(fixture: Awaited<ReturnType<typeof createFixture>>, memoryPolicy?: Record<string, unknown>): void {
  const now = new Date().toISOString();
  fixture.store.replaceProjections([
    { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now },
  ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}), tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
}

test("resetContext retains the old branch, keeps visible history, and hides it from the next prompt", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  const retained: Array<{ employeeId: string; content: string; metadata?: Record<string, unknown>; idempotencyKey?: string }> = [];
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    memoryRetain: async (_caller, employeeId, content, metadata, idempotencyKey) => {
      retained.push({ employeeId, content, metadata, idempotencyKey });
      return { operationId: "op-1" };
    },
  };
  try {
    resetFixtureProjections(fixture, { enabled: true, allowed_operations: ["recall", "retain"] });
    const host = fixture.createHost(undefined, manager);
    fixture.faux.setResponses([fauxAssistantMessage("记住了菠萝")]);
    await host.prompt("conversation-1", "我喜欢菠萝", undefined, caller);

    const result = await host.resetContext("conversation-1", caller);
    assert.equal(result.reset, true);
    assert.equal(result.memory_saved, true);
    assert.equal(result.already_reset, false);
    assert.equal(result.confirmation_required, false);
    assert.deepEqual(result.participants, [{ employee_id: "employee-1", reset: true, already_reset: false, reset_id: result.reset_id, message_count: 2, memory_saved: true, memory_reason: "saved", operation_id: "op-1" }]);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.employeeId, "employee-1");
    assert.match(retained[0]!.content, /用户: 我喜欢菠萝/);
    assert.match(retained[0]!.content, /Agent: 记住了菠萝/);
    assert.equal(retained[0]!.metadata?.source, "context_reset");
    assert.equal(retained[0]!.metadata?.reset_id, result.reset_id);
    assert(retained[0]!.idempotencyKey && retained[0]!.idempotencyKey.length <= 128);

    let seen = "";
    fixture.faux.setResponses([(context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("新的开始");
    }]);
    await host.prompt("conversation-1", "你好", undefined, caller);
    assert.equal(seen.includes("菠萝"), false);
    assert.equal(seen.includes("你好"), true);

    const entries = await host.entries("conversation-1", caller) as Array<Record<string, any>>;
    const marker = entries.find((entry) => entry.type === "custom" && entry.customType === "aiteam_context_reset");
    assert.equal(marker?.data?.reset_id, result.reset_id);
    assert.equal(marker?.data?.memory_reason, "saved", "the divider can show whether memory was saved");
    assert.equal(typeof marker?.entry_ref, "string");
    const texts = JSON.stringify(entries);
    assert(texts.includes("我喜欢菠萝"), "visible history keeps pre-reset messages");
    assert(texts.includes("新的开始"));
    const activities = await host.getOfficeActivities("conversation-1");
    assert.equal(activities[0]?.last_status, "completed");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("resetContext still resets when memory retain is not enabled, and is a no-op without replies", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  let retainCalls = 0;
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    memoryRetain: async () => { retainCalls += 1; return { operationId: "op-unexpected" }; },
  };
  try {
    resetFixtureProjections(fixture);
    const host = fixture.createHost(undefined, manager);
    const empty = await host.resetContext("conversation-1", caller);
    assert.equal(empty.reset, false);
    assert.equal(empty.participants[0]?.memory_reason, "empty");

    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    await host.prompt("conversation-1", "hello", undefined, caller);
    const result = await host.resetContext("conversation-1", caller);
    assert.equal(result.reset, true);
    assert.equal(result.memory_saved, false);
    assert.equal(result.participants[0]?.memory_reason, "retain_disabled");
    assert.equal(retainCalls, 0);

    const again = await host.resetContext("conversation-1", caller);
    assert.equal(again.reset, true, "a replay reports the earlier reset instead of empty");
    assert.equal(again.already_reset, true);
    assert.equal(again.reset_id, result.reset_id);
    assert.equal(again.participants[0]?.memory_reason, "retain_disabled");
    assert.equal(again.participants[0]?.reset_id, result.reset_id);
    const markers = (await host.entries("conversation-1", caller) as Array<Record<string, any>>)
      .filter((entry) => entry.type === "custom" && entry.customType === "aiteam_context_reset");
    assert.equal(markers.length, 1, "a replay must not write a second marker");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("resetContext keeps the context on a transient retain failure until the user proceeds", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  let failure: Error = new Error("boom");
  let retainCalls = 0;
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    memoryRetain: async () => { retainCalls += 1; throw failure; },
  };
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const originalLog = appLogger.log;
  appLogger.log = (_level, event, fields = {}) => { logged.push({ event, fields }); };
  try {
    resetFixtureProjections(fixture, { enabled: true, allowed_operations: ["recall", "retain"] });
    const host = fixture.createHost(undefined, manager);
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    await host.prompt("conversation-1", "hello", undefined, caller);

    const cases: Array<[Error, string]> = [
      [new Error("boom"), "manager_unavailable"],
      [new ManagerUnavailableError("Manager returned HTTP 503", { status: 503 }), "manager_unavailable"],
      [new ManagerUnavailableError("Manager returned HTTP 413", { status: 413 }), "too_large"],
      [new ManagerTimeoutError(), "timeout"],
      [new MemoryRetainUnverifiedError(), "retention_unverified"],
      [new ManagerAuthorizationError(401), "unauthorized"],
    ];
    for (const [error, reason] of cases) {
      failure = error;
      logged.length = 0;
      const blocked = await host.resetContext("conversation-1", caller);
      assert.equal(blocked.reset, false, reason);
      assert.equal(blocked.confirmation_required, true, reason);
      assert.equal(blocked.participants[0]?.memory_reason, reason);
      assert.equal(blocked.participants[0]?.reset_id, null);
      const log = logged.find((item) => item.event === "context_reset.retain_failed");
      assert.equal(log?.fields.reset_id, blocked.reset_id, `log carries reset_id for ${reason}`);
      assert.equal(log?.fields.memory_reason, reason);
    }
    // The context was kept: the next prompt still sees the earlier message.
    let seen = "";
    fixture.faux.setResponses([(context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("still here"); }]);
    await host.prompt("conversation-1", "again", undefined, caller);
    assert.equal(seen.includes("hello"), true);

    failure = new ManagerTimeoutError();
    const proceeded = await host.resetContext("conversation-1", caller, { onMemoryFailure: "proceed" });
    assert.equal(proceeded.reset, true);
    assert.equal(proceeded.confirmation_required, false);
    assert.equal(proceeded.participants[0]?.memory_reason, "timeout");
    assert.equal(proceeded.participants[0]?.operation_id, null);
    const entries = await host.entries("conversation-1", caller) as Array<Record<string, any>>;
    const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "aiteam_context_reset");
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.data?.memory_reason, "timeout", "the divider shows why memory was not saved");
    assert.equal(retainCalls, cases.length + 1);
    await host.dispose();
  } finally {
    appLogger.log = originalLog;
    await fixture.close();
  }
});

test("resetContext resets directly when policy denies the retain or save_memory is false", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  let retainCalls = 0;
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    memoryRetain: async () => { retainCalls += 1; throw new ManagerPolicyDeniedError(409); },
  };
  try {
    resetFixtureProjections(fixture, { enabled: true, allowed_operations: ["recall", "retain"] });
    const host = fixture.createHost(undefined, manager);
    fixture.faux.setResponses([fauxAssistantMessage("one")]);
    await host.prompt("conversation-1", "first", undefined, caller);
    const denied = await host.resetContext("conversation-1", caller);
    assert.equal(denied.reset, true);
    assert.equal(denied.confirmation_required, false);
    assert.equal(denied.participants[0]?.memory_reason, "policy");
    assert.equal(retainCalls, 1);

    fixture.faux.setResponses([fauxAssistantMessage("two")]);
    await host.prompt("conversation-1", "second", undefined, caller);
    const skipped = await host.resetContext("conversation-1", caller, { saveMemory: false });
    assert.equal(skipped.reset, true);
    assert.equal(skipped.participants[0]?.memory_reason, "skipped");
    assert.equal(retainCalls, 1, "save_memory=false never calls Manager");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("resetContext answers a retry that races the first request with the same reset", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  let retainCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    memoryRetain: async () => { retainCalls += 1; await gate; return { operationId: "op-race" }; },
  };
  try {
    resetFixtureProjections(fixture, { enabled: true, allowed_operations: ["recall", "retain"] });
    const host = fixture.createHost(undefined, manager);
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    await host.prompt("conversation-1", "hello", undefined, caller);

    const first = host.resetContext("conversation-1", caller);
    // The retry arrives while the first request is still waiting on Manager.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retry = host.resetContext("conversation-1", caller);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(retainCalls, 1, "the retry waits behind the first request");
    release();
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.reset, true);
    assert.equal(a.already_reset, false);
    assert.equal(b.reset, true);
    assert.equal(b.already_reset, true);
    assert.equal(b.reset_id, a.reset_id);
    assert.equal(b.participants[0]?.memory_reason, "saved");
    assert.equal(b.participants[0]?.operation_id, "op-race");
    assert.equal(retainCalls, 1);
    const markers = (await host.entries("conversation-1", caller) as Array<Record<string, any>>)
      .filter((entry) => entry.type === "custom" && entry.customType === "aiteam_context_reset");
    assert.equal(markers.length, 1);
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("resetTranscript keeps long Chinese transcripts under the UTF-8 byte budget", () => {
  const message = (id: string, role: "user" | "assistant", text: string) => ({
    type: "message", id, parentId: null, timestamp: new Date().toISOString(),
    message: role === "user" ? { role, content: text, timestamp: 0 } : { role, content: [{ type: "text", text }], timestamp: 0 },
  }) as unknown as Parameters<typeof resetTranscript>[0][number];
  const long = "中文记忆内容".repeat(20_000); // 120k chars, ~360 KB in UTF-8
  const result = resetTranscript([message("m1", "user", long), message("m2", "assistant", "最后一句结论😀")]);
  assert.equal(result.truncated, true);
  const bytes = Buffer.byteLength(JSON.stringify(result.content), "utf8");
  assert(bytes <= 200 * 1024, `content is ${bytes} bytes`);
  assert(bytes > 190 * 1024, "truncation keeps close to the budget");
  assert(result.content.length <= 131_072);
  assert(result.content.endsWith("Agent: 最后一句结论😀"), "newest content is kept");
  assert(result.content.startsWith("以下是用户主动开启新上下文前的对话记录"), "header is kept");
  // Manager body limit: content plus envelope and metadata stays under 256 KiB.
  const body = JSON.stringify({ employee_id: "employee-1", content: result.content, metadata: { source: "context_reset", conversation_id: "c".repeat(64), reset_id: "r".repeat(36), message_count: 2, truncated: true } });
  assert(Buffer.byteLength(body, "utf8") < 256 * 1024);

  const short = resetTranscript([message("m1", "user", "你好"), message("m2", "assistant", "好的")]);
  assert.equal(short.truncated, false);
  assert.match(short.content, /用户: 你好\n\nAgent: 好的$/);
});

test("resetContext keeps the chosen thinking level and rejects while a prompt is running", async () => {
  const fixture = await createFixture();
  const reasoning = fauxProvider({
    api: "aiteam-reset-api",
    provider: "aiteam-reset",
    models: [{ id: "aiteam-reset-1", name: "Reset Test", reasoning: true, contextWindow: 1_000 }],
    tokensPerSecond: 50,
  });
  fixture.modelRuntime.registerNativeProvider(reasoning.provider);
  const now = new Date().toISOString();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  const host = fixture.createHost(reasoning.getModel());
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now, model_policy: { model: reasoning.getModel().id } },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    await host.setThinkingLevel("conversation-1", "high", caller);
    reasoning.setResponses([fauxAssistantMessage("first")]);
    await host.prompt("conversation-1", "one", undefined, caller);
    const result = await host.resetContext("conversation-1", caller);
    assert.equal(result.reset, true);
    assert.equal((await host.getConversationContext("conversation-1", caller)).thinking_level, "high");

    reasoning.setResponses([fauxAssistantMessage("slow ".repeat(200))]);
    const pending = host.prompt("conversation-1", "two", undefined, caller);
    for (let attempt = 0; attempt < 40 && host.activeRuns("conversation-1").length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(host.activeRuns("conversation-1").length, 1);
    await assert.rejects(host.resetContext("conversation-1", caller), /active Pi prompt/);
    await host.abort("conversation-1");
    // The abort can land during Session initialization; only the reset rejection matters here.
    await pending.catch(() => undefined);
  } finally {
    await host.dispose();
    await fixture.close();
  }
});

test("group resetContext resets only participants with a Session and shares one reset id", async () => {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  const contexts: string[] = [];
  try {
    fixture.store.replaceProjections([
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "coord", display_name: "Coordinator", revoked: false, synced_at: now },
      { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "worker", display_name: "Worker", revoked: false, synced_at: now },
    ], [{ solution_instance_id: "solution-reset", tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: "Reset Group", coordinator_employee_id: "coordinator", expert_employee_ids: ["coordinator", "worker"] }], [
      { employee_id: "coordinator", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "coord-snapshot", display_name: "Coordinator", tool_policy: { allowed_tools: [] } },
      { employee_id: "worker", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "worker-snapshot", display_name: "Worker", tool_policy: { allowed_tools: [] } },
    ]);
    fixture.store.createConversation({ id: "reset-group", kind: "group", tenantId: "tenant-1", memberId: "member-1", coordinatorEmployeeId: "coordinator", solutionRef: "solution-reset", sessionFile: "", workspace: "" });
    const host = fixture.createHost(undefined, undefined, (_id, authorization) => {
      contexts.push(authorization?.groupContext ?? "");
      return createControlledResourceLoader("test system prompt");
    });
    await host.initializeConversationParticipants("reset-group", caller);
    fixture.faux.setResponses([fauxAssistantMessage("旧话题回复")]);
    await host.prompt("reset-group", "旧话题", undefined, caller);

    const result = await host.resetContext("reset-group", caller);
    assert.equal(result.reset, true);
    const reset = result.participants.filter((item) => item.reset).map((item) => item.employee_id);
    assert.deepEqual(reset, ["coordinator"]);
    assert.equal(result.participants.some((item) => item.employee_id === "worker" && item.reset), false);

    const entries = await host.entries("reset-group", caller) as Array<Record<string, any>>;
    const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "aiteam_context_reset");
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.data?.reset_id, result.reset_id);

    contexts.length = 0;
    fixture.faux.setResponses([fauxAssistantMessage("新话题回复")]);
    await host.prompt("reset-group", "新话题", undefined, caller);
    assert.equal(contexts.some((context) => context.includes("旧话题")), false, "group context must not carry pre-reset messages");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});
