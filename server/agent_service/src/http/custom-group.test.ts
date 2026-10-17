import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { join } from "node:path";

const caller = { tenantId: "tenant-1", userId: "member-1", callerId: "member-1", roles: ["member"] };
async function setup() {
  const fixture = await createFixture();
  const experts = ["e1", "e2", "e3"].map(id => ({ employee_id: id, tenant_id: caller.tenantId, member_id: caller.userId, version: "1", display_name: "同名员工", handle: id, revoked: false, synced_at: new Date().toISOString() }));
  fixture.store.replaceProjections(experts, [], experts.map(expert => ({ ...expert, persona: `${expert.employee_id} 的独特简介`, snapshot_version: "1", tool_policy: { allowed_tools: [] } })));
  const contexts: string[] = [];
  const host = fixture.createHost(undefined, undefined, (_id, auth) => {
    contexts.push(auth?.groupContext ?? "");
    return createControlledResourceLoader(`test prompt\n${auth?.groupContext ?? ""}`);
  });
  const http = new AgentHttpServer({ store: fixture.store, host, authenticate: request => ({ ...caller, ...(request.headers.authorization === "other" ? { userId: "other", callerId: "other" } : {}) }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const request = async (path: string, body?: unknown, status = 200, other = false, method = body ? "POST" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: { authorization: other ? "other" : "owner", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  };
  return { ...fixture, host, contexts, request, async cleanup() { await http.close(); await host.dispose(); await fixture.close(); } };
}
const path = "/api/agent/conversations/custom-group";
const input = (id = "custom") => ({ id, title: " 自选群 ", description: "自动模式独有用途", member_employee_ids: ["e1", "e2"], coordinator_employee_id: "e1", orchestration: { mode: "auto" } });

test("custom group persists exact members and configuration across reads, restart and repeated IDs", async () => {
  const f = await setup();
  try {
    const created = (await f.request(path, input(), 201)).data;
    assert.equal(created.title, "自选群");
    assert.deepEqual(created.orchestration, { mode: "auto" });
    const members = (await f.request("/api/agent/conversations/custom/participants")).data;
    assert.deepEqual(members.participants.map((p: any) => p.employee_id).sort(), ["e1", "e2"]);
    assert.equal(members.employee_count, 2);
    assert.deepEqual((await f.request("/api/agent/conversations/custom")).data.orchestration, created.orchestration);
    assert((await f.request("/api/agent/conversations")).data.some((c: any) => c.id === "custom" && c.description === created.description));
    await f.request(path, input(), 409);
    await f.request(path, input(), 404, true);
    await f.request("/api/agent/conversations/custom", undefined, 404, true);
    const coldStore = new AgentSqliteStore(join(f.dataRoot, "agent.sqlite"));
    try {
      assert.equal(coldStore.getConversationMetadata("custom")?.description, created.description);
      assert.deepEqual(coldStore.getConversationMetadata("custom")?.orchestration, created.orchestration);
    } finally { coldStore.close(); }
    const coldHost = f.createHost();
    try { await coldHost.initializeConversationParticipants("custom", caller); }
    finally { await coldHost.dispose(); }
    assert.equal(f.store.listConversationParticipants("custom").length, 2);
    const schema = (await f.request("/openapi.json"));
    assert(schema.paths[path].post);
    assert.equal(schema.components.schemas.CustomGroupCreateRequest.additionalProperties, false);
  } finally { await f.cleanup(); }
});

test("custom create rejects invalid, unauthorized and legacy mixed input without creating rows", async () => {
  const f = await setup();
  try {
    for (const patch of [
      { title: " " }, { description: " " }, { member_employee_ids: [] }, { member_employee_ids: ["e1", "e1"] },
      { coordinator_employee_id: "e3" }, { solution_instance_id: "solution" }, { kind: "chat" },
      { orchestration: { mode: "auto", prompt: "hidden" } },
      { orchestration: { mode: "custom", format: "wrong", prompt: "text" } },
      { orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "@{e3}" } },
      { orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "@{e1" } },
    ]) { await f.request(path, { ...input(), ...patch }, 422); assert.equal(f.store.getConversation("custom"), undefined); }
    await f.request(path, { ...input(), member_employee_ids: ["e1", "unknown"] }, 403);
    await f.request(path, { ...input(), title: "a".repeat(201) }, 422);
    await f.request(path, { ...input(), description: "a".repeat(4001) }, 422);
    await f.request(path, { ...input(), orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "a".repeat(16001) } }, 422);
    for (const [id, patch] of [["permission", { permission_mode: "workspace-write" }], ["immutable", {}]] as const) {
      const result = await f.request(path, { ...input(id), ...patch }, 201);
      assert.equal(result.data.permission_mode, id === "permission" ? "workspace-write" : "read-only");
    }
    await f.request("/api/agent/conversations/immutable", { kind: "chat" }, 422, false, "PATCH");
    for (const field of ["coordinator_employee_id", "entry_employee_id", "solution_instance_id"]) {
      await f.request("/api/agent/conversations/immutable", { [field]: "e2" }, 422, false, "PATCH");
    }
    assert.equal(f.store.getConversationMetadata("immutable")?.coordinator_employee_id, "e1");
    await f.request("/api/agent/conversations", input(), 422);
    await f.request("/api/agent/conversations", { id: "legacy", kind: "group", coordinator_employee_id: "e1" }, 201);
    assert.equal(f.store.listConversationParticipants("legacy").length, 3);
    assert.equal(f.store.getConversationMetadata("legacy")?.orchestration, null);
  } finally { await f.cleanup(); }
});

test("auto and custom prompts use complete mode-specific rules and only selected employee profiles", async () => {
  const f = await setup();
  try {
    await f.request(path, input("auto"), 201);
    f.faux.setResponses([fauxAssistantMessage("done")]);
    await f.host.prompt("auto", "本次任务", undefined, caller);
    assert(f.contexts.some(context => context.includes("自动模式独有用途") && context.includes("e2 的独特简介")));
    assert(f.contexts.every(context => !context.includes("e3 的独特简介")));
    f.contexts.length = 0;
    const rule = "1. @{e1} → @{e2}：" + "完整规则".repeat(2200) + "规则末尾必须保留";
    await f.request(path, { ...input(), orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: rule } }, 201);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mention_employee", { employee_id: "e2", message: "执行协作任务" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("成员实际结果"), fauxAssistantMessage("汇总实际结果"),
    ]);
    await f.host.prompt("custom", "本次任务", undefined, caller);
    assert(f.contexts.some(context => context.includes(rule)));
    assert(f.contexts.every(context => !context.includes("自动模式独有用途")));
    assert(f.host.readEntries("custom", caller).some(({ entry }) => JSON.stringify(entry).includes("成员实际结果")));
    await assert.rejects(f.host.prompt("custom", "调用外部成员", undefined, caller, ["e3"]));
    f.store.deleteConversationParticipants("custom");
    await assert.rejects(f.host.initializeConversationParticipants("custom", caller));
    await assert.rejects(f.host.prompt("custom", "继续", undefined, caller));
    assert.equal(f.store.listConversationParticipants("custom").length, 0);
  } finally { await f.cleanup(); }
});

test("initialization failure removes the new custom conversation and its participant rows", async () => {
  const f = await setup();
  try {
    const initialize = f.host.initializeConversationParticipants.bind(f.host);
    f.host.initializeConversationParticipants = async (id, owner) => { await initialize(id, owner); throw new Error("simulated initialization failure"); };
    await f.request(path, input(), 500);
    assert.equal(f.store.getConversation("custom"), undefined);
    assert.equal(f.store.listConversationParticipants("custom").length, 0);
  } finally { await f.cleanup(); }
});


test("group edits validate the merged configuration atomically and preserve fixed members", async () => {
  const f = await setup();
  try {
    await f.request(path, input("editable"), 201);
    const endpoint = "/api/agent/conversations/editable";
    const before = f.store.getConversationMetadata("editable");
    for (const description of [null, "", "   "]) {
      await f.request(endpoint, { title: "must not persist", description }, 422, false, "PATCH");
      assert.deepEqual(f.store.getConversationMetadata("editable"), before);
    }
    const auto = (await f.request(endpoint, { description: "新群用途" }, 200, false, "PATCH")).data;
    assert.equal(auto.description, "新群用途");
    assert.deepEqual(auto.orchestration, { mode: "auto" });
    const custom = { mode: "custom", format: "collaboration-markdown-v1", prompt: "@{e1} → @{e2}：检查结果" };
    const edited = (await f.request(endpoint, { description: null, orchestration: custom }, 200, false, "PUT")).data;
    assert.equal(edited.description, null);
    assert.deepEqual(edited.orchestration, custom);
    const saved = f.store.getConversationMetadata("editable");
    for (const patch of [
      { orchestration: null }, { orchestration: { mode: "auto" } },
      { orchestration: { ...custom, prompt: "@{e3}" } },
      { orchestration: { ...custom, prompt: "@{e1" } },
      { orchestration: { ...custom, prompt: " " } },
      { orchestration: { ...custom, format: "unknown" } },
      { member_employee_ids: ["e1"] }, { coordinator_employee_id: "e2" },
      { entry_employee_id: "e2" }, { solution_instance_id: "other" }, { kind: "chat" },
    ]) {
      await f.request(endpoint, patch, 422, false, "PATCH");
      assert.deepEqual(f.store.getConversationMetadata("editable"), saved);
    }
    await f.request(endpoint, { description: "other user" }, 404, true, "PATCH");
    const restored = (await f.request(endpoint, { description: "恢复自动用途", orchestration: { mode: "auto" } }, 200, false, "PATCH")).data;
    assert.equal(restored.coordinator_employee_id, "e1");
    assert.equal(restored.solution_instance_id, null);
    assert.deepEqual(f.store.listConversationParticipants("editable").map(member => member.employee_id), ["e1", "e2"]);
    const coldStore = new AgentSqliteStore(join(f.dataRoot, "agent.sqlite"));
    try {
      assert.equal(coldStore.getConversationMetadata("editable")?.description, "恢复自动用途");
      assert.deepEqual(coldStore.getConversationMetadata("editable")?.orchestration, { mode: "auto" });
    } finally { coldStore.close(); }
  } finally { await f.cleanup(); }
});

test("group edits cannot convert private or legacy groups into custom groups", async () => {
  const f = await setup();
  try {
    await f.request("/api/agent/conversations", { id: "private", entry_employee_id: "e1" }, 201);
    await f.request("/api/agent/conversations", { id: "legacy", kind: "group", coordinator_employee_id: "e1" }, 201);
    for (const id of ["private", "legacy"]) {
      const before = f.store.getConversationMetadata(id);
      for (const patch of [{ description: "purpose" }, { orchestration: { mode: "auto" }, description: "purpose" }]) {
        await f.request(`/api/agent/conversations/${id}`, patch, 422, false, "PATCH");
        assert.deepEqual(f.store.getConversationMetadata(id), before);
      }
    }
  } finally { await f.cleanup(); }
});

test("edited group purpose and custom rules take effect on the next prompt", async () => {
  const f = await setup();
  try {
    await f.request(path, input("editable"), 201);
    f.faux.setResponses([fauxAssistantMessage("before")]);
    await f.host.prompt("editable", "before", undefined, caller);
    for (const patch of [
      { description: "编辑后的用途" },
      { description: null, orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "新规则：@{e2} 核对结果" } },
    ]) {
      f.contexts.length = 0;
      await f.request("/api/agent/conversations/editable", patch, 200, false, "PATCH");
      f.faux.setResponses([fauxAssistantMessage("after")]);
      await f.host.prompt("editable", "after", undefined, caller);
      assert(f.contexts.some(context => context.includes(patch.orchestration?.prompt ?? patch.description!)));
      assert(f.contexts.every(context => !context.includes("自动模式独有用途")));
    }
  } finally { await f.cleanup(); }
});

const members = async (f: Awaited<ReturnType<typeof setup>>, id: string) =>
  (await f.request(`/api/agent/conversations/${id}/participants`)).data.participants.map((member: { employee_id: string }) => member.employee_id);

test("members can be added and removed between turns, keeping history and the original Session", async () => {
  const f = await setup();
  try {
    await f.request(path, input("roster"), 201);
    const endpoint = "/api/agent/conversations/roster/participants";
    const added = (await f.request(endpoint, { add_employee_ids: ["e3"] }, 200, false, "PATCH")).data;
    assert.deepEqual(added.participants.map((member: { employee_id: string }) => member.employee_id), ["e1", "e2", "e3"]);
    assert.equal(added.employee_count, 3);
    assert.equal(added.conversation.id, "roster");
    assert.deepEqual(await members(f, "roster"), ["e1", "e2", "e3"]);

    // The new member joins the next turn's context and can be called directly.
    f.contexts.length = 0;
    f.faux.setResponses([fauxAssistantMessage("e3 的发言")]);
    await f.host.prompt("roster", "请 e3 处理", undefined, caller, ["e3"]);
    assert(f.contexts.some(context => context.includes("e3 的独特简介")));
    const sessionFile = f.store.getConversationParticipant("roster", "e3")!.session_file;
    assert(sessionFile);

    const removed = (await f.request(endpoint, { remove_employee_ids: ["e3"] }, 200, false, "PATCH")).data;
    assert.deepEqual(removed.participants.map((member: { employee_id: string }) => member.employee_id), ["e1", "e2"]);
    assert.equal(removed.employee_count, 2);
    // Earlier replies stay readable, but the member no longer takes part.
    assert(f.host.readEntries("roster", caller).some(({ entry }) => JSON.stringify(entry).includes("e3 的发言")));
    await assert.rejects(f.host.prompt("roster", "再叫 e3", undefined, caller, ["e3"]));
    f.contexts.length = 0;
    f.faux.setResponses([fauxAssistantMessage("协调人回复")]);
    await f.host.prompt("roster", "继续", undefined, caller);
    assert(f.contexts.every(context => !context.includes("e3 的独特简介")));

    // Re-adding resumes the same Session instead of starting a new one.
    await f.request(endpoint, { add_employee_ids: ["e3"] }, 200, false, "PATCH");
    const resumed = f.store.getConversationParticipant("roster", "e3")!;
    assert.equal(resumed.session_file, sessionFile);
    assert.equal(resumed.removed_at, null);
    assert.equal(resumed.role, "member");

    const coldStore = new AgentSqliteStore(join(f.dataRoot, "agent.sqlite"));
    try {
      assert.deepEqual(coldStore.listConversationParticipants("roster").map(member => member.employee_id), ["e1", "e2", "e3"]);
    } finally { coldStore.close(); }

    await f.host.delete("roster", caller.tenantId, caller.userId);
    assert.equal(f.store.listConversationParticipants("roster", { includeRemoved: true }).length, 0);
  } finally { await f.cleanup(); }
});

test("member edits reject invalid changes without touching the group", async () => {
  const f = await setup();
  try {
    await f.request(path, input("guarded"), 201);
    const endpoint = "/api/agent/conversations/guarded/participants";
    const before = f.store.getConversationMetadata("guarded");
    for (const [patch, status] of [
      [{}, 422], [{ add_employee_ids: [] }, 422],
      [{ add_employee_ids: ["e2"] }, 422],
      [{ remove_employee_ids: ["e3"] }, 422],
      [{ remove_employee_ids: ["e1"] }, 422],
      [{ add_employee_ids: ["e3"], remove_employee_ids: ["e3"] }, 422],
      [{ add_employee_ids: ["e3", "e3"] }, 422],
      [{ add_employee_ids: ["unknown"] }, 403],
      [{ add_employee_ids: ["e3"], coordinator_employee_id: "e3" }, 422],
      [{ add_employee_ids: ["e3"], orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "@{e9}" } }, 422],
      [{ add_employee_ids: ["e3"], orchestration: { mode: "auto" }, description: null }, 422],
    ] as const) {
      await f.request(endpoint, patch, status, false, "PATCH");
      assert.deepEqual(f.store.getConversationMetadata("guarded"), before);
      assert.deepEqual(await members(f, "guarded"), ["e1", "e2"]);
    }
    await f.request(endpoint, { add_employee_ids: ["e3"] }, 404, true, "PATCH");
    await f.request("/api/agent/conversations/missing/participants", { add_employee_ids: ["e3"] }, 404, false, "PATCH");

    // Private chats and groups without a custom configuration are not editable.
    await f.request("/api/agent/conversations", { id: "private", entry_employee_id: "e1" }, 201);
    await f.request("/api/agent/conversations", { id: "legacy", kind: "group", coordinator_employee_id: "e1" }, 201);
    for (const id of ["private", "legacy"]) await f.request(`/api/agent/conversations/${id}/participants`, { add_employee_ids: ["e3"] }, 422, false, "PATCH");
  } finally { await f.cleanup(); }
});

test("member edits keep a custom rule consistent with the roster", async () => {
  const f = await setup();
  try {
    const rule = (prompt: string) => ({ mode: "custom", format: "collaboration-markdown-v1", prompt });
    await f.request(path, { ...input("ruled"), orchestration: rule("@{e1} → @{e2}：核对结果") }, 201);
    const endpoint = "/api/agent/conversations/ruled/participants";
    const before = f.store.getConversationMetadata("ruled");
    // The rule still points at e2, so removing e2 alone must fail and change nothing.
    const rejected = await f.request(endpoint, { remove_employee_ids: ["e2"] }, 422, false, "PATCH");
    assert.equal(rejected.code, "invalid_orchestration_reference");
    assert.deepEqual(f.store.getConversationMetadata("ruled"), before);
    assert.deepEqual(await members(f, "ruled"), ["e1", "e2"]);

    // Removing e2 together with a rewritten rule succeeds in one step.
    const rewritten = rule("@{e1} → @{e3}：整理结论");
    const removed = (await f.request(endpoint, { add_employee_ids: ["e3"], remove_employee_ids: ["e2"], orchestration: rewritten }, 200, false, "PATCH")).data;
    assert.deepEqual(removed.participants.map((member: { employee_id: string }) => member.employee_id), ["e1", "e3"]);
    assert.deepEqual(removed.conversation.orchestration, rewritten);
    f.contexts.length = 0;
    f.faux.setResponses([fauxAssistantMessage("done")]);
    await f.host.prompt("ruled", "开始", undefined, caller);
    assert(f.contexts.some(context => context.includes("整理结论") && context.includes("e3 的独特简介")));
    assert(f.contexts.every(context => !context.includes("e2 的独特简介")));
  } finally { await f.cleanup(); }
});

test("members cannot change while the group is running", async () => {
  const f = await setup();
  try {
    await f.request(path, input("busy"), 201);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.faux.setResponses([async () => { await gate; return fauxAssistantMessage("late"); }]);
    const running = f.host.prompt("busy", "长任务", undefined, caller);
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = f.store.getConversationMetadata("busy");
    const refused = await f.request("/api/agent/conversations/busy/participants", { add_employee_ids: ["e3"] }, 409, false, "PATCH");
    assert.equal(refused.code, "conversation_busy");
    assert.deepEqual(f.store.getConversationMetadata("busy"), before);
    assert.deepEqual(await members(f, "busy"), ["e1", "e2"]);
    release();
    await running;
    await f.request("/api/agent/conversations/busy/participants", { add_employee_ids: ["e3"] }, 200, false, "PATCH");
  } finally { await f.cleanup(); }
});

test("orchestration endpoint replaces and switches the rule with the same validation as PATCH", async () => {
  const f = await setup();
  try {
    await f.request(path, input("switch"), 201);
    const endpoint = "/api/agent/conversations/switch/orchestration";
    const custom = { mode: "custom", format: "collaboration-markdown-v1", prompt: "  @{e1} → @{e2}：检查结果  " };
    const toCustom = (await f.request(endpoint, { orchestration: custom, description: null }, 200, false, "PUT")).data;
    assert.deepEqual(toCustom.orchestration, { ...custom, prompt: "@{e1} → @{e2}：检查结果" });
    assert.equal(toCustom.description, null);
    // Back to automatic needs a purpose, either already stored or sent along.
    const saved = f.store.getConversationMetadata("switch");
    for (const body of [
      { orchestration: { mode: "auto" } },
      { orchestration: { mode: "auto" }, description: "   " },
      { orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "@{e3}" } },
      { orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: " " } },
      { orchestration: { mode: "custom", format: "unknown", prompt: "x" } },
      { orchestration: null }, {}, { orchestration: { mode: "auto" }, description: "用途", title: "x" },
    ]) {
      await f.request(endpoint, body, 422, false, "PUT");
      assert.deepEqual(f.store.getConversationMetadata("switch"), saved);
    }
    const toAuto = (await f.request(endpoint, { orchestration: { mode: "auto" }, description: " 恢复自动用途 " }, 200, false, "PUT")).data;
    assert.deepEqual(toAuto.orchestration, { mode: "auto" });
    assert.equal(toAuto.description, "恢复自动用途");
    f.contexts.length = 0;
    f.faux.setResponses([fauxAssistantMessage("after")]);
    await f.host.prompt("switch", "after", undefined, caller);
    assert(f.contexts.some(context => context.includes("恢复自动用途")));
    await f.request(endpoint, { orchestration: { mode: "auto" } }, 404, true, "PUT");
    await f.request("/api/agent/conversations", { id: "private", entry_employee_id: "e1" }, 201);
    await f.request("/api/agent/conversations/private/orchestration", { orchestration: { mode: "auto" }, description: "用途" }, 422, false, "PUT");
    assert((await f.request("/openapi.json")).paths["/api/agent/conversations/{conversation_id}/participants"].patch);
  } finally { await f.cleanup(); }
});
