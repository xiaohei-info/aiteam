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
    await f.request("/api/agent/conversations/immutable", { orchestration: { mode: "auto" } }, 422, false, "PATCH");
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
