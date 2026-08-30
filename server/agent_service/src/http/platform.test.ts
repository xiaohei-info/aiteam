import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { HttpManagerClient, ManagerUnavailableError, type ManagerClient } from "../manager-client.js";
import { aggregateUsage } from "../usage.js";
import { validateSchedule } from "../schedule.js";

async function start(managerClient?: ManagerClient) {
  const fixture = await createFixture();
  fixture.store.replaceProjections([
    { employee_id: "e1", tenant_id: "t1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test", provider_ref: "test" } },
  ], [{ solution_instance_id: "s1", display_name: "Solution", version: "1" }], [{ employee_id: "e1", tenant_id: "t1", version: "1", snapshot_version: "s1", display_name: "Helper" }]);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, managerClient, authenticate: () => ({ callerId: "m1", userId: "m1", tenantId: "t1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  return { fixture, http, base: `http://127.0.0.1:${address.port}` };
}

const auth = { Authorization: "Bearer test", "Content-Type": "application/json" };

test("Agent platform metadata, local projections, readiness, office, identity and removal boundaries", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [], snapshots: [], revoked_ids: [] }),
    getOrgTree: async () => ({ id: "root", type: "department", name: "Tenant", children: [
      { id: "e1", type: "employee", name: "Helper", parent_id: "root", children: [] },
      { id: "secret", type: "employee", name: "Hidden", parent_id: "root", children: [] },
    ] }),
  };
  const { fixture, http, base } = await start(remote);
  try {
    const created = await fetch(`${base}/api/agent/conversations`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Local", labels: ["one"], entry_employee_id: "e1" }) });
    assert.equal(created.status, 201);
    const conversation = (await created.json() as { data: { id: string; state: string } }).data;
    assert.equal(conversation.state, "active");
    const listed = await fetch(`${base}/api/agent/conversations`, { headers: auth });
    assert.equal((await listed.json() as { data: unknown[] }).data.length, 1);
    const runtimeState = await fetch(`${base}/api/agent/conversations/${conversation.id}/state`, { headers: auth });
    assert.deepEqual((await runtimeState.json() as { data: { state: string; prompting: boolean } }).data, { conversation_id: conversation.id, state: "active", prompting: false });
    const updated = await fetch(`${base}/api/agent/conversations/${conversation.id}/state`, { method: "PUT", headers: auth, body: JSON.stringify({ state: "paused" }) });
    assert.equal((await updated.json() as { data: { state: string } }).data.state, "paused");
    fixture.faux.setResponses([]);
    const prompt = await fetch(`${base}/api/agent/conversations/${conversation.id}/prompt`, { method: "POST", headers: { ...auth, "Idempotency-Key": "platform-prompt" }, body: JSON.stringify({ text: "hello" }) });
    assert.equal(prompt.status, 202);

    for (const path of ["grants/experts", "grants/solutions", "grants/snapshots", "grants/readiness", "usage/outbox", "office/scene", "office/feed"]) {
      const response = await fetch(`${base}/api/agent/${path}`, { headers: auth });
      assert.equal(response.status, 200, path);
    }
    assert.equal((await (await fetch(`${base}/api/agent/grants/experts`, { headers: auth })).json() as { data: unknown[] }).data.length, 1);
    const org = (await (await fetch(`${base}/api/agent/org/tree`, { headers: auth })).json() as { data: { name: string; children: Array<{ id: string }> } }).data;
    assert.equal(org.name, "Tenant");
    assert.deepEqual(org.children.map((child) => child.id), ["e1"]);
    assert.equal((await (await fetch(`${base}/api/agent/whoami`, { headers: auth })).json() as { data: { user_id: string } }).data.user_id, "m1");
    assert.deepEqual((await (await fetch(`${base}/api/agent/ping`, { headers: auth })).json() as { data: { pong: boolean } }).data, { pong: true });
    assert.equal((await fetch(`${base}/api/agent/conversations/c1/group-dispatch`, { method: "POST", headers: auth, body: "{}" })).status, 410);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync stores only Manager-authorized projections", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [{ employee_id: "remote", tenant_id: "t1", version: "2", handle: "remote", display_name: "Remote", revoked: false, synced_at: new Date().toISOString() }], solutions: [], snapshots: [], revoked_ids: ["e1"] }),
    getOrgTree: async () => ({}),
  };
  const { fixture, http, base } = await start(remote);
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.store.listLoadedExperts().map((expert) => expert.employee_id), ["remote"]);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync validates Manager config before changing local projections", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [{ version: "2" } as never], solutions: [], snapshots: [], revoked_ids: [] }),
    getOrgTree: async () => ({}),
  };
  const { fixture, http, base } = await start(remote);
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 503);
    assert.deepEqual(fixture.store.listLoadedExperts().map((expert) => expert.employee_id), ["e1"]);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync never requests Manager enterprise document content", async () => {
  const requests: string[] = [];
  const remote = new HttpManagerClient("https://manager.test/base/", async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: { experts: [], solutions: [], snapshots: [], revoked_ids: [] } }), { status: 200 });
  });
  const { fixture, http, base } = await start(remote);
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(requests, ["https://manager.test/api/manager/grants/authorized-config"]);
    assert.equal(requests.some((url) => url.includes("/knowledge/")), false);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync fails closed when Manager is not configured", async () => {
  const { fixture, http, base } = await start();
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    const problem = await response.json() as { code: string; status: number };
    assert.equal(problem.code, "manager_unavailable");
    assert.equal(problem.status, 503);
    assert.equal(fixture.store.listLoadedExperts().length, 1);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent projections use real Manager catalog, schedules, and usage payloads", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    listMarketplaceTemplates: async () => [{ template_id: "template-1", display_name: "Researcher", category: "research", model_name: "model-1", skills_count: 2, recruit_count: 1, is_recruited: false, tags: ["analysis"], avatar_url: null }],
  };
  const { fixture, http, base } = await start(remote);
  try {
    const scheduled = await fetch(`${base}/api/agent/conversations`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ title: "Scheduled research", entry_employee_id: "e1", schedule: validateSchedule({ schedule_id: "schedule-1", at: "2026-01-01T00:00:00Z", one_shot: true, prompt_template: "research" }) }),
    });
    assert.equal(scheduled.status, 201);
    fixture.store.upsertUsageSummary(aggregateUsage({ tenantId: "t1", memberId: "m1", employeeId: "e1", startedAt: Date.now(), endedAt: Date.now(), settled: true, entries: [] }));
    const catalog = await fetch(`${base}/api/agent/marketplace/templates`, { headers: auth });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json() as { data: Array<{ template_id: string }> }).data[0].template_id, "template-1");
    const detail = await fetch(`${base}/api/agent/marketplace/templates/template-1`, { headers: auth });
    assert.equal(detail.status, 200);
    const feed = await fetch(`${base}/api/agent/office/feed`, { headers: auth });
    assert.equal((await feed.json() as { data: { events: unknown[] } }).data.events.length, 1);
    const outbox = await fetch(`${base}/api/agent/usage/outbox`, { headers: auth });
    const item = (await outbox.json() as { data: Array<{ payload?: { summary_id: string; prompt_count: number }; status: string }> }).data[0];
    assert.equal(item.status, "pending");
    assert.equal(item.payload?.summary_id.length, 64);
    assert.equal(item.payload?.prompt_count, 1);
    assert.equal("prompt" in (item.payload ?? {}), false);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Agent marketplace reports Manager catalog outage instead of an empty success", async () => {
  const { fixture, http, base } = await start();
  try {
    const response = await fetch(`${base}/api/agent/marketplace/templates`, { headers: auth });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    assert.equal((await response.json() as { code: string }).code, "manager_unavailable");
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync maps a Manager transport outage to the formal 503 problem contract", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => { throw new ManagerUnavailableError("offline"); },
    getOrgTree: async () => ({}),
  };
  const { fixture, http, base } = await start(remote);
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    const problem = await response.json() as { code: string; status: number };
    assert.equal(problem.code, "manager_unavailable");
    assert.equal(problem.status, 503);
    assert.equal(fixture.store.listLoadedExperts().map((expert) => expert.employee_id).join(","), "e1");
  } finally {
    await http.close();
    await fixture.close();
  }
});
