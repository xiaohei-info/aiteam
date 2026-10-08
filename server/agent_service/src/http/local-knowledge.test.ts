import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { LocalKnowledgeService } from "../services/local-knowledge.js";
import { AgentHttpServer } from "./server.js";
const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
const other = { ...caller, userId: "member-2" };
const upload = (content = "采购审批需要两位经理签字。 Budget approval policy.", name = "采购.txt") => ({ name, data_base64: Buffer.from(content).toString("base64") });
function seed(store: AgentSqliteStore, revoked = false, deny = false) {
  const expert = { employee_id: "worker", tenant_id: caller.tenantId, member_id: caller.userId, version: "1", display_name: "员工", handle: "worker", revoked, status: "active", synced_at: new Date().toISOString() };
  store.replaceProjections([expert], [], [{ ...expert, snapshot_version: "1", tool_policy: { allowed_tools: [] }, ...(deny ? { knowledge_policy: { state: "deny", allowed_operations: [] } } : {}) }], revoked ? ['worker'] : []);
}
test("local import, FTS search and citations are persistent, scoped, idempotent and revocable", async () => {
  const f = await createFixture();
  try {
    seed(f.store);
    const service = new LocalKnowledgeService(f.store);
    const base = service.create(caller, { name: "采购资料" });
    const doc = service.import(caller, base.id, upload());
    assert.equal(service.import(caller, base.id, upload()).id, doc.id);
    for (const query of ["采购审批", "审批", "Budget", '" OR *', "%", "_", "\\"]) {
      const hits = service.search(caller, query, base.id);
      assert.equal(hits.length, ["采购审批", "审批", "Budget"].includes(query) ? 1 : 0);
    }
    assert.deepEqual(service.list(other), []);
    assert.throws(() => service.read(other, doc.id, 0), /不存在/);
    assert.deepEqual(service.search(caller, "采购", undefined, "worker"), []);
    service.bind(caller, base.id, "worker", true);
    assert.equal(service.search(caller, "采购审批", undefined, "worker")[0]?.citation_id, `local:${doc.id}`);
    assert.match(service.read(caller, doc.id, 0, "worker").content, /两位经理/);
    service.bind(caller, base.id, "worker", false);
    assert.throws(() => service.read(caller, doc.id, 0, "worker"), /未授权/);
    service.bind(caller, base.id, "worker", true);
    seed(f.store, false, true);
    assert.throws(() => service.search(caller, "采购", undefined, "worker"), /不可用/);
    seed(f.store, true);
    assert.throws(() => service.read(caller, doc.id, 0, "worker"), /不可用/);
    // Reopen the same owner store, proving no in-memory-only index or binding.
    const reopened = new AgentSqliteStore(join(f.dataRoot, "agent.sqlite"));
    try {
      const next = new LocalKnowledgeService(reopened);
      assert.equal(next.search(caller, "采购审批", base.id).length, 1);
      next.remove(caller, base.id, doc.id);
      assert.deepEqual(next.search(caller, "采购审批", base.id), []);
      assert.throws(() => next.read(caller, doc.id, 0), /不存在/);
      next.remove(caller, base.id);
      assert.deepEqual(next.list(caller), []);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});
test("HTTP contract validates input and separates local paths from the removed enterprise endpoints", async () => {
  const f = await createFixture();
  const http = new AgentHttpServer({ store: f.store, host: f.host, authenticate: request => request.headers.authorization === "Bearer other" ? other : caller });
  await http.listen(0);
  const address = http.server.address(); assert(address && typeof address === "object");
  const request = async (path: string, method = "GET", body?: unknown, expected = 200, token = "owner") => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(res.status, expected, await res.clone().text());
    return res.json();
  };
  try {
    const prefix = "/api/agent/local-knowledge-bases";
    const base = (await request(prefix, "POST", { name: "本机库" })).data;
    await request(`${prefix}/${base.id}/documents`, "POST", upload(), 404, "other");
    await request(`${prefix}/${base.id}/documents`, "POST", upload("text", "../file.txt"), 422);
    await request(`${prefix}/${base.id}/documents`, "POST", upload("fake", "file.pdf"), 415);
    await request(`${prefix}/${base.id}/documents`, "POST", { name: "bad.txt", data_base64: "/w==" }, 422);
    await request(`${prefix}/${base.id}/documents`, "POST", upload("\0"), 422);
    await request(`${prefix}/${base.id}/documents`, "POST", upload("x".repeat(2 * 1024 * 1024 + 1)), 413);
    await request(`${prefix}/${base.id}/documents`, "POST", upload("x".repeat(2 * 1024 * 1024), "limit.txt"));
    const doc = (await request(`${prefix}/${base.id}/documents`, "POST", upload())).data;
    assert.equal(doc.status, "ready");
    const hits = await request(`${prefix}/${base.id}/search?q=${encodeURIComponent("采购审批")}`);
    assert.equal(hits.data[0].document_id, doc.id);
    await request("/api/agent/knowledge-bases", "GET", undefined, 410);
    const spec = await request("/openapi.json");
    assert(spec.paths[prefix]?.post);
    assert(spec.paths[`${prefix}/{base_id}/documents`]?.post);
  } finally { await http.close(); await f.close(); }
});
test("a real Pi Session can call the bound local knowledge tool without Manager RAG", { timeout: 20000 }, async () => {
  const f = await createFixture();
  try {
    seed(f.store);
    const service = new LocalKnowledgeService(f.store);
    const base = service.create(caller, { name: "本机资料" });
    service.import(caller, base.id, upload());
    service.bind(caller, base.id, "worker", true);
    f.store.updateConversation("c1", { entryEmployeeId: "worker" });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("local_knowledge_search", { query: "采购审批" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("需要两位经理签字。"),
    ]);
    await f.host.prompt("c1", "查采购审批", undefined, caller);
    const entries = await f.host.entries("c1", caller);
    assert.match(JSON.stringify(entries), /local_user_files/);
    assert.match(JSON.stringify(entries), /两位经理/);
  } finally { await f.close(); }
});
