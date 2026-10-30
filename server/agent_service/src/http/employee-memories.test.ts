import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { HttpManagerClient, ManagerAuthorizationError, ManagerUnavailableError, type ManagerClient, type MemoryListQuery } from "../manager-client.js";
import { decodeMemoryCursor, encodeMemoryCursor } from "./employee-memories.js";

async function start(managerClient?: ManagerClient) {
  const fixture = await createFixture();
  fixture.store.replaceProjections([
    { employee_id: "e1", tenant_id: "t1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test", provider_ref: "test" } },
  ], [], [{ employee_id: "e1", tenant_id: "t1", version: "1", snapshot_version: "s1", display_name: "Helper" }]);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, managerClient, authenticate: () => ({ callerId: "m1", userId: "m1", tenantId: "t1", roles: ["member"], accessToken: "member-token" }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  return { fixture, http, base: `http://127.0.0.1:${address.port}` };
}

const auth = { Authorization: "Bearer test" };
const item = (id: string) => ({
  memory_id: id, employee_id: "e1", content: `content ${id}`, category: "world", importance: 0.5, source: "context_reset",
  created_at: "2026-10-30T02:00:00Z", last_used_at: null, state: "valid", contributor_member_id: "m1", contributor_display_name: "Me", is_mine: true,
});
const baseClient: ManagerClient = {
  pullAuthorizedConfig: async () => ({ experts: [], solutions: [], snapshots: [], revoked_ids: [] }),
  getOrgTree: async () => ({}),
};

test("Employee memory list forwards scope, keyword and paging to Manager with the member caller", async () => {
  const calls: Array<{ token?: string; employeeId: string; query: MemoryListQuery }> = [];
  const remote: ManagerClient = {
    ...baseClient,
    memoryList: async (caller, employeeId, query) => {
      calls.push({ token: caller.accessToken, employeeId, query });
      return { items: [item("mem-1"), item("mem-2")], total: 3, scope: "mine", truncated: false };
    },
  };
  const { fixture, http, base } = await start(remote);
  try {
    const first = await fetch(`${base}/api/agent/employees/e1/memories?scope=all&keyword=%E5%91%A8%E6%8A%A5&limit=2`, { headers: auth });
    assert.equal(first.status, 200);
    const body = await first.json() as { data: Array<{ memory_id: string; is_mine: boolean }>; page: { next_cursor: string | null; has_more: boolean }; meta: { scope: string; total: number } };
    assert.deepEqual(body.data.map((row) => row.memory_id), ["mem-1", "mem-2"]);
    assert.equal(body.meta.scope, "mine");
    assert.equal(body.meta.total, 3);
    assert.equal(body.page.has_more, true);
    assert.deepEqual(calls[0], { token: "member-token", employeeId: "e1", query: { scope: "all", keyword: "周报", limit: 2, offset: 0 } });

    const second = await fetch(`${base}/api/agent/employees/e1/memories?limit=2&cursor=${encodeURIComponent(body.page.next_cursor!)}`, { headers: auth });
    assert.equal(second.status, 200);
    assert.equal(calls[1].query.offset, 2);
    assert.equal((await second.json() as { page: { has_more: boolean } }).page.has_more, false);

    assert.equal((await fetch(`${base}/api/agent/employees/e1/memories?scope=team`, { headers: auth })).status, 422);
    assert.equal((await fetch(`${base}/api/agent/employees/e1/memories?cursor=bogus`, { headers: auth })).status, 422);
    assert.equal(calls.length, 2);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Employee memory routes require a locally authorized employee before calling Manager", async () => {
  let called = 0;
  const remote: ManagerClient = {
    ...baseClient,
    memoryList: async () => { called += 1; return { items: [], total: 0, scope: "mine", truncated: false }; },
    memorySummary: async () => { called += 1; throw new Error("unreachable"); },
    memoryDelete: async () => { called += 1; },
  };
  const { fixture, http, base } = await start(remote);
  try {
    for (const [method, path] of [["GET", "memories"], ["GET", "memories/summary"], ["DELETE", "memories/mem-1"]]) {
      const response = await fetch(`${base}/api/agent/employees/unknown/${path}`, { method, headers: auth });
      assert.equal(response.status, 403, path);
      assert.equal((await response.json() as { code: string }).code, "employee_not_authorized");
    }
    assert.equal(called, 0);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Employee memory summary and delete forward to Manager and map its denials", async () => {
  const deleted: string[] = [];
  const remote: ManagerClient = {
    ...baseClient,
    memorySummary: async (_caller, employeeId, scope) => ({ employee_id: employeeId, scope: scope ?? "mine", total_count: 2, own_count: 2, others_count: 32, unattributed_count: 5, recent_count: 1, latest_used_at: null, truncated: false }),
    memoryDelete: async (_caller, _employeeId, memoryId) => {
      if (memoryId === "other") throw new ManagerAuthorizationError(403, "memory_not_contributor");
      if (memoryId === "disabled") throw new ManagerAuthorizationError(403, "forbidden");
      if (memoryId === "down") throw new ManagerUnavailableError("Manager returned HTTP 503", { status: 503, problemCode: "hindsight_unavailable" });
      deleted.push(memoryId);
    },
  };
  const { fixture, http, base } = await start(remote);
  try {
    const summary = await fetch(`${base}/api/agent/employees/e1/memories/summary`, { headers: auth });
    assert.equal(summary.status, 200);
    assert.equal((await summary.json() as { data: { others_count: number } }).data.others_count, 32);

    const removed = await fetch(`${base}/api/agent/employees/e1/memories/mine`, { method: "DELETE", headers: auth });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json() as { data: unknown }).data, { deleted: true, employee_id: "e1", memory_id: "mine" });
    assert.deepEqual(deleted, ["mine"]);

    for (const [memoryId, status, code] of [["other", 403, "memory_not_contributor"], ["disabled", 403, "memory_forbidden"], ["down", 503, "memory_unavailable"]] as const) {
      const response = await fetch(`${base}/api/agent/employees/e1/memories/${memoryId}`, { method: "DELETE", headers: auth });
      assert.equal(response.status, status, memoryId);
      assert.equal((await response.json() as { code: string }).code, code, memoryId);
    }
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Employee memory routes report Manager unavailable when the client lacks memory support", async () => {
  const { fixture, http, base } = await start(baseClient);
  try {
    const response = await fetch(`${base}/api/agent/employees/e1/memories`, { headers: auth });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "manager_unavailable");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("HttpManagerClient memory calls send the member token, parse meta and keep the 403 problem code", async () => {
  const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("Authorization") });
    if (url.includes("/summary")) return Response.json({ data: { employee_id: "e1", scope: "mine", total_count: 1, own_count: 1, others_count: 0, unattributed_count: 0, recent_count: 0, latest_used_at: null, truncated: false } });
    if (init?.method === "DELETE") return new Response(JSON.stringify({ code: "memory_not_contributor", detail: "no" }), { status: 403, headers: { "Content-Type": "application/problem+json" } });
    return Response.json({ data: [item("mem-1")], page: { next_cursor: null, has_more: false }, meta: { total: 1, limit: 10, offset: 0, scope: "mine", truncated: true } });
  }) as typeof fetch;
  const client = new HttpManagerClient("http://manager.test", fetchImpl);
  const caller = { callerId: "m1", userId: "m1", tenantId: "t1", accessToken: "member-token" };

  const page = await client.memoryList(caller, "e1", { scope: "mine", keyword: "q", limit: 10, offset: 0 });
  assert.deepEqual({ total: page.total, scope: page.scope, truncated: page.truncated, count: page.items.length }, { total: 1, scope: "mine", truncated: true, count: 1 });
  const listUrl = new URL(seen[0].url);
  assert.equal(listUrl.pathname, "/api/manager/memories");
  assert.deepEqual(Object.fromEntries(listUrl.searchParams), { employee_id: "e1", limit: "10", offset: "0", scope: "mine", keyword: "q" });
  assert.equal(seen[0].authorization, "Bearer member-token");

  assert.equal((await client.memorySummary(caller, "e1")).own_count, 1);
  await assert.rejects(client.memoryDelete(caller, "e1", "other"), (error: unknown) => error instanceof ManagerAuthorizationError && error.status === 403 && error.problemCode === "memory_not_contributor");
});

test("Employee memory cursor round-trips and rejects forged values", () => {
  assert.equal(decodeMemoryCursor(null), 0);
  assert.equal(decodeMemoryCursor(encodeMemoryCursor(150)), 150);
  for (const cursor of ["memory_v1.", "page_v1.opaque", encodeMemoryCursor(0), encodeMemoryCursor(100_001)]) {
    assert.throws(() => decodeMemoryCursor(cursor));
  }
});
