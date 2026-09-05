import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import type { AuthenticatedCaller } from "./auth.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] };

async function serve(fixture: Awaited<ReturnType<typeof createFixture>>, options: Partial<ConstructorParameters<typeof AgentHttpServer>[0]> = {}) {
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => caller, ...options });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  return { http, async request(path: string, status = 200, body?: unknown): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, status, await response.clone().text());
    if (status >= 400) assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    return response.json();
  } };
}

test("employee display propagates true positions and multi-department associations to expert, office, roster and org", async () => {
  const fixture = await createFixture();
  const experts = ["e1", "legacy", "revoked", "outsider"].map((employee_id) => ({ employee_id, tenant_id: caller.tenantId, member_id: caller.userId, version: "1", handle: employee_id, display_name: employee_id, revoked: employee_id === "revoked", synced_at: new Date().toISOString(), ...(employee_id === "e1" ? { role_title: "研究分析师", department_ids: ["d1", "d2"] } : {}), ...(employee_id === "revoked" ? { role_title: "token=secret-role-material", department_ids: ["d2"] } : {}) }));
  fixture.store.replaceProjections(experts, [], experts.map((expert) => ({ ...expert, snapshot_version: "1" })), ["revoked"]);
  for (const employeeId of ["e1", "legacy", "revoked", "missing"]) fixture.store.upsertConversationParticipant({ conversation_id: "c1", employee_id: employeeId, role: "member", session_file: "", workspace: "", pi_session_id: null, employee_version: "1" });
  const { http, request } = await serve(fixture, { managerClient: {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({ id: "root", name: "企业", type: "department", children: ["d1", "d2"].map((id) => ({ id, name: id, type: "department", children: [{ id: "e1", type: "employee", name: "e1", role_title: "研究分析师", children: [] }, { id: "hidden", name: "hidden", type: "employee", role_title: "秘密岗位", children: [] }] })) }),
  } });
  try {
    const loaded = (await request("/api/agent/grants/experts")).data;
    const office = (await request("/api/agent/office/scene")).data.employees;
    const roster = (await request("/api/agent/conversations/c1/participants")).data;
    for (const employees of [loaded, office, roster.participants]) {
      assert.equal(employees.find((item: any) => item.employee_id === "e1").role_title, "研究分析师");
      assert.deepEqual(employees.find((item: any) => item.employee_id === "e1").department_ids, ["d1", "d2"]);
      assert.equal(employees.find((item: any) => item.employee_id === "legacy").role_title, null);
      assert.deepEqual(employees.find((item: any) => item.employee_id === "legacy").department_ids, []);
      assert.doesNotMatch(JSON.stringify(employees), /secret-role-material|session_file|workspace/);
    }
    assert.equal(roster.employee_count, 4);
    assert(!roster.participants.some((item: any) => item.employee_id === "outsider"));
    assert.equal(roster.participants.find((item: any) => item.employee_id === "revoked").available, false);
    assert.equal(roster.participants.find((item: any) => item.employee_id === "missing").role_title, null);
    const org = (await request("/api/agent/org/tree")).data;
    assert.equal(org.children.length, 2);
    assert(org.children.every((dept: any) => dept.children.length === 1 && dept.children[0].role_title === "研究分析师"));
    const openapi = await request("/openapi.json");
    for (const name of ["ExpertProjection", "ConversationParticipant"]) {
      assert(openapi.components.schemas[name].properties.role_title);
      assert(openapi.components.schemas[name].properties.department_ids);
    }
    assert(openapi.components.schemas.OfficeSceneEnvelope.properties.data.properties.employees.items.properties.role_title);
    assert.equal(openapi.components.schemas.AuthClaims.properties.tenant_id.type, "string");
    assert.equal(openapi.components.schemas.AuthClaims.properties.tenant_id.minLength, 1);
    for (const path of ["/api/agent/conversations/{conversation_id}/participants", "/api/agent/messages/search", "/api/agent/work-records", "/api/agent/work-records/changes", "/api/agent/usage/statistics"]) {
      assert(openapi.paths[path].get.description);
      assert(openapi.paths[path].get.responses["200"].content["application/json"].examples);
      assert(openapi.paths[path].get.responses["422"]);
    }
  } finally { await http.close(); await fixture.close(); }
});

test("Agent success identity never returns an absent, empty or foreign tenant", async () => {
  const fixture = await createFixture();
  let claims: Record<string, unknown> = { user_id: "member-1", tenant_id: "tenant-1", roles: ["member"] };
  let identity: AuthenticatedCaller = caller;
  const { http, request } = await serve(fixture, { authenticate: () => identity, managerClient: {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }), getOrgTree: async () => ({}),
    resolveTenantByAccount: async () => ({ data: { tenant_id: claims.tenant_id } }),
    login: async () => ({ data: { token: "test-token", claims } }),
    ownerReset: async () => ({ data: { token: "test-token", claims } }),
  } });
  try {
    for (const tenant of [undefined, null, "", " ", 123, "other-tenant"]) {
      claims = { ...claims, tenant_id: tenant };
      for (const route of ["login", "reset-password"]) {
        const result = await request(`/api/agent/${route}`, 503, { tenant_id: "tenant-1", account: "member", password: "test", old_password: "test", new_password: "test-new" });
        assert.equal(result.code, "manager_unavailable");
        assert.doesNotMatch(JSON.stringify(result), /test-token/);
      }
      if (tenant !== "other-tenant") await request("/api/auth/resolve-tenant-by-account", 503, { account: "member" });
    }
    claims = { ...claims, tenant_id: "tenant-1" };
    for (const route of ["login", "reset-password"]) assert.equal((await request(`/api/agent/${route}`, 200, { tenant_id: "tenant-1", account: "member", password: "test", old_password: "test", new_password: "test-new" })).data.claims.tenant_id, "tenant-1");
    assert.equal((await request("/api/auth/resolve-tenant-by-account", 200, { account: "member" })).data.tenant_id, "tenant-1");
    assert.equal((await request("/api/agent/whoami")).data.tenant_id, "tenant-1");
    for (const tenantId of [undefined, "", " "]) { identity = { ...caller, tenantId }; await request("/api/agent/whoami", 401); }
    identity = { ...caller, claims: { tenant_id: "different" } };
    await request("/api/agent/whoami", 401);
  } finally { await http.close(); await fixture.close(); }
});
