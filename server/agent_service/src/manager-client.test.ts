import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { HttpManagerClient, ManagerUnavailableError, normalizeAuthorizedConfig, normalizeKnowledgeArtifact, normalizeRuntimeProviderConfig } from "./manager-client.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };

test("HttpManagerClient keeps employee-scoped memory deletion for management operations", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.memoryDelete(caller, "memory-1");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/manager\/memories\/memory-1$/);
  assert.equal(requests[0].init.headers && (requests[0].init.headers as Record<string, string>).Authorization, "Bearer jwt");
  assert.equal(requests[0].init.method, "DELETE");
  for (const request of requests) assert.doesNotMatch(`${request.url}${request.init.body ?? ""}`, /bank_id/);
});

test("HttpManagerClient pulls only the employee-scoped runtime provider config", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: {
      base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "secret",
      model: "m1", provider_ref: "p1", version: 2,
    } }), { status: 200 });
  });
  const config = await client.pullRuntimeConfig(caller, "employee-1");
  assert.equal(config.model, "m1");
  assert.equal(request?.url, "https://manager.test/api/manager/provider-credentials/runtime-config");
  assert.equal(request?.init.body, JSON.stringify({ employee_id: "employee-1" }));
  assert.equal((request?.init.headers as Record<string, string>).Authorization, "Bearer jwt");
});

test("runtime config accepts only the Pi protocols implemented by this contract", () => {
  for (const api_protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    assert.equal(normalizeRuntimeProviderConfig({
      base_url: "https://newapi.test/v1", api_protocol, api_key: "secret",
      model: "m1", provider_ref: "p1", version: 1,
    }).api_protocol, api_protocol);
  }
  assert.throws(() => normalizeRuntimeProviderConfig({
    base_url: "https://newapi.test/v1", api_protocol: "pi-messages", api_key: "secret",
    model: "m1", provider_ref: "p1", version: 1,
  }), /invalid runtime provider protocol/);
});

test("HttpManagerClient pulls the local bundle with URL/auth and rejects malformed responses", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const artifact = {
    tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1", knowledge_space_id: "space-1",
    document_id: "doc-1", artifact_version: "v1", source_hash: "a".repeat(64), citation_id: "citation-1",
    chunk_index: 0, title: "Title", source: { type: "file", name: "doc.txt", mime_type: "text/plain" }, content: "content",
  };
  const client = new HttpManagerClient("https://manager.test/base/", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { artifacts: [artifact], authoritative: true } }), { status: 200 });
  });
  const bundle = await client.pullKnowledgeArtifacts(caller, { citation: "v1" });
  assert.equal(bundle.artifacts[0].citation_id, "citation-1");
  assert.equal(requests[0].url, "https://manager.test/api/manager/knowledge/artifacts/bundle");
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bearer jwt");
  assert.equal(requests[0].init.body, JSON.stringify({ known_versions: { citation: "v1" } }));

  const malformed = new HttpManagerClient("https://manager.test", async () => new Response(JSON.stringify({ data: { artifacts: {} } }), { status: 200 }));
  await assert.rejects(malformed.pullKnowledgeArtifacts(caller, {}), ManagerUnavailableError);
});

test("HttpManagerClient rejects oversized knowledge responses before JSON parsing", async () => {
  const knownLength = new HttpManagerClient("https://manager.test", async () => new Response("{}", {
    status: 200,
    headers: { "content-length": String(48 * 1024 * 1024 + 1) },
  }));
  await assert.rejects(knownLength.pullKnowledgeArtifacts(caller, {}), /exceeds limit/);

  const unknownLength = new HttpManagerClient("https://manager.test", async () => new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < 49; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
      controller.close();
    },
  }), { status: 200 }));
  await assert.rejects(unknownLength.pullKnowledgeArtifacts(caller, {}), /exceeds limit/);
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

test("authorized config and snapshot accept only public skill signing metadata", () => {
  const keyPair = generateKeyPairSync("ed25519");
  const key = { key_id: "skill-current", public_key: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), algorithm: "Ed25519", status: "current" };
  const config = normalizeAuthorizedConfig({ skill_signing_keys: [key] }, "tenant-1", "member-1");
  assert.equal(config.skill_signing_keys?.[0].key_id, "skill-current");
  assert.throws(() => normalizeAuthorizedConfig({ skill_signing_keys: [{ ...key, private_key: "must-not-cross-boundary" }] }, "tenant-1", "member-1"), /invalid skill signing key metadata/);
  assert.throws(() => normalizeAuthorizedConfig({ skill_signing_keys: [{ ...key, algorithm: "HMAC" }] }, "tenant-1", "member-1"), /invalid skill signing key metadata/);
});

test("empty skill package responses remain authoritative unless explicitly downgraded", () => {
  assert.deepEqual(normalizeAuthorizedConfig({ skill_packages: [] }).skill_packages, []);
  assert.equal(normalizeAuthorizedConfig({ skill_packages: [], skill_packages_authoritative: false }).skill_packages, undefined);
});

test("Manager projection normalization rejects a tenant or member mismatch", () => {
  assert.throws(() => normalizeAuthorizedConfig({ experts: [{ employee_id: "employee-1", tenant_id: "other-tenant", member_id: "member-1", version: "1" }] }, "tenant-1", "member-1"), /different tenant/);
  assert.throws(() => normalizeAuthorizedConfig({ experts: [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-2", version: "1" }] }, "tenant-1", "member-1"), /different member/);
});

test("knowledge artifact normalization rejects malformed ownership, hashes, and indexes", () => {
  const valid = {
    tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1", knowledge_space_id: "space-1",
    document_id: "doc-1", artifact_version: "exporter:v1;chunker:v1;sha256:abc", source_hash: "a".repeat(64),
    citation_id: "citation-1", chunk_index: 0, title: "Title", source: { type: "file", name: "doc.txt", mime_type: "text/plain" }, content: "content",
  };
  assert.doesNotThrow(() => normalizeKnowledgeArtifact(valid, "tenant-1", "member-1"));
  for (const field of ["tenant_id", "member_id", "employee_id", "knowledge_space_id", "citation_id", "content", "source_hash"]) {
    assert.throws(() => normalizeKnowledgeArtifact({ ...valid, [field]: "" }, "tenant-1", "member-1"));
  }
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, chunk_index: Number.NaN }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, chunk_index: -1 }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, source: { type: "file" } }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, unexpected: true }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, source: { ...valid.source, extra: "nope" } }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, title: "x".repeat(513) }, "tenant-1", "member-1"));
  assert.throws(() => normalizeKnowledgeArtifact({ ...valid, content: "x".repeat(1_048_577) }, "tenant-1", "member-1"));
});
