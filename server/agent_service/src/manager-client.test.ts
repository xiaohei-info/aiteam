import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpManagerClient, ManagerUnavailableError } from "./manager-client.js";

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

test("HttpManagerClient turns transport failures into explicit unavailable errors", async () => {
  const client = new HttpManagerClient("https://manager.test", async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(
    client.memoryRecall(caller, "employee-1", "query", 1),
    (error: unknown) => error instanceof ManagerUnavailableError && /request failed/.test(error.message),
  );
});
