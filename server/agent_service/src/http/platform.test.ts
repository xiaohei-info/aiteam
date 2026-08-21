import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import type { ManagerClient } from "../manager-client.js";

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
    getOrgTree: async () => ({ id: "root", type: "department", name: "Tenant", children: [] }),
  };
  const { fixture, http, base } = await start(remote);
  try {
    const created = await fetch(`${base}/api/agent/conversations`, { method: "POST", headers: auth, body: JSON.stringify({ title: "Local", labels: ["one"], entry_employee_id: "e1" }) });
    assert.equal(created.status, 201);
    const conversation = (await created.json() as { data: { id: string; state: string } }).data;
    assert.equal(conversation.state, "active");
    const listed = await fetch(`${base}/api/agent/conversations`, { headers: auth });
    assert.equal((await listed.json() as { data: unknown[] }).data.length, 1);
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
    assert.equal((await (await fetch(`${base}/api/agent/org/tree`, { headers: auth })).json() as { data: { name: string } }).data.name, "Tenant");
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

test("Grant sync validates the bundle before changing local projections", async () => {
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [{ employee_id: "remote", tenant_id: "t1", version: "2", handle: "remote", display_name: "Remote", revoked: false, synced_at: new Date().toISOString() }], solutions: [], snapshots: [], revoked_ids: ["e1"] }),
    pullKnowledgeArtifacts: async () => ({ authoritative: true, artifacts: [{ tenant_id: "t1", member_id: "m1", employee_id: "remote", knowledge_space_id: "space-1", document_id: "doc-1", artifact_version: "v1", source_hash: "not-a-hash", citation_id: "c1", chunk_index: 0, title: "bad", source: { type: "file", name: "x.txt", mime_type: "text/plain" }, content: "bad" }] }),
    getOrgTree: async () => ({}),
  };
  const { fixture, http, base } = await start(remote);
  fixture.store.replaceKnowledgeArtifacts([{
    tenant_id: "t1", member_id: "m1", employee_id: "e1", knowledge_space_id: "space-1", document_id: "old-doc",
    artifact_version: "v1", source_hash: "a".repeat(64), citation_id: "old-citation", chunk_index: 0, title: "old",
    source: { type: "file", name: "old.txt", mime_type: "text/plain" }, content: "old content",
  }], { tenantId: "t1", memberId: "m1" });
  try {
    const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1" }) });
    assert.equal(response.status, 503);
    assert.deepEqual(fixture.store.listLoadedExperts().map((expert) => expert.employee_id), ["e1"]);
    assert.deepEqual(fixture.store.listKnowledgeArtifacts("t1", "m1").map((artifact) => artifact.citation_id), ["old-citation"]);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("Grant sync keeps the authoritative knowledge roster on an unchanged second sync", async () => {
  const artifact = {
    tenant_id: "t1", member_id: "m1", employee_id: "e1", knowledge_space_id: "space-1", document_id: "doc-1",
    artifact_version: "v1", source_hash: "a".repeat(64), citation_id: "citation-1", chunk_index: 0,
    title: "Handbook", source: { type: "file", name: "handbook.txt", mime_type: "text/plain" }, content: "offline handbook",
  };
  const knownVersions: Record<string, string>[] = [];
  const remote: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [{ employee_id: "e1", tenant_id: "t1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() }], solutions: [], snapshots: [], revoked_ids: [] }),
    pullKnowledgeArtifacts: async (_caller, known) => { knownVersions.push(known); return { authoritative: true, artifacts: [artifact] }; },
    getOrgTree: async () => ({}),
  };
  const { fixture, http, base } = await start(remote);
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${base}/api/agent/grants/sync`, { method: "POST", headers: auth, body: JSON.stringify({ tenant_id: "t1", member_id: "m1", ...(index === 1 ? { known_versions: { "citation-1": "v1" } } : {}) }) });
      assert.equal(response.status, 200);
    }
    assert.equal(knownVersions.length, 2);
    assert.deepEqual(knownVersions, [{}, {}]);
    assert.equal(fixture.store.listKnowledgeArtifacts("t1", "m1")[0]?.citation_id, "citation-1");
    assert.equal(fixture.store.listKnowledgeArtifacts("t1", "m1").length, 1);
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
    assert.equal((await response.json() as { code: string }).code, "manager_unavailable");
    assert.equal(fixture.store.listLoadedExperts().length, 1);
  } finally {
    await http.close();
    await fixture.close();
  }
});
