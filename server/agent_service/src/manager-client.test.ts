import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appLogger } from "./observability.js";
import { HINDSIGHT_CLIENT_PROTOCOL, HttpManagerClient, ManagerTimeoutError, ManagerUnavailableError, ManagerValidationError, MemoryRetainUnverifiedError, normalizeAuthorizedConfig, normalizeHindsightRuntimeConfig, normalizeRuntimeProviderConfig } from "./manager-client.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };
const EMPTY_PROFILE = {
  tagline: null, use_cases: [], limitations: [], example_prompts: [], sample_outputs: [], output_types: [],
  required_connectors: [], optional_connectors: [], recommended_knowledge: [], required_permissions: null, pricing: null,
  memory_policy_summary: null, publisher: null, version: null, updated_at: null, changelog_url: null, stats: null,
};

test("HttpManagerClient keeps employee-scoped memory deletion for management operations", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.memoryDelete(caller, "employee-1", "memory-1", "delete-key");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/manager\/memories\/memory-1\?employee_id=employee-1$/);
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), "Bearer jwt");
  assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "delete-key");
  assert.match(new Headers(requests[0].init.headers).get("traceparent") ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(requests[0].init.method, "DELETE");
  for (const request of requests) assert.doesNotMatch(`${request.url}${request.init.body ?? ""}`, /bank_id/);
});

test("HttpManagerClient retains employee-scoped memory through the Manager facade", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { success: true, async: true, operation_id: "op-1" } }), { status: 201, headers: { "content-type": "application/json" } });
  });

  const ack = await client.memoryRetain(caller, "employee-1", "summary", { source: "context_reset" }, "retain-key");
  assert.deepEqual(ack, { operationId: "op-1" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://manager.test/api/manager/memories/retain");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), "Bearer jwt");
  assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "retain-key");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { employee_id: "employee-1", content: "summary", metadata: { source: "context_reset" } });
  assert.doesNotMatch(String(requests[0].init.body), /bank_id/);

  const invalid = new HttpManagerClient("https://manager.test", async () => Response.json({ data: { success: true } }, { status: 201 }));
  await assert.rejects(() => invalid.memoryRetain(caller, "employee-1", "summary"), (error: unknown) => error instanceof MemoryRetainUnverifiedError && /invalid memory retain acknowledgement/.test(error.message));

  const unreadable = new HttpManagerClient("https://manager.test", async () => new Response("not json", { status: 201 }));
  await assert.rejects(() => unreadable.memoryRetain(caller, "employee-1", "summary"), MemoryRetainUnverifiedError);

  const tooLarge = new HttpManagerClient("https://manager.test", async () => Response.json({ code: "request_too_large" }, { status: 413 }));
  await assert.rejects(() => tooLarge.memoryRetain(caller, "employee-1", "summary"), (error: unknown) => error instanceof ManagerUnavailableError && error.httpStatus === 413);

  const unverified = new HttpManagerClient("https://manager.test", async () => Response.json({ code: "memory_retention_unverified", detail: "Native retention contract is unavailable" }, { status: 503 }));
  await assert.rejects(() => unverified.memoryRetain(caller, "employee-1", "summary"), (error: unknown) => error instanceof ManagerUnavailableError && error.httpStatus === 503 && error.problemCode === "memory_retention_unverified");

  const timedOut = new HttpManagerClient("https://manager.test", async () => { throw new DOMException("The operation timed out", "TimeoutError"); });
  await assert.rejects(() => timedOut.memoryRetain(caller, "employee-1", "summary"), ManagerTimeoutError);

  const down = new HttpManagerClient("https://manager.test", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => down.memoryRetain(caller, "employee-1", "summary"), (error: unknown) => error instanceof ManagerUnavailableError && !(error instanceof ManagerTimeoutError));
});

test("HttpManagerClient creates departments and appends assignments with the member's own bearer", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ data: { id: "dept-1", department_slug: "dept-abc", display_name: "研究部" } }, { status: 201 });
  });

  const created = await client.createDepartment(caller, { department_slug: "dept-abc", display_name: "研究部" });
  await client.assignEmployeeDepartment(caller, "employee/1", "dept-1");

  assert.deepEqual(created, { id: "dept-1", department_slug: "dept-abc", display_name: "研究部" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://manager.test/api/manager/departments");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { department_slug: "dept-abc", display_name: "研究部" });
  assert.equal(requests[1].url, "https://manager.test/api/manager/org/assignments/employee%2F1");
  assert.equal(requests[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), { department_id: "dept-1" });
  for (const request of requests) {
    assert.equal(new Headers(request.init.headers).get("Authorization"), "Bearer jwt");
    assert.equal(new Headers(request.init.headers).get("Content-Type"), "application/json");
  }
});

test("HttpManagerClient renames, moves and promotes departments, surfacing Manager 422 as a validation error", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return status === 200
      ? Response.json({ data: { id: "d/1", department_slug: "s", display_name: "新", parent_id: null } })
      : Response.json({ status: 422, code: "department_depth_exceeded", detail: "department hierarchy is limited to 5 levels" }, { status: 422 });
  });
  await client.updateDepartment(caller, "d/1", { display_name: "新", parent_id: null });
  await client.promoteDepartment(caller, "d/1", "c-1");
  await client.deleteDepartment(caller, "d/1");
  assert.equal(requests[0].url, "https://manager.test/api/manager/departments/d%2F1");
  assert.equal(requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { display_name: "新", parent_id: null });
  assert.equal(requests[1].url, "https://manager.test/api/manager/departments/d%2F1/promote");
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), { child_id: "c-1" });
  assert.equal(requests[2].url, "https://manager.test/api/manager/departments/d%2F1");
  assert.equal(requests[2].init.method, "DELETE");
  assert.equal(requests[2].init.body, undefined);
  status = 422;
  await assert.rejects(() => client.updateDepartment(caller, "d-1", { parent_id: "x" }), (error) => error instanceof ManagerValidationError && error.code === "department_depth_exceeded" && /limited to 5 levels/.test(error.message));
});

test("HttpManagerClient preserves the safe Manager problem detail for runtime failures", async () => {
  const client = new HttpManagerClient("https://manager.test", async () => Response.json(
    { type: "about:blank", title: "Not Found", status: 404, code: "not_found", detail: "platform model is unavailable" },
    { status: 404 },
  ));
  await assert.rejects(
    () => client.pullRuntimeConfig(caller, "employee-1"),
    /Manager returned HTTP 404 for \/api\/manager\/provider-credentials\/runtime-config: not_found: platform model is unavailable/,
  );
});

test("HttpManagerClient pulls a bounded marketplace catalog from Manager", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    if (String(input).endsWith("/api/manager/skill-market")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ data: [{ template_id: "tpl-1", display_name: "Researcher", category: "research", default_model: "model-1", skill_ids: ["skill-1"], tags: ["analysis"] }] }), { status: 200 });
  });
  const templates = await client.listMarketplaceTemplates(caller);
  assert.deepEqual(templates[0], { template_id: "tpl-1", display_name: "Researcher", category: "research", description: null, platform_skill_refs: null, model_name: "model-1", skills_count: 1, recruit_count: null, is_recruited: false, tags: ["analysis"], avatar_url: null, ...EMPTY_PROFILE });
  assert.equal(request?.url, "https://manager.test/api/manager/recruit/catalog/experts");
  assert.equal(new Headers(request?.init.headers).get("Authorization"), "Bearer jwt");
});

test("marketplace skill counts prefer modern fixed platform refs, including authoritative empty lists", async () => {
  const ref = { skill_id: "skill-1", version: "1", content_hash: "sha256:abc" };
  const client = new HttpManagerClient("https://manager.test", async (input) => String(input).endsWith("/api/manager/skill-market") ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ data: [
    { template_id: "modern", description: "真实描述", platform_skill_refs: [ref, { ...ref, skill_id: "skill-2", private_key: "not-public" }], skill_ids: ["old"], skills_count: 9 },
    { template_id: "empty", platform_skill_refs: [], skill_ids: ["old"] },
    { template_id: "invalid", platform_skill_refs: [null, "not-a-ref", {}, ref] },
  ] }), { status: 200 }));
  const templates = await client.listMarketplaceTemplates(caller);
  assert.deepEqual(templates.map((template) => template.skills_count), [2, 0, 1]);
  assert.equal(templates[0].description, "真实描述");
  // 技能市场不可用时模板照常返回，只是没有展示名。
  const unnamed = { ...ref, display_name: null, summary: null };
  assert.deepEqual(templates[0].platform_skill_refs, [unnamed, { ...unnamed, skill_id: "skill-2" }]);
  assert.deepEqual(templates[1].platform_skill_refs, []);
  assert.deepEqual(templates[2].platform_skill_refs, [unnamed]);
  assert.equal(templates[0].recruit_count, null);
  assert.doesNotMatch(JSON.stringify(templates), /private_key|not-public|usage_stats|price_tier/);
});

test("marketplace skill refs carry display names from the Manager skill market", async () => {
  const ref = { skill_id: "skill-1", version: "1", content_hash: "sha256:abc" };
  const urls: string[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input) => {
    urls.push(String(input));
    if (String(input).endsWith("/api/manager/skill-market")) {
      return new Response(JSON.stringify({ data: [{ skill_id: "skill-1", display_name: " 深度研究 ", summary: " 检索并整理 " }, { skill_id: "skill-2", display_name: "", summary: "只有说明" }, { skill_id: "skill-3", display_name: "" }, { display_name: "no id" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ template_id: "tpl", platform_skill_refs: [ref, { ...ref, skill_id: "skill-2" }] }] }), { status: 200 });
  });
  const [template] = await client.listMarketplaceTemplates(caller);
  assert.deepEqual(template.platform_skill_refs, [{ ...ref, display_name: "深度研究", summary: "检索并整理" }, { ...ref, skill_id: "skill-2", display_name: null, summary: "只有说明" }]);
  assert.deepEqual(urls.sort(), ["https://manager.test/api/manager/recruit/catalog/experts", "https://manager.test/api/manager/skill-market"]);
});

test("marketplace profile fields and tenant stats are projected with per-field shape checks", async () => {
  const client = new HttpManagerClient("https://manager.test", async (input) => String(input).endsWith("/api/manager/skill-market") ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : new Response(JSON.stringify({ data: [
    {
      template_id: "full", version: "3", tagline: " 周报助手 ", use_cases: ["周报", 7], limitations: ["不做财务"], example_prompts: ["写周报"],
      sample_outputs: [{ title: "周报", output_type: "document", preview_url: "https://cdn.test/a.png" }, { title: "坏", output_type: "video" }, { output_type: "code" }],
      output_types: ["document", "document", "video", "code"], required_connectors: ["feishu"], optional_connectors: [], recommended_knowledge: ["产品文档"],
      required_permissions: { full_access: true, local_directories: "yes" }, pricing: { mode: "per_call", unit_price: "0.05", currency: "USD" },
      memory_policy_summary: "只记偏好", publisher: "AI Team", updated_at: "2026-10-30T08:00:00Z", changelog_url: "https://docs.test/changelog",
      stats: { resolution_rate: 0.75, evaluated_segments: 12, resolved_segments: 9, min_sample: 10 },
    },
    { template_id: "bad", pricing: { mode: "free", unit_price: "1", currency: "USD" }, changelog_url: "javascript:alert(1)", updated_at: "not a date", stats: { resolution_rate: 2, evaluated_segments: -1 } },
  ] }), { status: 200 }));
  const [full, bad] = await client.listMarketplaceTemplates(caller);
  assert.equal(full.tagline, "周报助手");
  assert.equal(full.version, "3");
  assert.deepEqual(full.use_cases, ["周报"]);
  assert.deepEqual(full.sample_outputs, [{ title: "周报", output_type: "document", preview_url: "https://cdn.test/a.png" }]);
  assert.deepEqual(full.output_types, ["document", "code"]);
  assert.deepEqual(full.required_permissions, { full_access: true, local_directories: false });
  assert.deepEqual(full.pricing, { mode: "per_call", unit_price: "0.05", currency: "USD" });
  assert.equal(full.updated_at, "2026-10-30T08:00:00.000Z");
  assert.equal(full.changelog_url, "https://docs.test/changelog");
  assert.deepEqual(full.stats, { resolution_rate: 0.75, evaluated_segments: 12, resolved_segments: 9, min_sample: 10 });
  assert.equal(bad.pricing, null);
  assert.equal(bad.changelog_url, null);
  assert.equal(bad.updated_at, null);
  assert.deepEqual(bad.stats, { resolution_rate: null, evaluated_segments: 0, resolved_segments: 0, min_sample: 1 });
});

test("segment outcome counts upload through the usage endpoint with the summary id as idempotency key", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: { usage_ingested: 0, audits_ingested: 0, segment_outcomes_ingested: 1 } }), { status: 200 });
  });
  const summary = { schema_version: "1" as const, summary_id: "seg-1", tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1", window_start: "2026-10-30T02:00:00.000Z", window_end: "2026-10-30T03:00:00.000Z", evaluated_count: 3, resolved_count: 2 };
  await client.uploadSegmentOutcomes(caller, summary);
  assert.equal(requests[0].url, "https://manager.test/api/manager/usage/upload");
  assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "seg-1");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { tenant_id: "tenant-1", usage: [], audits: [], segment_outcomes: [summary] });
});

test("a stalled skill market only delays the marketplace catalog by the short name budget and logs a warning", async (t) => {
  const logged: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  t.mock.method(appLogger, "log", (level: string, event: string, fields: Record<string, unknown> = {}) => { logged.push({ level, event, fields }); });
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    if (String(input).endsWith("/api/manager/skill-market")) {
      // Hang until the client-side budget aborts the request. AbortSignal.timeout() is unref'd,
      // so a ref'd timer keeps the event loop alive while the test waits for it.
      return new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("skill-name budget never fired")), 10_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal!.reason); });
      });
    }
    return new Response(JSON.stringify({ data: [{ template_id: "tpl", platform_skill_refs: [{ skill_id: "skill-1", version: "1", content_hash: "sha256:abc" }] }] }), { status: 200 });
  });
  const started = performance.now();
  const [template] = await client.listMarketplaceTemplates(caller);
  const elapsed = performance.now() - started;
  assert(elapsed < 5_000, `catalog waited ${Math.round(elapsed)}ms for skill names`);
  assert.equal(template.platform_skill_refs?.[0]?.display_name, null);
  const warning = logged.find((entry) => entry.event === "marketplace.skill_names_unavailable");
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.fields.outcome, "timeout");
});

test("a skill market whose body stalls past the name budget is logged as a timeout", async (t) => {
  const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
  t.mock.method(appLogger, "log", (_level: string, event: string, fields: Record<string, unknown> = {}) => { logged.push({ event, fields }); });
  const client = new HttpManagerClient("https://manager.test", async (input, init) => {
    if (String(input).endsWith("/api/manager/skill-market")) {
      // Headers arrive at once; the body never finishes before the budget aborts it.
      const keepAlive = setTimeout(() => undefined, 10_000);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"data\":["));
        init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); controller.error(init.signal!.reason); });
      } });
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ template_id: "tpl", platform_skill_refs: [] }] }), { status: 200 });
  });
  await client.listMarketplaceTemplates(caller);
  assert.equal(logged.find((entry) => entry.event === "marketplace.skill_names_unavailable")?.fields.outcome, "timeout");
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
  assert.equal(new Headers(request?.init.headers).get("Authorization"), "Bearer jwt");
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
  assert.equal(new Headers(request?.init.headers).get("Authorization"), "Bearer jwt");
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
  assert.equal(new Headers(request?.init.headers).get("Authorization"), "Bearer jwt");
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
