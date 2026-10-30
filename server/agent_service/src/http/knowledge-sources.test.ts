import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { HttpManagerClient, ManagerAuthorizationError, ManagerUnavailableError, type ManagerClient } from "../manager-client.js";

const auth = { Authorization: "Bearer test" };
const baseClient: ManagerClient = {
  pullAuthorizedConfig: async () => ({ experts: [], solutions: [], snapshots: [], revoked_ids: [] }),
  getOrgTree: async () => ({}),
};

async function start(managerClient?: ManagerClient) {
  const fixture = await createFixture();
  const listed: string[] = [];
  Object.assign(fixture.host.localDirectoryService, {
    list: async (caller: { tenantId?: string }) => {
      listed.push(String(caller.tenantId));
      return { available: true, formats: [], directories: [{ directory_id: "dir-1", display_name: "项目资料", path: "/private/secret/kb", revision: 1, status: "ready", bindings: [] }] };
    },
  });
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, managerClient, authenticate: () => ({ callerId: "m1", userId: "m1", tenantId: "t1", roles: ["member"], accessToken: "member-token" }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const document = await (await fetch(`${base}/openapi.json`)).json() as { paths: Record<string, Record<string, any>> };
  const schema = document.paths["/api/agent/knowledge-sources"]!.get!.responses["200"].content["application/json"].schema;
  return { fixture, http, base, schema, listed, async close() { await http.close(); await fixture.close(); } };
}

test("Knowledge sources list enterprise and local sources; personal is client-held", async () => {
  const tokens: Array<string | undefined> = [];
  const remote: ManagerClient = {
    ...baseClient,
    listKnowledgeSpaces: async (caller) => {
      tokens.push(caller.accessToken);
      return [{ knowledge_space_id: "enterprise_shared", display_name: "企业知识库", deployment_kind: "nas" }];
    },
  };
  const app = await start(remote);
  try {
    const response = await fetch(`${app.base}/api/agent/knowledge-sources`, { headers: auth });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Check(app.schema, body), JSON.stringify(body));
    assert.deepEqual(body, {
      data: [
        { source: "enterprise", id: "enterprise_shared", name: "企业知识库", deployment: "nas", status: "ready" },
        { source: "local", id: "dir-1", name: "项目资料", deployment: "this_device", status: "ready" },
      ],
      meta: { enterprise: "ok", personal: "client_held", local: "ok" },
    });
    assert.ok(!JSON.stringify(body).includes("/private/secret"));
    assert.deepEqual(tokens, ["member-token"]);

    const personal = await (await fetch(`${app.base}/api/agent/knowledge-sources?source=personal`, { headers: auth })).json();
    assert.deepEqual(personal, { data: [], meta: { enterprise: "not_requested", personal: "client_held", local: "not_requested" } });
    assert.equal(tokens.length, 1);

    const local = await (await fetch(`${app.base}/api/agent/knowledge-sources?source=local`, { headers: auth })).json() as { data: Array<{ source: string }> };
    assert.deepEqual(local.data.map((item) => item.source), ["local"]);
    assert.equal(tokens.length, 1);

    assert.equal((await fetch(`${app.base}/api/agent/knowledge-sources?source=team`, { headers: auth })).status, 422);
    assert.equal((await fetch(`${app.base}/api/agent/knowledge-sources?other=1`, { headers: auth })).status, 422);
  } finally {
    await app.close();
  }
});

test("Knowledge sources degrade enterprise in the combined view but report it for source=enterprise", async () => {
  let failure: Error = new ManagerUnavailableError("down");
  const remote: ManagerClient = { ...baseClient, listKnowledgeSpaces: async () => { throw failure; } };
  const app = await start(remote);
  try {
    const combined = await fetch(`${app.base}/api/agent/knowledge-sources`, { headers: auth });
    assert.equal(combined.status, 200);
    const body = await combined.json() as { data: Array<{ source: string }>; meta: Record<string, string> };
    assert.equal(body.meta.enterprise, "unavailable");
    assert.deepEqual(body.data.map((item) => item.source), ["local"]);

    const explicit = await fetch(`${app.base}/api/agent/knowledge-sources?source=enterprise`, { headers: auth });
    assert.equal(explicit.status, 503);
    assert.equal((await explicit.json() as { code: string }).code, "manager_unavailable");

    failure = new ManagerAuthorizationError(403);
    const denied = await fetch(`${app.base}/api/agent/knowledge-sources?source=enterprise`, { headers: auth });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code: string }).code, "knowledge_forbidden");

    failure = new ManagerAuthorizationError(401);
    assert.equal((await fetch(`${app.base}/api/agent/knowledge-sources`, { headers: auth })).status, 401);
  } finally {
    await app.close();
  }
});

test("Knowledge sources without a Manager client still list local sources", async () => {
  const app = await start(undefined);
  try {
    const body = await (await fetch(`${app.base}/api/agent/knowledge-sources`, { headers: auth })).json() as { meta: Record<string, string> };
    assert.equal(body.meta.enterprise, "unavailable");
    assert.equal((await fetch(`${app.base}/api/agent/knowledge-sources?source=enterprise`, { headers: auth })).status, 503);
  } finally {
    await app.close();
  }
});

test("HttpManagerClient lists knowledge spaces with the member token and keeps only member-visible fields", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const client = new HttpManagerClient("https://manager.example.invalid", async (input, init) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify({ data: [{ knowledge_space_id: "enterprise_shared", workspace: "w", display_name: "企业知识库", deployment_kind: "nas", created_at: null }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const spaces = await client.listKnowledgeSpaces({ callerId: "m1", userId: "m1", tenantId: "t1", roles: ["member"], accessToken: "member-token" });
  assert.deepEqual(spaces, [{ knowledge_space_id: "enterprise_shared", display_name: "企业知识库", deployment_kind: "nas" }]);
  assert.deepEqual(seen, [{ url: "https://manager.example.invalid/api/manager/knowledge-spaces", authorization: "Bearer member-token" }]);

  const invalid = new HttpManagerClient("https://manager.example.invalid", async () => new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }));
  await assert.rejects(invalid.listKnowledgeSpaces({ callerId: "m1", userId: "m1", tenantId: "t1", roles: ["member"], accessToken: "t" }), ManagerUnavailableError);
});
