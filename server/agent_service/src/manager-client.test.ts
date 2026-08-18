import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpManagerClient, ManagerUnavailableError, normalizeAuthorizedConfig } from "./manager-client.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };

test("HttpManagerClient forwards authenticated, employee-scoped memory and knowledge requests", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.memoryRecall(caller, "employee-1", "known preference", 3);
  await client.memoryRetain(caller, "employee-1", "safe fact", { source: "user" });
  await client.memoryDelete(caller, "memory-1");
  await client.knowledgeSearch(caller, "employee-1", ["set-a"], "policy", 5);
  await client.knowledgeGet(caller, "employee-1", ["set-a"], "citation-1");

  assert.equal(requests.length, 5);
  assert.match(requests[0].url, /\/api\/manager\/memories\/recall\?employee_id=employee-1&query=known\+preference&limit=3$/);
  assert.equal(requests[0].init.headers && (requests[0].init.headers as Record<string, string>).Authorization, "Bearer jwt");
  assert.equal(requests[1].init.body, JSON.stringify({ employee_id: "employee-1", content: "safe fact", metadata: { source: "user" } }));
  assert.match(requests[2].url, /\/api\/manager\/memories\/memory-1$/);
  assert.equal(requests[2].init.method, "DELETE");
  assert.equal(requests[3].init.body, JSON.stringify({ employee_id: "employee-1", knowledge_refs: ["set-a"], query: "policy", limit: 5 }));
  assert.equal(requests[4].init.body, JSON.stringify({ employee_id: "employee-1", knowledge_refs: ["set-a"], citation_id: "citation-1" }));
  for (const request of requests) assert.doesNotMatch(`${request.url}${request.init.body ?? ""}`, /bank_id/);
});

test("normalizes the Manager AuthorizedConfig contract into local projection fields", () => {
  const config = normalizeAuthorizedConfig({
    experts: [{ employee_id: "employee-1", employee_slug: "helper", display_name: "Helper", version: 7, model: "model-1", provider_ref: "provider-1", tools: ["memory_recall"], skills: ["skill-1"] }],
    solutions: [{ solution_instance_id: "solution-1", display_name: "Solution", version: 3 }],
    snapshots: [{ employee_id: "employee-1", version: 7, snapshot_version: "snap-7", display_name: "Helper", model_policy: { model: "model-1" }, skills: ["skill-1"], tools: ["memory_recall"] }],
    revoked_ids: [],
  }, "tenant-1");
  assert.equal(config.experts[0].handle, "helper");
  assert.equal(config.experts[0].version, "7");
  assert.equal(config.experts[0].tenant_id, "tenant-1");
  assert.deepEqual(config.experts[0].tools, ["memory_recall"]);
  assert.deepEqual(config.experts[0].skills, ["skill-1"]);
  assert.equal(config.solutions[0].version, "3");
  assert.equal(config.snapshots?.[0].version, "7");
  assert.deepEqual(config.snapshots?.[0].skill_refs, ["skill-1"]);
  assert.deepEqual(config.snapshots?.[0].tool_policy, { allowed_tools: ["memory_recall"] });
});

test("empty skill package responses remain authoritative unless explicitly downgraded", () => {
  assert.deepEqual(normalizeAuthorizedConfig({ skill_packages: [] }).skill_packages, []);
  assert.equal(normalizeAuthorizedConfig({ skill_packages: [], skill_packages_authoritative: false }).skill_packages, undefined);
});

test("Manager projection normalization rejects a tenant or member mismatch", () => {
  assert.throws(() => normalizeAuthorizedConfig({ experts: [{ employee_id: "employee-1", tenant_id: "other-tenant", member_id: "member-1", version: "1" }] }, "tenant-1", "member-1"), /different tenant/);
  assert.throws(() => normalizeAuthorizedConfig({ experts: [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-2", version: "1" }] }, "tenant-1", "member-1"), /different member/);
});

test("HttpManagerClient turns transport failures into explicit unavailable errors", async () => {
  const client = new HttpManagerClient("https://manager.test", async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(
    client.memoryRecall(caller, "employee-1", "query", 1),
    (error: unknown) => error instanceof ManagerUnavailableError && /request failed/.test(error.message),
  );
});
