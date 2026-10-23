import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { HttpManagerClient, ManagerAuthorizationError, ManagerPolicyDeniedError, ManagerUnavailableError, ManagerValidationError, type ManagerClient } from "../manager-client.js";
import { aggregateUsage } from "../usage.js";
import { validateSchedule } from "../schedule.js";

async function start(managerClient?: ManagerClient, roles: string[] = ["member"]) {
  const fixture = await createFixture();
  fixture.store.replaceProjections([
    { employee_id: "e1", tenant_id: "t1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "test", provider_ref: "test" } },
  ], [{ solution_instance_id: "s1", display_name: "Solution", version: "1" }], [{ employee_id: "e1", tenant_id: "t1", version: "1", snapshot_version: "s1", display_name: "Helper" }]);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, managerClient, authenticate: () => ({ callerId: "m1", userId: "m1", tenantId: "t1", roles }) });
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

test("Org department writes are forwarded to Manager and keep empty departments visible to admins only", async () => {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  let denyWrites = false;
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [], snapshots: [], revoked_ids: [] }),
    getOrgTree: async () => ({ id: "root", type: "department", name: "Tenant", children: [
      { id: "d-empty", type: "department", name: "Empty", parent_id: "root", children: [] },
      { id: "e1", type: "employee", name: "Helper", parent_id: "root", children: [] },
    ] }),
    createDepartment: async (_caller, input) => {
      if (denyWrites) throw new ManagerAuthorizationError(403);
      calls.push({ kind: "create", args: [input] });
      return { id: "d-new", department_slug: input.department_slug, display_name: input.display_name };
    },
    updateDepartment: async (_caller, id, patch) => {
      if (denyWrites) throw new ManagerAuthorizationError(403);
      if (id === "missing") throw new ManagerPolicyDeniedError(404);
      if (patch.parent_id === "cycle") throw new ManagerValidationError("Manager returned HTTP 422 for /x: a department cannot be moved under its own sub-department", "department_invalid_move");
      if (patch.parent_id === "deep") throw new ManagerValidationError("Manager returned HTTP 422 for /x: department hierarchy is limited to 5 levels", "department_depth_exceeded");
      // 文案即使很像也不能当作错误码：只认 Manager 给的 code。
      if (patch.parent_id === "reworded") throw new ManagerValidationError("Manager returned HTTP 422 for /x: hierarchy limited to 5 levels");
      calls.push({ kind: "update", args: [id, patch] });
      return { id, display_name: patch.display_name ?? "旧名", parent_id: patch.parent_id ?? null };
    },
    deleteDepartment: async (_caller, id) => {
      if (denyWrites) throw new ManagerAuthorizationError(403);
      if (id === "missing") throw new ManagerPolicyDeniedError(404);
      calls.push({ kind: "delete", args: [id] });
    },
    promoteDepartment: async (_caller, id, childId) => {
      if (denyWrites) throw new ManagerAuthorizationError(403);
      calls.push({ kind: "promote", args: [id, childId] });
      return { id: childId, display_name: "平台组", parent_id: null };
    },
    assignEmployeeDepartment: async (_caller, employeeId, departmentId) => {
      if (denyWrites) throw new ManagerAuthorizationError(403);
      if (departmentId === "missing") throw new ManagerPolicyDeniedError(404);
      calls.push({ kind: "assign", args: [employeeId, departmentId] });
      return { updated: true };
    },
  };
  const admin = await start(remote, ["enterprise_admin"]);
  try {
    const tree = (await (await fetch(`${admin.base}/api/agent/org/tree`, { headers: auth })).json() as { data: { children: Array<{ id: string }> } }).data;
    assert.deepEqual(tree.children.map((child) => child.id), ["d-empty", "e1"]);

    const created = await fetch(`${admin.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "  研究部  " }) });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json() as { data: unknown }).data, { id: "d-new", name: "研究部", parent_id: null });
    const createCall = calls[0]!.args[0] as { department_slug: string; display_name: string };
    assert.equal(createCall.display_name, "研究部");
    assert.match(createCall.department_slug, /^dept-[0-9a-f]{12}$/);
    assert.equal((await fetch(`${admin.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "   " }) })).status, 422);
    assert.equal((await fetch(`${admin.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x".repeat(65) }) })).status, 422);

    const assigned = await fetch(`${admin.base}/api/agent/org/assignments/e1`, { method: "PATCH", headers: auth, body: JSON.stringify({ department_id: "d-empty" }) });
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json() as { data: unknown }).data, { employee_id: "e1", department_id: "d-empty" });
    assert.deepEqual(calls[1], { kind: "assign", args: ["e1", "d-empty"] });
    assert.equal((await fetch(`${admin.base}/api/agent/org/assignments/e1`, { method: "PATCH", headers: auth, body: JSON.stringify({ department_id: "missing" }) })).status, 404);
    assert.equal((await fetch(`${admin.base}/api/agent/org/assignments/unknown`, { method: "PATCH", headers: auth, body: JSON.stringify({ department_id: "d-empty" }) })).status, 403);
    assert.equal(calls.length, 2);

    const patch = (id: string, body: unknown) => fetch(`${admin.base}/api/agent/org/departments/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    const renamed = await patch("d-1", { name: "  研究中心 " });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await renamed.json() as { data: unknown }).data, { id: "d-1", name: "研究中心", parent_id: null });
    assert.deepEqual(calls[2], { kind: "update", args: ["d-1", { display_name: "研究中心" }] });
    assert.equal((await patch("d-1", { parent_id: "d-2" })).status, 200);
    assert.deepEqual(calls[3], { kind: "update", args: ["d-1", { parent_id: "d-2" }] });
    assert.equal((await patch("d-1", { parent_id: null })).status, 200);
    assert.deepEqual(calls[4], { kind: "update", args: ["d-1", { parent_id: null }] });
    assert.equal((await patch("d-1", {})).status, 422);
    assert.equal((await patch("d-1", { name: "   " })).status, 422);
    assert.equal((await patch("missing", { name: "x" })).status, 404);
    const cycle = await patch("d-1", { parent_id: "cycle" });
    assert.equal(cycle.status, 422);
    assert.equal((await cycle.json() as { code: string }).code, "org_invalid_move");
    const deep = await patch("d-1", { parent_id: "deep" });
    assert.equal(deep.status, 422);
    assert.equal((await deep.json() as { code: string }).code, "org_depth_exceeded");
    const reworded = await patch("d-1", { parent_id: "reworded" });
    assert.equal(reworded.status, 422);
    assert.equal((await reworded.json() as { code: string }).code, "org_invalid_request");

    const removed = await fetch(`${admin.base}/api/agent/org/departments/d-9`, { method: "DELETE", headers: auth });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json() as { data: unknown }).data, { deleted: true, id: "d-9" });
    assert.equal((await fetch(`${admin.base}/api/agent/org/departments/missing`, { method: "DELETE", headers: auth })).status, 404);
    assert.deepEqual(calls.pop(), { kind: "delete", args: ["d-9"] });
    const promoted = await fetch(`${admin.base}/api/agent/org/departments/d-1/promote`, { method: "POST", headers: auth, body: JSON.stringify({ child_id: "d-3" }) });
    assert.equal(promoted.status, 200);
    assert.deepEqual((await promoted.json() as { data: unknown }).data, { id: "d-3", name: "平台组", parent_id: null });
    assert.deepEqual(calls[5], { kind: "promote", args: ["d-1", "d-3"] });
    assert.equal((await fetch(`${admin.base}/api/agent/org/departments/d-1/promote`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 422);
    const child = await fetch(`${admin.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "子部门", parent_id: "d-1" }) });
    assert.equal((await child.json() as { data: { parent_id: string } }).data.parent_id, "d-1");
  } finally {
    await admin.http.close();
    await admin.fixture.close();
  }

  const member = await start(remote, ["member"]);
  try {
    const tree = (await (await fetch(`${member.base}/api/agent/org/tree`, { headers: auth })).json() as { data: { children: Array<{ id: string }> } }).data;
    assert.deepEqual(tree.children.map((child) => child.id), ["e1"]);
    denyWrites = true;
    const denied = await fetch(`${member.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "越权" }) });
    assert.equal(denied.status, 403);
    const deniedAssign = await fetch(`${member.base}/api/agent/org/assignments/e1`, { method: "PATCH", headers: auth, body: JSON.stringify({ department_id: "d-empty" }) });
    assert.equal(deniedAssign.status, 403);
    assert.equal((await fetch(`${member.base}/api/agent/org/departments/d-1`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "x" }) })).status, 403);
    assert.equal((await fetch(`${member.base}/api/agent/org/departments/d-1`, { method: "DELETE", headers: auth })).status, 403);
    assert.equal((await fetch(`${member.base}/api/agent/org/departments/d-1/promote`, { method: "POST", headers: auth, body: JSON.stringify({ child_id: "d-3" }) })).status, 403);
  } finally {
    await member.http.close();
    await member.fixture.close();
  }

  const offline = await start({ pullAuthorizedConfig: remote.pullAuthorizedConfig, getOrgTree: remote.getOrgTree }, ["owner"]);
  try {
    assert.equal((await fetch(`${offline.base}/api/agent/org/departments`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x" }) })).status, 503);
  } finally {
    await offline.http.close();
    await offline.fixture.close();
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
    listMarketplaceTemplates: async () => [{ template_id: "template-1", display_name: "Researcher", category: "research", description: "真实市场描述", platform_skill_refs: [{ skill_id: "research", version: "1", content_hash: "sha256:abc" }], model_name: "model-1", skills_count: 1, recruit_count: null, is_recruited: false, tags: ["analysis"], avatar_url: null }],
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
    const template = (await detail.json() as { data: Record<string, unknown> }).data;
    assert.equal(template.description, "真实市场描述");
    assert.deepEqual(template.platform_skill_refs, [{ skill_id: "research", version: "1", content_hash: "sha256:abc" }]);
    assert.equal(template.recruit_count, null);
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

test("Lifecycle known_versions deltas update readiness without mutating an already loaded snapshot", async () => {
  let status = "draft";
  let version = 1;
  let snapshotRequests = 0;
  const remote = new HttpManagerClient("https://manager.test", async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { known_versions?: Record<string, string>; employee_version?: string };
    if (String(input).endsWith("/grants/authorized-config")) {
      const experts = body.known_versions?.e1 === String(version) ? [] : [{
        employee_id: "e1", employee_slug: "helper", display_name: "Helper", version, status,
        model_policy: { model: "test", provider_ref: "test" },
      }];
      return new Response(JSON.stringify({ data: { experts, solutions: [], revoked_ids: [] } }));
    }
    assert.equal(body.employee_version, String(version));
    snapshotRequests++;
    return new Response(JSON.stringify({ data: { snapshot: { employee_id: "e1", version: String(version), snapshot_version: `s${version}`, display_name: "Helper" } } }));
  });
  const { fixture, http, base } = await start(remote);
  const frozen = fixture.store.listSnapshots()[0]!;
  const before = structuredClone(frozen);
  try {
    let known: Record<string, string> = {};
    for (const next of ["draft", "active", "paused", "active", "archived"]) {
      status = next;
      const sync = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1", known_versions: known }) });
      assert.equal(sync.status, 200, await sync.text());
      assert.equal(fixture.store.listLoadedExperts("t1", "m1")[0]!.status, status);
      const readiness = await (await fetch(`${base}/api/agent/grants/readiness`, { headers: auth })).json() as { data: { experts: Array<{ available: boolean }> } };
      assert.equal(readiness.data.experts[0]!.available, status === "active");
      known = { e1: String(version) };
      const requests = snapshotRequests;
      const unchanged = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1", known_versions: known }) });
      assert.equal(unchanged.status, 200);
      assert.equal(snapshotRequests, requests);
      assert.deepEqual(frozen, before);
      version++;
    }
  } finally { await http.close(); await fixture.close(); }
});
