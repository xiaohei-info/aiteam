import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { HttpManagerClient, normalizeAuthorizedConfig, normalizeHindsightRuntimeConfig, normalizeRuntimeProviderConfig } from "./manager-client.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };

test("HttpManagerClient keeps employee-scoped memory deletion for management operations", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.memoryDelete(caller, "employee-1", "memory-1", "delete-key");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/manager\/memories\/memory-1\?employee_id=employee-1$/);
  assert.equal(requests[0].init.headers && (requests[0].init.headers as Record<string, string>).Authorization, "Bearer jwt");
  assert.equal(requests[0].init.headers && (requests[0].init.headers as Record<string, string>)["Idempotency-Key"], "delete-key");
  assert.equal(requests[0].init.method, "DELETE");
  for (const request of requests) assert.doesNotMatch(`${request.url}${request.init.body ?? ""}`, /bank_id/);
});

test("HttpManagerClient pulls a bounded marketplace catalog from Manager", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: [{ template_id: "tpl-1", display_name: "Researcher", category: "research", default_model: "model-1", skill_ids: ["skill-1"], tags: ["analysis"] }] }), { status: 200 });
  });
  const templates = await client.listMarketplaceTemplates(caller);
  assert.deepEqual(templates[0], { template_id: "tpl-1", display_name: "Researcher", category: "research", model_name: "model-1", skills_count: 1, recruit_count: 0, is_recruited: false, tags: ["analysis"], avatar_url: null });
  assert.equal(request?.url, "https://manager.test/api/manager/recruit/catalog/experts");
  assert.equal((request?.init.headers as Record<string, string>).Authorization, "Bearer jwt");
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

test("HttpManagerClient pulls an opaque bank-scoped Hindsight lease without bank input", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: {
      base_url: "/api/manager/hindsight", bank_id: "aiteam-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      token: "opaque-lease-secret", lease_id: "lease-1", version: 3,
      issued_at: new Date().toISOString(), expires_at: expiresAt,
    } }), { status: 200 });
  });
  const lease = await client.pullHindsightRuntimeConfig(caller, "employee-1");
  assert.equal(lease.base_url, "https://manager.test/api/manager/hindsight");
  assert.equal(lease.bank_id, "aiteam-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(request?.url, "https://manager.test/api/manager/hindsight/runtime-config");
  assert.equal(request?.init.body, JSON.stringify({ employee_id: "employee-1" }));
  assert.equal((request?.init.headers as Record<string, string>).Authorization, "Bearer jwt");
  assert.doesNotMatch(String(request?.init.body), /opaque-lease-secret|bank_id/);
});

test("Hindsight lease normalization rejects direct upstream URLs, extra fields, and expiry", () => {
  const valid = {
    base_url: "/api/manager/hindsight", bank_id: "aiteam-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token: "opaque", lease_id: "lease-1", version: 1,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.doesNotThrow(() => normalizeHindsightRuntimeConfig(valid, "https://manager.test"));
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...valid, base_url: "https://hindsight.test/api/manager/hindsight" }, "https://manager.test"), /facade URL/);
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...valid, unexpected: "secret" }, "https://manager.test"), /runtime config/);
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...valid, expires_at: new Date(Date.now() - 1_000).toISOString() }, "https://manager.test"), /expired/);
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...valid, bank_id: "other-bank" }, "https://manager.test"), /bank scope/);
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
