import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { HINDSIGHT_CLIENT_PROTOCOL, HttpManagerClient, normalizeAuthorizedConfig, normalizeHindsightRuntimeConfig, normalizeRuntimeProviderConfig } from "./manager-client.js";

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
  assert.deepEqual(templates[0], { template_id: "tpl-1", display_name: "Researcher", category: "research", description: null, platform_skill_refs: null, model_name: "model-1", skills_count: 1, recruit_count: null, is_recruited: false, tags: ["analysis"], avatar_url: null });
  assert.equal(request?.url, "https://manager.test/api/manager/recruit/catalog/experts");
  assert.equal((request?.init.headers as Record<string, string>).Authorization, "Bearer jwt");
});

test("marketplace skill counts prefer modern fixed platform refs, including authoritative empty lists", async () => {
  const ref = { skill_id: "skill-1", version: "1", content_hash: "sha256:abc" };
  const client = new HttpManagerClient("https://manager.test", async () => new Response(JSON.stringify({ data: [
    { template_id: "modern", description: "真实描述", platform_skill_refs: [ref, { ...ref, skill_id: "skill-2", private_key: "not-public" }], skill_ids: ["old"], skills_count: 9 },
    { template_id: "empty", platform_skill_refs: [], skill_ids: ["old"] },
    { template_id: "invalid", platform_skill_refs: [null, "not-a-ref", {}, ref] },
  ] }), { status: 200 }));
  const templates = await client.listMarketplaceTemplates(caller);
  assert.deepEqual(templates.map((template) => template.skills_count), [2, 0, 1]);
  assert.equal(templates[0].description, "真实描述");
  assert.deepEqual(templates[0].platform_skill_refs, [ref, { ...ref, skill_id: "skill-2" }]);
  assert.deepEqual(templates[1].platform_skill_refs, []);
  assert.deepEqual(templates[2].platform_skill_refs, [ref]);
  assert.equal(templates[0].recruit_count, null);
  assert.doesNotMatch(JSON.stringify(templates), /private_key|not-public|usage_stats|price_tier/);
});

test("authorized employee projection preserves real position and all departments without inference", () => {
  const expert = { employee_id: "e1", version: 1, display_name: "研究员", role_title: "研究分析师", department_ids: ["d1", "d2"] };
  const normalized = normalizeAuthorizedConfig({ experts: [expert] }, "tenant-1", "member-1").experts[0];
  assert.equal(normalized.role_title, expert.role_title);
  assert.deepEqual(normalized.department_ids, expert.department_ids);
  const legacy = normalizeAuthorizedConfig({ experts: [{ employee_id: "e2", version: 1, role_name: "不得猜测", persona: "总监" }] }).experts[0];
  assert.equal(legacy.role_title, null);
  assert.deepEqual(legacy.department_ids, []);
});

test("HttpManagerClient pulls only the employee-scoped runtime provider config", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: {
      base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "secret",
      model: "m1", provider_ref: "p1", provider_version: 1, model_version: 1, version: 2,
      pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", effective_from: new Date().toISOString() },
    } }), { status: 200 });
  });
  const config = await client.pullRuntimeConfig(caller, "employee-1");
  assert.equal(config.model, "m1");
  assert.equal("provider_version" in config, false);
  assert.equal("model_version" in config, false);
  assert.equal(request?.url, "https://manager.test/api/manager/provider-credentials/runtime-config");
  assert.equal(request?.init.body, JSON.stringify({ employee_id: "employee-1" }));
  assert.equal((request?.init.headers as Record<string, string>).Authorization, "Bearer jwt");
});

test("HttpManagerClient pulls member-scoped speech runtime config without employee input", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: {
      base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "secret",
      model: "XingChenAGI/XingChenASR-V3.2-Ultra", provider_ref: "p1", provider_version: 1, model_version: 1, version: 2,
      pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "request", input_usd_per_million: null, output_usd_per_million: null, cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: "0", currency: "USD", effective_from: new Date().toISOString() },
    } }), { status: 200 });
  });
  const config = await client.pullSpeechRuntimeConfig(caller);
  assert.equal(config.model, "XingChenAGI/XingChenASR-V3.2-Ultra");
  assert.equal("provider_version" in config, false);
  assert.equal("model_version" in config, false);
  assert.equal(request?.url, "https://manager.test/api/manager/provider-credentials/speech/runtime-config");
  assert.equal(request?.init.body, JSON.stringify({}));
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
  assert.equal(request?.init.body, JSON.stringify({ employee_id: "employee-1", client_protocol: HINDSIGHT_CLIENT_PROTOCOL }));
  assert.equal(lease.explicit_auto_retain, false); // old response is not permission to auto-upload
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
      model: "m1", provider_ref: "p1", provider_version: 1, model_version: 1, version: 1,
      pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", effective_from: new Date().toISOString() },
    }).api_protocol, api_protocol);
  }
  const withCapabilities = normalizeRuntimeProviderConfig({
    base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "secret",
    model: "m1", provider_ref: "p1", provider_version: 1, model_version: 1, version: 1,
    pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", effective_from: new Date().toISOString() },
    model_capabilities: { context_window: 64_000, max_tokens: 4_096, reasoning: true, input: ["text", "image"], thinking_level_map: { high: "high" } },
  });
  assert.equal(withCapabilities.model_capabilities?.context_window, 64_000);
  assert.throws(() => normalizeRuntimeProviderConfig({
    base_url: "https://newapi.test/v1", api_protocol: "openai-completions", api_key: "secret",
    model: "m1", provider_ref: "p1", provider_version: 1, model_version: 1, version: 1,
    pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", effective_from: new Date().toISOString() },
    model_capabilities: { api_key: "secret" },
  }), /invalid model capabilities/);
  assert.throws(() => normalizeRuntimeProviderConfig({
    base_url: "https://newapi.test/v1", api_protocol: "pi-messages", api_key: "secret",
    model: "m1", provider_ref: "p1", provider_version: 1, model_version: 1, version: 1,
    pricing: { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", effective_from: new Date().toISOString() },
  }), /invalid runtime provider protocol/);
});

test("production runtime provider config rejects local relay destinations", () => {
  const original = process.env.AITEAM_ENV;
  process.env.AITEAM_ENV = "production";
  const base = {
    api_protocol: "openai-completions" as const, api_key: "secret", model: "m1", provider_ref: "p1",
    provider_version: 1, model_version: 1, version: 1,
    pricing: { pricing_version: 1, pricing_status: "known" as const, billing_mode: "token" as const, input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD" as const, effective_from: new Date().toISOString() },
  };
  try {
    for (const base_url of ["https://127.0.0.2/v1", "https://198.51.100.1/v1", "https://203.0.113.1/v1", "https://[fec0::1]/v1", "https://[2001:0::1]/v1", "https://[64:ff9b::1]/v1", "https://[2002::1]/v1", "https://[3ffe::1]/v1", "https://[0:0:0:0:0:0:0:1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://localhost/v1", "https://service.local/v1", "https://newapi/v1"]) {
      assert.throws(() => normalizeRuntimeProviderConfig({ ...base, base_url }), /invalid runtime relay URL/);
    }
    assert.equal(normalizeRuntimeProviderConfig({ ...base, base_url: "https://relay.example/v1" }).base_url, "https://relay.example/v1");
  } finally {
    if (original === undefined) delete process.env.AITEAM_ENV;
    else process.env.AITEAM_ENV = original;
  }
});

test("normalizes the Manager AuthorizedConfig contract into local projection fields", () => {
  const config = normalizeAuthorizedConfig({
    experts: [{ employee_id: "employee-1", employee_slug: "helper", display_name: "Helper", version: 7, model: "model-1", provider_ref: "provider-1", tools: ["memory_recall"], skills: ["skill-1"] }],
    solutions: [{ id: "instance-1", solution_id: "catalog-1", display_name: "Solution", version: 3 }],
    snapshots: [{ employee_id: "employee-1", version: 7, snapshot_version: "snap-7", display_name: "Helper", model_policy: { model: "model-1" }, skills: ["skill-1"], tools: ["memory_recall"] }],
    revoked_ids: [],
  }, "tenant-1");
  assert.equal(config.experts[0].handle, "helper");
  assert.equal(config.experts[0].version, "7");
  assert.equal(config.experts[0].tenant_id, "tenant-1");
  assert.deepEqual(config.experts[0].tools, ["memory_recall"]);
  assert.deepEqual(config.experts[0].skills, ["skill-1"]);
  assert.equal(config.solutions[0].solution_instance_id, "instance-1");
  assert.equal(config.solutions[0].version, "3");
  assert.equal(config.snapshots?.[0].version, "7");
  assert.deepEqual(config.snapshots?.[0].skill_refs, ["skill-1"]);
  assert.deepEqual(config.snapshots?.[0].tool_policy, { allowed_tools: ["memory_recall"] });
  assert.deepEqual(config.snapshots?.[0].model_policy, { model: "model-1" });
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


test("Manager effective knowledge policy survives snapshot/projection normalization and malformed deny fails closed", () => {
  const knowledge_policy = { state: "deny", allowed_operations: [], revision: "9" };
  const expert = { employee_id: "employee", version: "9", knowledge_policy };
  const snapshot = { ...expert, snapshot_version: "snap9", tools: [] };
  const result = normalizeAuthorizedConfig({ experts: [expert], snapshots: [snapshot] }, "tenant", "member");
  assert.deepEqual(result.experts[0].knowledge_policy, knowledge_policy);
  assert.deepEqual(result.snapshots?.[0].knowledge_policy, knowledge_policy);
  for (const invalid of [false, { state: "deny", allowed_operations: ["knowledge_get"], revision: "9" },
    { state: "allow", allowed_operations: ["unknown"], revision: "9" }, { state: "inherit", allowed_operations: [] },
    { state: "allow", allowed_operations: ["knowledge_get", "knowledge_get"], revision: "9" }]) {
    assert.throws(() => normalizeAuthorizedConfig({ snapshots: [{ ...snapshot, knowledge_policy: invalid }] }), /knowledge policy/);
  }
});

test("Hindsight current protocol validates scope/revision and never infers automatic consent", () => {
  const base = { base_url: "/api/manager/hindsight", bank_id: `aiteam-${"a".repeat(32)}`, token: "fixture", lease_id: "lease", version: 1,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now()+60_000).toISOString(),
    allowed_operations: ["recall", "retain"], policy_revision: 2 };
  const old = normalizeHindsightRuntimeConfig({ ...base, explicit_auto_retain: true }, "https://manager.test");
  assert.deepEqual(old.allowed_operations, ["recall"]);
  assert.equal(old.explicit_auto_retain, false);
  const current = { ...base, client_protocol: HINDSIGHT_CLIENT_PROTOCOL, retention_mode: "fact_only" };
  const normalized = normalizeHindsightRuntimeConfig(current, "https://manager.test");
  assert.equal(normalized.explicit_auto_retain, false);
  assert.equal(normalized.retention_mode, "fact_only");
  assert.deepEqual(normalized.allowed_operations, ["recall", "retain"]);
  assert.equal(normalized.policy_revision, 2);
  assert.equal(normalizeHindsightRuntimeConfig({ ...current, explicit_auto_retain: true }, "https://manager.test").explicit_auto_retain, true);
  for (const explicit_auto_retain of ["true", 1, null]) {
    assert.throws(() => normalizeHindsightRuntimeConfig({ ...current, explicit_auto_retain }, "https://manager.test"), /consent/);
  }
  for (const policy_revision of [undefined, 0, -1, 2.5]) {
    assert.throws(() => normalizeHindsightRuntimeConfig({ ...current, policy_revision }, "https://manager.test"), /versioned memory lease/);
  }
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...current, allowed_operations: undefined }, "https://manager.test"), /versioned memory lease/);
  assert.throws(() => normalizeHindsightRuntimeConfig({ ...current, client_protocol: "unrecognized" }, "https://manager.test"), /protocol/);
});

test("Hindsight negotiation is constant on rotation and is never retried as an old unscoped request", async () => {
  for (const status of [401, 403, 409, 422]) {
    const sent: unknown[] = [];
    const client = new HttpManagerClient("https://manager.test", async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ code: "fixture-denial" }, { status });
    });
    await assert.rejects(() => client.pullHindsightRuntimeConfig(caller, "employee-1", true));
    assert.deepEqual(sent, [{ employee_id: "employee-1", client_protocol: HINDSIGHT_CLIENT_PROTOCOL, rotate: true }]);
  }
});
