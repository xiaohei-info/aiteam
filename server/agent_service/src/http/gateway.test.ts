import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionAuthorizationRegistry } from "../execution-authorization.js";
import type { DirectoryHost } from "../local-directory-host.js";
import { normalizeAuthorizedConfig, type ManagerClient } from "../manager-client.js";
import { SessionHost } from "../pi/session-host.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { GatewayLocalContext, parsePlan, rulePlan } from "../services/gateway-local-context.js";
import { LocalDirectoryService } from "../services/local-directories.js";
import { createFixture } from "../test-fixture.js";
import { createJwtAuthenticator, type JwtJwk } from "./auth.js";
import { isGatewayHandledRoute, mergeOpenApiDocuments } from "./gateway-routes.js";
import { AgentHttpServer } from "./server.js";
import { parseUpstreamOrigin, UpstreamGateway } from "./upstream-gateway.js";

interface Recorded { method: string; url: string; headers: IncomingMessage["headers"]; body: string }
type UpstreamHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

/** Fake upstream Agent: records every request and answers from per-route handlers. */
async function fakeUpstream() {
  const requests: Recorded[] = [];
  const handlers = new Map<string, UpstreamHandler>();
  const closed: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "/";
      requests.push({ method: request.method ?? "GET", url, headers: request.headers, body });
      response.once("close", () => closed.push(url));
      const handler = handlers.get(`${request.method} ${url.split("?")[0]}`);
      if (handler) return handler(request, response, body);
      response.writeHead(404, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const json = (status: number, body: unknown): UpstreamHandler => (_request, response) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-internal-secret": "do-not-forward" });
    response.end(JSON.stringify(body));
  };
  return {
    origin: `http://127.0.0.1:${address.port}`, requests, handlers, closed, json,
    find: (method: string, url: string) => requests.filter((item) => item.method === method && item.url.split("?")[0] === url),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function setup(options: { upstreamOrigin?: string } = {}) {
  const fixture = await createFixture();
  const upstream = await fakeUpstream();
  const identities = new ExecutionAuthorizationRegistry();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" } as JwtJwk;
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encoded({ alg: "RS256", kid: "test" })}.${encoded({ tenant_id: "tenant-1", enterprise_id: "enterprise-1", user_id: "member-1", roles: ["member"], iss: "test", aud: "agent", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const authenticate = createJwtAuthenticator({ jwks: { keys: [jwk] }, issuer: "test", audience: "agent" });
  const files: Record<string, { entries: { name: string; directory: boolean }[] }> = {
    "": { entries: [{ name: "CYCPLUS_Mix", directory: true }, { name: "notes.md", directory: false }] },
    "CYCPLUS_Mix": { entries: [{ name: "readme.txt", directory: false }, { name: "mix.json", directory: false }] },
  };
  const texts: Record<string, string> = {
    "notes.md": "unrelated meeting notes",
    "CYCPLUS_Mix/readme.txt": "CYCPLUS_Mix 混音工程说明：采样率 48k，主轨道在 mix.json。",
    "CYCPLUS_Mix/mix.json": "{\"tracks\": 12}",
  };
  const native: DirectoryHost = {
    status: async () => undefined,
    challenge: async () => "challenge-1",
    consume: async () => ({ canonical_path: "/private/test/kb", display_name: "资料", root_identity: "1:99" }),
    check: async () => "epoch:1",
    list: async (_resource, path) => ({ authority: "epoch:1", entries: files[path]?.entries ?? [], partial: false }),
    read: async (_resource, path) => ({ authority: "epoch:1", content_version: `v:${path}`, text: texts[path] ?? "" }),
  };
  const service = new LocalDirectoryService(fixture.store, native, identities);
  const host = new SessionHost({
    cwdRoot: join(fixture.root, "gw-workspaces"), agentDir: join(fixture.root, "gw-pi"), sessionDir: join(fixture.root, "gw-sessions"),
    store: fixture.store, modelRuntime: fixture.modelRuntime, model: fixture.faux.getModel(), executionAuthorization: identities, localDirectoryService: service,
    resourceLoaderFactory: () => createControlledResourceLoader("test"),
  });
  const config = normalizeAuthorizedConfig({
    experts: [{ employee_id: "emp-1", version: "1", display_name: "员工" }],
    snapshots: [{ employee_id: "emp-1", version: "1", snapshot_version: "snap-1", display_name: "员工", tools: ["knowledge_search", "knowledge_get"], knowledge_policy: { state: "allow", allowed_operations: ["knowledge_search", "knowledge_get"], revision: "1" } }],
  }, "tenant-1", "member-1");
  fixture.store.replaceProjections(config.experts, [], config.snapshots!, [], { tenantId: "tenant-1", memberId: "member-1" });
  const managerClient = { pullAuthorizedConfig: async () => config, getOrgTree: async () => ({}) } as unknown as ManagerClient;
  const gateway = new UpstreamGateway(options.upstreamOrigin ?? upstream.origin, { headersTimeoutMs: 5_000 });
  const server = new AgentHttpServer({
    host, store: fixture.store, authenticate, executionAuthorization: identities, managerClient,
    allowedOrigins: ["http://tauri.localhost"], upstream: gateway, localContext: new GatewayLocalContext(service),
  });
  await server.listen(0);
  const address = server.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) => fetch(`${base}${path}`, {
    method: init.method ?? "GET", signal: init.signal,
    headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const bindDirectory = async () => {
    const registered = await (await request("/api/agent/local-directories", { method: "POST", body: { ticket: "ticket" } })).json() as { data: { directory_id: string } };
    const bound = await request(`/api/agent/local-directories/${registered.data.directory_id}/bindings/emp-1`, { method: "PUT", body: { enabled: true, expected_revision: 0 } });
    assert.equal(bound.status, 200, await bound.text());
  };
  const privateConversation = (id: string, kind = "private") => {
    upstream.handlers.set(`GET /api/agent/conversations/${id}`, upstream.json(200, { data: { id, kind, entry_employee_id: kind === "group" ? null : "emp-1" } }));
    upstream.handlers.set(`POST /api/agent/conversations/${id}/prompt`, (request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { conversation_id: id, accepted: true, state: "accepted", idempotency_key: request.headers["idempotency-key"] } }));
    });
  };
  return {
    upstream, request, bindDirectory, privateConversation, token,
    async close() { await server.close(); await upstream.close(); await host.dispose(); await fixture.close(); },
  };
}

test("upstream origin parsing accepts only a bare http(s) origin", () => {
  assert.equal(parseUpstreamOrigin(undefined), undefined);
  assert.equal(parseUpstreamOrigin("  "), undefined);
  assert.equal(parseUpstreamOrigin("http://121.40.78.201:8783"), "http://121.40.78.201:8783");
  assert.equal(parseUpstreamOrigin("https://agent.example.com/"), "https://agent.example.com");
  for (const bad of ["ftp://x", "http://u:p@x", "http://x/api", "http://x/?a=1", "http://x/#f", "not a url"]) {
    assert.throws(() => parseUpstreamOrigin(bad), /AITEAM_AGENT_UPSTREAM_URL/u, bad);
  }
});

test("gateway route split keeps identity, grants, prompt and local directories local", () => {
  for (const [method, url] of [
    ["GET", "/api/agent/whoami"], ["POST", "/api/agent/grants/sync"], ["GET", "/api/agent/grants/readiness"],
    ["POST", "/api/agent/conversations/:conversation_id/prompt"], ["POST", "/api/agent/logout"],
    ["GET", "/api/agent/local-directories"], ["PUT", "/api/agent/local-directories/:directory_id/bindings/:employee_id"],
    ["POST", "/api/agent/local-directory-citations/:citation_id/verify"], ["GET", "/healthz"], ["GET", "/openapi.json"], ["GET", undefined],
  ] as const) assert.equal(isGatewayHandledRoute(method, url), true, `${method} ${url}`);
  for (const [method, url] of [
    ["GET", "/api/agent/conversations"], ["GET", "/api/agent/conversations/:conversation_id/events"], ["POST", "/api/agent/login"],
    ["GET", "/api/agent/grants/experts"], ["HEAD", "/api/agent/conversations/:conversation_id"], ["POST", "/api/agent/conversations/:conversation_id/attachments"],
  ] as const) assert.equal(isGatewayHandledRoute(method, url), false, `${method} ${url}`);
});

test("OpenAPI merge keeps local definitions for local paths and local-only paths", () => {
  const merged = mergeOpenApiDocuments(
    { openapi: "3.1.0", paths: { "/api/agent/whoami": { get: "local" }, "/api/agent/local-directories": { get: "local" }, "/api/agent/conversations": { get: "local" }, "/api/agent/usage/statistics": { get: "local" } }, components: { schemas: { A: 1, B: 1 } } },
    { openapi: "3.1.0", info: { title: "up" }, paths: { "/api/agent/whoami": { get: "up" }, "/api/agent/conversations": { get: "up" }, "/api/agent/new": { get: "up" } }, components: { schemas: { B: 2, C: 2 } } },
  );
  assert.deepEqual(merged.paths, {
    "/api/agent/whoami": { get: "local" }, "/api/agent/conversations": { get: "up" }, "/api/agent/new": { get: "up" },
    "/api/agent/local-directories": { get: "local" }, "/api/agent/usage/statistics": { get: "local" },
  });
  assert.deepEqual(merged.components, { schemas: { A: 1, B: 2, C: 2 } });
  assert.deepEqual(merged.info, { title: "up" });
});

test("rule planner extracts identifiers, quoted phrases, directory names and list intent", () => {
  assert.deepEqual(rulePlan("帮我看看 CYCPLUS_Mix 的采样率"), { action: "search", terms: ["CYCPLUS_Mix"], source: "rules" });
  assert.deepEqual(rulePlan("“混音工程”在哪里说明了", ["资料"]), { action: "search", terms: ["混音工程"], source: "rules" });
  assert.deepEqual(rulePlan("资料里提到预算了吗", ["资料"]), { action: "search", terms: ["资料"], source: "rules" });
  assert.deepEqual(rulePlan("CYCPLUS_Mix 目录下有什么文件"), { action: "list", terms: [], directory: "CYCPLUS_Mix", source: "rules" });
  assert.deepEqual(rulePlan("列出授权目录"), { action: "list", terms: [], source: "rules" });
  assert.equal(rulePlan("你好，今天怎么样"), undefined);
});

test("planner output parsing validates shape and falls back on anything malformed", () => {
  assert.deepEqual(parsePlan('好的：{"action":"search","terms":["采样率","sample rate","采样率"]}'), { action: "search", terms: ["采样率", "sample rate"], source: "model" });
  assert.deepEqual(parsePlan('{"action":"list","directory":"CYCPLUS_Mix","path":"stems"}'), { action: "list", terms: [], directory: "CYCPLUS_Mix", path: "stems", source: "model" });
  assert.deepEqual(parsePlan('{"action":"none"}'), { action: "none", terms: [], source: "model" });
  for (const bad of ["", "not json", '{"action":"delete"}', '{"action":"search","terms":[]}', '{"action":"search","terms":[1,2]}', "[1]"]) assert.equal(parsePlan(bad), undefined, bad);
});

test("gateway streams non-local routes upstream with the caller's bearer and filtered headers", async () => {
  const f = await setup();
  try {
    f.upstream.handlers.set("GET /api/agent/conversations", f.upstream.json(200, { data: [{ id: "remote-1" }], page: { has_more: false } }));
    const response = await f.request("/api/agent/conversations?limit=5", { headers: { "X-Request-ID": "req-1", Cookie: "session=1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: "remote-1" }], page: { has_more: false } });
    assert.equal(response.headers.get("x-aiteam-origin"), "upstream");
    assert.equal(response.headers.get("x-internal-secret"), null);
    const [seen] = f.upstream.find("GET", "/api/agent/conversations");
    assert.equal(seen!.url, "/api/agent/conversations?limit=5");
    assert.equal(seen!.headers.authorization, `Bearer ${f.token}`);
    assert.equal(seen!.headers["x-request-id"], "req-1");
    assert.equal(seen!.headers.cookie, undefined);
    // CORS headers set by the local hooks survive the upstream writeHead, and gateway headers are readable.
    const cors = await f.request("/api/agent/conversations", { headers: { Origin: "http://tauri.localhost" } });
    assert.equal(cors.headers.get("access-control-allow-origin"), "http://tauri.localhost");
    assert.match(cors.headers.get("access-control-expose-headers")!, /X-Aiteam-Origin, X-Aiteam-Local-Context, X-Aiteam-Upstream/u);
    assert.equal(f.upstream.find("GET", "/api/agent/conversations").at(-1)!.headers.origin, undefined, "the WebView origin is not forwarded");

    const local = await f.request("/api/agent/whoami");
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("x-aiteam-origin"), "local");
    assert.equal(f.upstream.find("GET", "/api/agent/whoami").length, 0);
    // Unregistered paths stay local (404), the gateway is not an open proxy.
    assert.equal((await f.request("/api/agent/not-a-route")).status, 404);
    assert.equal((await f.request("/api/agent/conversations/x/../../../etc")).status, 404);
    assert.equal(f.upstream.requests.some((item) => item.url.includes("not-a-route") || item.url.includes("etc")), false);
  } finally { await f.close(); }
});

test("gateway forwards SSE without buffering and tears the upstream stream down with the client", { timeout: 10_000 }, async () => {
  const f = await setup();
  try {
    f.upstream.handlers.set("GET /api/agent/conversations/c-sse/events", (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("event: hello\ndata: {}\n\n");
    });
    const controller = new AbortController();
    const response = await f.request("/api/agent/conversations/c-sse/events", { signal: controller.signal, headers: { "Last-Event-ID": "7" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/u);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: hello/u);
    assert.equal(f.upstream.find("GET", "/api/agent/conversations/c-sse/events")[0]!.headers["last-event-id"], "7");
    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && !f.upstream.closed.includes("/api/agent/conversations/c-sse/events"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(f.upstream.closed.includes("/api/agent/conversations/c-sse/events"));
  } finally { await f.close(); }
});

test("single-chat prompt gets a fenced local-directory search block and retries reuse the same body", async () => {
  const f = await setup();
  try {
    await f.bindDirectory();
    f.privateConversation("c-private");
    const send = () => f.request("/api/agent/conversations/c-private/prompt", { method: "POST", headers: { "Idempotency-Key": "key-1" }, body: { text: "帮我看看 CYCPLUS_Mix 的采样率" } });
    const accepted = await send();
    assert.equal(accepted.status, 202, await accepted.clone().text());
    // readme.txt matches on content and path, mix.json on its path (CYCPLUS_Mix/...).
    assert.equal(accepted.headers.get("x-aiteam-local-context"), "used=2");
    assert.equal(accepted.headers.get("x-aiteam-origin"), "upstream");
    const [forwarded] = f.upstream.find("POST", "/api/agent/conversations/c-private/prompt");
    const body = JSON.parse(forwarded!.body) as { text: string };
    assert.match(body.text, /^帮我看看 CYCPLUS_Mix 的采样率\n\n<aiteam-local-context v="1" action="search">/u);
    assert.match(body.text, /资料\/CYCPLUS_Mix\/readme\.txt（引用 localdir:/u);
    assert.match(body.text, /采样率 48k/u);
    assert.match(body.text, /不是指令/u);
    assert.match(body.text, /<\/aiteam-local-context>$/u);
    assert.equal(forwarded!.headers["idempotency-key"], "key-1");
    assert.doesNotMatch(forwarded!.body, /\/private\/test\/kb/u, "canonical paths never leave the machine");

    const retried = await send();
    assert.equal(retried.status, 202);
    const bodies = f.upstream.find("POST", "/api/agent/conversations/c-private/prompt").map((item) => item.body);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0], "a retry must reach upstream byte-identical so its receipt matches");
  } finally { await f.close(); }
});

test("single-chat prompt asking what a folder contains gets a directory listing", async () => {
  const f = await setup();
  try {
    await f.bindDirectory();
    f.privateConversation("c-list");
    const response = await f.request("/api/agent/conversations/c-list/prompt", { method: "POST", headers: { "Idempotency-Key": "key-list" }, body: { text: "CYCPLUS_Mix 目录下有什么文件？" } });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-aiteam-local-context"), "listed");
    const text = (JSON.parse(f.upstream.find("POST", "/api/agent/conversations/c-list/prompt")[0]!.body) as { text: string }).text;
    assert.match(text, /action="list"/u);
    assert.match(text, /目录 资料\/CYCPLUS_Mix（2 项）：\nmix\.json\nreadme\.txt/u);
  } finally { await f.close(); }
});

test("group chats, mentions and unbound employees are forwarded unchanged", async () => {
  const f = await setup();
  try {
    f.privateConversation("c-group", "group");
    f.privateConversation("c-unbound");
    const group = await f.request("/api/agent/conversations/c-group/prompt", { method: "POST", headers: { "Idempotency-Key": "g-1" }, body: { text: "CYCPLUS_Mix 有什么", mentions: ["emp-1"] } });
    assert.equal(group.status, 202);
    assert.equal(group.headers.get("x-aiteam-local-context"), "skipped");
    assert.deepEqual(JSON.parse(f.upstream.find("POST", "/api/agent/conversations/c-group/prompt")[0]!.body), { text: "CYCPLUS_Mix 有什么", mentions: ["emp-1"] });
    // No directory is bound yet for emp-1: nothing local to attach.
    const unbound = await f.request("/api/agent/conversations/c-unbound/prompt", { method: "POST", headers: { "Idempotency-Key": "u-1" }, body: { text: "CYCPLUS_Mix 采样率" } });
    assert.equal(unbound.status, 202);
    assert.equal(unbound.headers.get("x-aiteam-local-context"), "skipped");
    assert.deepEqual(JSON.parse(f.upstream.find("POST", "/api/agent/conversations/c-unbound/prompt")[0]!.body), { text: "CYCPLUS_Mix 采样率" });
  } finally { await f.close(); }
});

test("a retry whose prepared body is gone is answered from the upstream receipt instead of being replayed", async () => {
  const f = await setup();
  try {
    await f.bindDirectory();
    f.privateConversation("c-receipt");
    f.upstream.handlers.set("GET /api/agent/conversations/c-receipt/receipts/key-old", f.upstream.json(200, { data: { state: "completed" } }));
    f.upstream.handlers.set("GET /api/agent/conversations/c-receipt/receipts/key-unknown", f.upstream.json(200, { data: { state: "unknown" } }));
    const completed = await f.request("/api/agent/conversations/c-receipt/prompt", { method: "POST", headers: { "Idempotency-Key": "key-old" }, body: { text: "CYCPLUS_Mix 采样率" } });
    assert.equal(completed.status, 202);
    assert.deepEqual(await completed.json(), { data: { conversation_id: "c-receipt", accepted: true, state: "completed", idempotency_key: "key-old" } });
    const unknown = await f.request("/api/agent/conversations/c-receipt/prompt", { method: "POST", headers: { "Idempotency-Key": "key-unknown" }, body: { text: "CYCPLUS_Mix 采样率" } });
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json() as { code: string }).code, "idempotency_unknown");
    assert.equal(f.upstream.find("POST", "/api/agent/conversations/c-receipt/prompt").length, 0);
  } finally { await f.close(); }
});

test("grants sync updates both projections; logout clears locally and is forwarded", async () => {
  const f = await setup();
  try {
    f.upstream.handlers.set("POST /api/agent/grants/sync", f.upstream.json(200, { data: { ok: true, upserted: 1, revoked: 0 } }));
    f.upstream.handlers.set("POST /api/agent/logout", f.upstream.json(200, { data: { signed_out: true } }));
    const body = { tenant_id: "tenant-1", member_id: "member-1", known_versions: {} };
    const synced = await f.request("/api/agent/grants/sync", { method: "POST", body });
    assert.equal(synced.status, 200, await synced.clone().text());
    assert.equal(synced.headers.get("x-aiteam-upstream"), "synced");
    assert.equal(((await synced.json()) as { data: { ok: boolean } }).data.ok, true);
    assert.deepEqual(JSON.parse(f.upstream.find("POST", "/api/agent/grants/sync")[0]!.body), body);

    const logout = await f.request("/api/agent/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get("x-aiteam-origin"), "upstream");
    assert.equal(f.upstream.find("POST", "/api/agent/logout")[0]!.headers.authorization, `Bearer ${f.token}`);
  } finally { await f.close(); }
});

test("an unreachable upstream yields 502 for forwarded routes but keeps local routes, docs and logout working", async () => {
  const dead = await fakeUpstream();
  const origin = dead.origin;
  await dead.close();
  const f = await setup({ upstreamOrigin: origin });
  try {
    const forwarded = await f.request("/api/agent/conversations");
    assert.equal(forwarded.status, 502);
    assert.equal((await forwarded.json() as { code: string }).code, "upstream_unavailable");
    assert.equal((await f.request("/api/agent/whoami")).status, 200);
    const docs = await f.request("/openapi.json");
    assert.equal(docs.status, 200);
    assert.equal(docs.headers.get("x-aiteam-upstream"), "unavailable");
    const document = await docs.json() as { paths: Record<string, unknown> };
    assert.ok(document.paths["/api/agent/local-directories"]);
    assert.ok(document.paths["/api/agent/conversations/{conversation_id}/participants"], "host startup contract paths stay documented");
    const logout = await f.request("/api/agent/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get("x-aiteam-upstream"), "unavailable");
  } finally { await f.close(); }
});

test("gateway OpenAPI merges the upstream contract with local definitions", async () => {
  const f = await setup();
  try {
    f.upstream.handlers.set("GET /openapi.json", f.upstream.json(200, { openapi: "3.1.0", info: { title: "upstream", version: "9" }, paths: { "/api/agent/upstream-only": { get: { operationId: "upstreamOnly" } }, "/api/agent/whoami": { get: { operationId: "upstreamWhoami" } } }, components: {} }));
    const response = await f.request("/openapi.json");
    assert.equal(response.headers.get("x-aiteam-upstream"), "ok");
    const document = await response.json() as { info: { title: string }; paths: Record<string, { get?: { operationId?: string } }> };
    assert.equal(document.info.title, "upstream");
    assert.equal(document.paths["/api/agent/upstream-only"]!.get!.operationId, "upstreamOnly");
    assert.equal(document.paths["/api/agent/whoami"]!.get!.operationId, "whoami");
    assert.ok(document.paths["/api/agent/local-directories"]);
  } finally { await f.close(); }
});
