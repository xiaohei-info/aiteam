import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerHeaders, McpAuthService, McpCredentialStore, probeMcpAuth, validBearerHeader } from "./mcp-auth.js";
import { createFixture } from "./test-fixture.js";
import { capabilityInstallTool, installMcpDirectly, listMcpTools, McpInstallError, personalConnectorTools, updateMcpToken, verifyMcpBearer } from "./connectors.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function rpc(res: ServerResponse, message: { id?: unknown; method?: string }, echo = "ok") {
  if (message.id === undefined) { res.writeHead(202); res.end(); return; }
  const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }
    : message.method === "tools/list" ? { tools: [{ name: "activity_summary", description: "s", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: echo }] };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

/**
 * A local stand-in for an authenticated MCP: `mode=oauth` speaks standard MCP OAuth (401 challenge, protected-resource
 * and authorization-server metadata, dynamic registration, PKCE code exchange, refresh); `mode=bearer` wants a fixed
 * token in `header`.
 */
async function authServer(mode: "oauth" | "bearer" | "open", options: { token?: string; header?: string; expiresIn?: number; rejectRefresh?: boolean; echoCredential?: boolean } = {}) {
  const issued = new Set<string>();
  const seen = { registrations: 0, tokenRequests: [] as URLSearchParams[], authHeaders: [] as string[] };
  let base = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp" && mode === "oauth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["profile.read"] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server" && mode === "oauth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/register") {
      seen.registrations += 1;
      const meta = JSON.parse(await body(req));
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...meta, client_id: `client-${seen.registrations}` }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await body(req));
      seen.tokenRequests.push(form);
      if (options.rejectRefresh && form.get("grant_type") === "refresh_token") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }));
        return;
      }
      const access = `access-${seen.tokenRequests.length}`;
      issued.add(access);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: access, token_type: "Bearer", refresh_token: `refresh-${seen.tokenRequests.length}`, expires_in: options.expiresIn ?? 3600 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      const message = JSON.parse(await body(req));
      if (mode === "open") return rpc(res, message);
      const headerName = (options.header ?? "authorization").toLowerCase();
      const value = String(req.headers[headerName] ?? "");
      seen.authHeaders.push(value);
      const ok = mode === "bearer"
        ? value === (headerName === "authorization" ? `Bearer ${options.token}` : options.token)
        : value.startsWith("Bearer ") && issued.has(value.slice(7));
      if (!ok) {
        res.writeHead(401, mode === "oauth" ? { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="profile.read"` } : {});
        res.end();
        return;
      }
      // A careless server that echoes the credential back in a tool result.
      return rpc(res, message, options.echoCredential ? `you sent ${value}` : "ok");
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  return { server, base, url: `${base}/mcp`, seen, issued };
}

function service(dataRoot: string, opened: string[] = [], loginTtlMs?: number) {
  const auth = new McpAuthService(new McpCredentialStore(dataRoot), { openBrowser: (url) => opened.push(url), ...(loginTtlMs ? { loginTtlMs } : {}) });
  auth.setCallbackBase("http://127.0.0.1:45999");
  return auth;
}

test("credentials are encrypted at rest, private to the member and bound to the MCP address", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cred-"));
  const store = new McpCredentialStore(root);
  store.put(owner, "crm", { url: "https://crm.example.com/mcp", auth: "bearer", token: "secret-token-123", header: "X-API-Key" });
  assert.deepEqual(store.get(owner, "crm", "https://crm.example.com/mcp"), { url: "https://crm.example.com/mcp", auth: "bearer", token: "secret-token-123", header: "X-API-Key" });
  // Same origin + path still matches (no query is ever part of an MCP URL).
  assert.equal(store.get(owner, "crm", "https://crm.example.com/mcp")?.token, "secret-token-123");
  // A different address, member or tenant never receives it.
  assert.equal(store.get(owner, "crm", "https://evil.example.com/mcp"), undefined);
  assert.equal(store.get(owner, "crm", "https://crm.example.com/other"), undefined);
  assert.equal(store.get({ ...owner, memberId: "member-2" }, "crm", "https://crm.example.com/mcp"), undefined);
  assert.equal(store.get({ ...owner, tenantId: "tenant-2" }, "crm", "https://crm.example.com/mcp"), undefined);

  const files = readdirSync(join(root, "mcp-credentials"));
  assert.equal(files.length, 1);
  const raw = readFileSync(join(root, "mcp-credentials", files[0]!), "utf8");
  assert(!raw.includes("secret-token-123") && !raw.includes("crm.example.com"), "credential file must not hold plaintext");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "mcp-credentials")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "mcp-credentials", files[0]!)).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "mcp-credentials.key")).mode & 0o777, 0o600);
  }
  // A new store instance (Agent restart) reads it with the same key file.
  assert.equal(new McpCredentialStore(root).get(owner, "crm", "https://crm.example.com/mcp")?.token, "secret-token-123");

  // Tampering makes it unreadable rather than trusted.
  const box = JSON.parse(raw);
  box.data = Buffer.from("x".repeat(40)).toString("base64");
  writeFileSync(join(root, "mcp-credentials", files[0]!), JSON.stringify(box));
  assert.equal(new McpCredentialStore(root).get(owner, "crm", "https://crm.example.com/mcp"), undefined);

  store.delete(owner, "crm");
  assert.deepEqual(readdirSync(join(root, "mcp-credentials")), []);
});

test("bearer headers default to Authorization: Bearer and refuse headers that would break the transport", () => {
  assert.deepEqual(bearerHeaders({ token: "t" }), { Authorization: "Bearer t" });
  assert.deepEqual(bearerHeaders({ token: "t", header: "authorization" }), { Authorization: "Bearer t" });
  assert.deepEqual(bearerHeaders({ token: "t", header: "X-API-Key" }), { "X-API-Key": "t" });
  for (const ok of [undefined, "", "X-API-Key", "Authorization"]) assert.equal(validBearerHeader(ok), true, String(ok));
  for (const bad of ["Host", "content-type", "Cookie", "Mcp-Session-Id", "X Key", "x:y", "a".repeat(65)]) assert.equal(validBearerHeader(bad), false, bad);
});

test("probing tells none, browser sign-in and access token apart without sending any credential", async () => {
  const open = await authServer("open");
  const oauth = await authServer("oauth");
  const bearer = await authServer("bearer", { token: "t" });
  const broken = createServer((_req, res) => { res.writeHead(500); res.end(); });
  await new Promise<void>(resolve => broken.listen(0, "127.0.0.1", resolve));
  const brokenAddress = broken.address(); assert(brokenAddress && typeof brokenAddress !== "string");
  try {
    assert.deepEqual(await probeMcpAuth(open.url), { auth: "none" });
    const probe = await probeMcpAuth(oauth.url);
    assert.equal(probe.auth, "oauth");
    assert.equal(probe.auth_host, new URL(oauth.base).host);
    assert.equal(probe.scope, "profile.read");
    assert.equal(oauth.seen.registrations, 0, "probing must not register a client");
    assert.deepEqual(await probeMcpAuth(bearer.url), { auth: "bearer" });
    assert.deepEqual(bearer.seen.authHeaders, [""], "probe sends no credential");
    await assert.rejects(probeMcpAuth(`http://127.0.0.1:${brokenAddress.port}/mcp`));
  } finally {
    for (const server of [open.server, oauth.server, bearer.server, broken]) server.close();
  }
});

test("browser sign-in: one-time state, PKCE code exchange, tokens kept locally, refresh without the browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  const oauth = await authServer("oauth", { expiresIn: 3600 });
  const opened: string[] = [];
  const auth = service(root, opened);
  try {
    const { login, done } = await auth.login(owner, "cr-test", oauth.url, { scope: "profile.read" });
    assert(login, "sign-in is needed");
    assert.equal(login.status, "pending");
    assert.equal(login.auth_host, new URL(oauth.base).host);
    assert.deepEqual(opened, [login.authorization_url], "the member's browser is opened once");
    const authorize = new URL(login.authorization_url);
    assert.equal(authorize.origin + authorize.pathname, `${oauth.base}/authorize`);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:45999/api/agent/mcp-auth/callback");
    assert.equal(authorize.searchParams.get("client_id"), "client-1");
    assert.equal(oauth.seen.registrations, 1, "dynamic registration as AI Team");
    const state = authorize.searchParams.get("state")!;
    assert(state.length >= 40, "state is long and random");
    // The login view never carries the state's secret parts beyond the provider URL, nor any token.
    assert.equal(JSON.stringify(auth.status(owner, "cr-test", oauth.url, "oauth")), JSON.stringify({ auth_status: "needs_login", auth_expires_at: null }));

    // A wrong state is ignored and leaves the sign-in pending.
    assert.equal(await auth.callback({ state: "forged", code: "c" }), false);
    assert.equal(auth.get(owner, login.login_id)?.status, "pending");
    // Another member cannot read or cancel it.
    assert.equal(auth.get({ ...owner, memberId: "member-2" }, login.login_id), undefined);
    assert.equal(auth.cancel({ ...owner, memberId: "member-2" }, login.login_id), false);

    assert.equal(await auth.callback({ state, code: "auth-code-1" }), true);
    await done;
    assert.equal(auth.get(owner, login.login_id)?.status, "completed");
    const exchange = oauth.seen.tokenRequests[0]!;
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("code"), "auth-code-1");
    assert(exchange.get("code_verifier"), "PKCE verifier sent");
    // The state is single use.
    assert.equal(await auth.callback({ state, code: "auth-code-1" }), false);

    const status = auth.status(owner, "cr-test", oauth.url, "oauth");
    assert.equal(status.auth_status, "signed_in");
    assert(status.auth_expires_at && Date.parse(status.auth_expires_at) > Date.now());
    // The provider used for calls carries the token; the tool list comes back.
    assert.deepEqual(await listMcpTools({ url: oauth.url, authProvider: auth.provider(owner, "cr-test", oauth.url) }), ["activity_summary"]);

    // Signing in again with usable tokens does not open the browser.
    const again = await auth.login(owner, "cr-test", oauth.url, {});
    assert.equal(again.login, undefined);
    assert.equal(opened.length, 1);

    // An expired access token is refreshed silently on the next call.
    const store = auth.credentials;
    store.update(owner, "cr-test", oauth.url, (current) => current && { ...current, obtained_at: Date.now() - 7_200_000 });
    oauth.issued.clear();
    assert.deepEqual(await listMcpTools({ url: oauth.url, authProvider: auth.provider(owner, "cr-test", oauth.url) }), ["activity_summary"]);
    assert.equal(oauth.seen.tokenRequests.at(-1)?.get("grant_type"), "refresh_token");
    assert.equal(opened.length, 1, "refresh never opens the browser");
  } finally {
    oauth.server.close();
  }
});

test("a sign-in can be denied, cancelled or time out, and a newer one replaces an older one", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  const oauth = await authServer("oauth");
  const opened: string[] = [];
  const auth = service(root, opened, 200);
  try {
    const first = await auth.login(owner, "cr-test", oauth.url, {});
    const second = await auth.login(owner, "cr-test", oauth.url, {});
    await assert.rejects(first.done, { reason: "cancelled" });
    assert.equal(auth.get(owner, first.login!.login_id)?.error, "cancelled");

    const state = new URL(second.login!.authorization_url).searchParams.get("state");
    assert.equal(await auth.callback({ state, error: "access_denied" }), false);
    await assert.rejects(second.done, { reason: "denied" });

    const third = await auth.login(owner, "cr-test", oauth.url, {});
    // Reopening opens the stored page again, only for the owner and only while pending.
    const before = opened.length;
    assert.equal(auth.reopen({ ...owner, memberId: "member-2" }, third.login!.login_id), false);
    assert.equal(auth.reopen(owner, third.login!.login_id), true);
    assert.deepEqual(opened.slice(before), [third.login!.authorization_url]);
    assert.equal(auth.cancel(owner, third.login!.login_id), true);
    assert.equal(auth.reopen(owner, third.login!.login_id), false, "a finished sign-in is not reopened");
    await assert.rejects(third.done, { reason: "cancelled" });

    const fourth = await auth.login(owner, "cr-test", oauth.url, {});
    await assert.rejects(fourth.done, { reason: "timeout" });
    assert.equal(auth.get(owner, fourth.login!.login_id)?.status, "failed");
  } finally {
    oauth.server.close();
  }
});

test("a call that needs a new sign-in fails with a hint instead of opening the browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  const oauth = await authServer("oauth");
  const opened: string[] = [];
  const auth = service(root, opened);
  try {
    await assert.rejects(listMcpTools({ url: oauth.url, authProvider: auth.provider(owner, "cr-test", oauth.url) }));
    assert.deepEqual(opened, []);
  } finally {
    oauth.server.close();
  }
});

test("the desktop «添加 MCP» installs browser-sign-in MCPs after the callback and keeps bearer tokens only after the server accepts them", async () => {
  const fixture = await createFixture();
  const root = mkdtempSync(join(tmpdir(), "mcp-add-"));
  const oauth = await authServer("oauth");
  const bearer = await authServer("bearer", { token: "good-token", header: "X-API-Key" });
  const auth = service(root);
  const runtime = { service: auth };
  try {
    const pending = await installMcpDirectly(fixture.store, owner, runtime, { ref: "cr-test", url: oauth.url, display_name: "Cycplus", timeout_ms: 45_000 });
    assert(pending.login && !pending.capability, "browser sign-in comes first");
    assert.equal(fixture.store.listLocalCapabilities("tenant-1", "member-1").length, 0, "nothing is installed before sign-in");
    const state = new URL(pending.login.authorization_url).searchParams.get("state");
    assert.equal(await auth.callback({ state, code: "c1" }), true);
    const installed = fixture.store.listLocalCapabilities("tenant-1", "member-1").find(item => item.ref === "cr-test");
    assert(installed);
    assert.equal(installed.auth, "oauth");
    assert.equal(installed.source, "user_url");
    assert.equal(installed.timeout_ms, 45_000);
    assert.deepEqual(installed.tools, ["activity_summary"]);
    assert(!JSON.stringify(installed).includes("access-"), "the capability row never holds a token");

    // Bearer: a missing or rejected token is not installed.
    await assert.rejects(installMcpDirectly(fixture.store, owner, runtime, { ref: "crm", url: bearer.url }), McpInstallError);
    await assert.rejects(installMcpDirectly(fixture.store, owner, runtime, { ref: "crm", url: bearer.url, credential: { token: "bad", header: "X-API-Key" } }), McpInstallError);
    assert.equal(auth.credentials.get(owner, "crm", bearer.url), undefined);
    const added = await installMcpDirectly(fixture.store, owner, runtime, { ref: "crm", url: bearer.url, credential: { token: "good-token", header: "X-API-Key" } });
    assert.equal(added.capability?.auth, "bearer");
    assert.equal(added.capability?.auth_header, "X-API-Key");
    assert.equal(auth.status(owner, "crm", bearer.url, "bearer").auth_status, "token_set");

    // Updating the token checks it first; a rejected token leaves the old one.
    await assert.rejects(updateMcpToken(fixture.store, owner, runtime, "crm", { token: "wrong" }), McpInstallError);
    assert.equal(auth.credentials.get(owner, "crm", bearer.url)?.token, "good-token");
    await verifyMcpBearer(bearer.url, { token: "good-token", header: "X-API-Key" });
    await assert.rejects(verifyMcpBearer(bearer.url, { token: "nope", header: "X-API-Key" }), McpInstallError);
    // Same name again needs explicit replace.
    await assert.rejects(installMcpDirectly(fixture.store, owner, runtime, { ref: "crm", url: bearer.url, credential: { token: "good-token", header: "X-API-Key" } }), { code: "mcp_exists" });
  } finally {
    oauth.server.close();
    bearer.server.close();
  }
});

test("HTTP: a rejected token leaves the approval pending, the callback only serves loopback, and the list shows status without credentials", async () => {
  const fixture = await createFixture();
  const root = mkdtempSync(join(tmpdir(), "mcp-http-"));
  const bearer = await authServer("bearer", { token: "good-token", header: "X-API-Key" });
  const oauth = await authServer("oauth");
  const auth = service(root);
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { mcpAuth: auth });
  const { AgentHttpServer } = await import("./http/server.js");
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  try {
    // A bearer MCP install waiting for the member's decision.
    let pendingId = "";
    const summary = `capability_install:${JSON.stringify({ kind: "mcp", ref: "crm", url: bearer.url, source: "user_url", auth: "bearer", auth_header: "X-API-Key" })}`;
    const run = host.approvalService.execute({
      tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1", sessionId: "s1", snapshotVersion: "v1",
      permissionRevision: "1:read-only", toolCallId: "call-1", toolName: "capability_install", args: { kind: "mcp", ref: "crm", url: bearer.url, reason: "" },
      riskLevel: "unknown", permissionMode: "read-only", summary,
    }, async () => "installed");
    run.catch(() => undefined);
    while (!pendingId) { pendingId = host.approvalService.list("conversation-1", "tenant-1", "member-1").find(item => item.status === "pending")?.id ?? ""; await new Promise(resolve => setImmediate(resolve)); }
    const decide = (credential: unknown, decision = "approve") => fetch(`${base}/api/agent/conversations/conversation-1/approvals/${pendingId}/decision`, { method: "POST", headers: { ...headers, "Idempotency-Key": `k-${Math.random()}` }, body: JSON.stringify({ decision, credential }) });

    const rejected = await decide({ token: "bad", header: "X-API-Key" });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json() as { code: string }).code, "invalid_mcp_token");
    assert.equal(fixture.store.getApprovalRecord(pendingId)?.status, "pending", "a rejected token does not use up the approval");
    assert.equal((await decide({ token: "t", header: "Host" })).status, 422, "transport headers are refused");

    const accepted = await decide({ token: "good-token", header: "X-API-Key" });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal(await run, "installed");
    assert(!JSON.stringify(fixture.store.getApprovalRecord(pendingId)).includes("good-token"), "the token is never written into the approval record");
    assert.deepEqual(host.approvalService.takeCredential(pendingId), { token: "good-token", header: "X-API-Key" });
    assert.equal(host.approvalService.takeCredential(pendingId), undefined, "handed over once");

    // The browser callback needs no Agent token but answers only the local browser; unknown state shows the failure page.
    const page = await fetch(`${base}/api/agent/mcp-auth/callback?state=forged&code=c`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /登录没有完成/u);

    // «添加 MCP» over HTTP: probe, install with sign-in, read login progress, then the list shows status only.
    const probe = await (await fetch(`${base}/api/agent/capabilities/mcp/probe`, { method: "POST", headers, body: JSON.stringify({ url: oauth.url }) })).json() as { data: { auth: string } };
    assert.equal(probe.data.auth, "oauth");
    const started = await (await fetch(`${base}/api/agent/capabilities/mcp`, { method: "POST", headers, body: JSON.stringify({ ref: "cr-test", url: oauth.url }) })).json() as { data: { capability: unknown; login: { login_id: string; authorization_url: string } } };
    assert.equal(started.data.capability, null);
    const progress = await (await fetch(`${base}/api/agent/mcp-auth/logins/${started.data.login.login_id}`, { headers })).json() as { data: { status: string } };
    assert.equal(progress.data.status, "pending");
    const reopened = await (await fetch(`${base}/api/agent/mcp-auth/logins/${started.data.login.login_id}/open`, { method: "POST", headers })).json() as { data: { opened: boolean } };
    assert.equal(reopened.data.opened, true);
    assert.equal((await fetch(`${base}/api/agent/mcp-auth/logins/unknown/open`, { method: "POST", headers })).status, 404);
    const state = new URL(started.data.login.authorization_url).searchParams.get("state")!;
    const done = await fetch(`${base}/api/agent/mcp-auth/callback?state=${encodeURIComponent(state)}&code=c1`);
    assert.match(await done.text(), /已完成登录/u);
    const listed = await (await fetch(`${base}/api/agent/capabilities`, { headers })).json() as { data: Record<string, unknown>[] };
    const item = listed.data.find(row => row.ref === "cr-test")!;
    assert.equal(item.auth_status, "signed_in");
    assert(!JSON.stringify(listed).includes("access-"), "tokens never leave the Agent");

    // Signing out keeps the install; uninstalling removes the credential too.
    assert.equal((await fetch(`${base}/api/agent/capabilities/mcp/cr-test/credential`, { method: "DELETE", headers })).status, 200);
    assert.equal(auth.status(owner, "cr-test", oauth.url, "oauth").auth_status, "needs_login");
    assert.equal((await fetch(`${base}/api/agent/capabilities/mcp/missing/credential`, { method: "DELETE", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/agent/capabilities/mcp/cr-test`, { method: "DELETE", headers })).status, 200);
    assert.equal(auth.credentials.get(owner, "cr-test", oauth.url), undefined);
  } finally {
    await http.close();
    await host.dispose();
    bearer.server.close();
    oauth.server.close();
    await fixture.close();
  }
});

const snapshot = { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "E", tools: [] } as never;
const call = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
  (tool.execute as (id: string, p: unknown, s?: AbortSignal) => Promise<{ isError?: boolean; content: { text: string }[] }>)("t", params, undefined);

test("a refresh the provider rejects turns into «sign in again» without opening the browser", async () => {
  const fixture = await createFixture();
  const root = mkdtempSync(join(tmpdir(), "mcp-refresh-"));
  const oauth = await authServer("oauth", { rejectRefresh: true });
  const opened: string[] = [];
  const auth = service(root, opened);
  try {
    const pending = await installMcpDirectly(fixture.store, owner, { service: auth }, { ref: "cr-test", url: oauth.url, display_name: "Cycplus" });
    const state = new URL(pending.login!.authorization_url).searchParams.get("state");
    assert.equal(await auth.callback({ state, code: "c1" }), true);
    const [tool] = personalConnectorTools(fixture.store, owner, snapshot, { service: auth });
    assert.equal((await call(tool!, { tool: "activity_summary", arguments: {} })).isError, false, "signed in: the call works");

    // The access token expires and the provider revokes the refresh token.
    auth.credentials.update(owner, "cr-test", oauth.url, (current) => current && { ...current, obtained_at: Date.now() - 7_200_000 });
    oauth.issued.clear();
    const result = await call(tool!, { tool: "activity_summary", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /需要重新登录 Cycplus.*设置 · 个人能力/u);
    assert.equal(oauth.seen.tokenRequests.at(-1)?.get("grant_type"), "refresh_token");
    assert.equal(opened.length, 1, "only the first sign-in opened the browser");
    assert.equal(auth.status(owner, "cr-test", oauth.url, "oauth").auth_status, "needs_login");
    // Once the tokens are gone the tool explains what to do before even calling the server.
    const before = oauth.seen.authHeaders.length;
    assert.match((await call(tool!, { tool: "activity_summary", arguments: {} })).content[0]!.text, /需要重新登录/u);
    assert.equal(oauth.seen.authHeaders.length, before);
  } finally {
    oauth.server.close();
    await fixture.close();
  }
});

test("tokens never reach the model or the logs: tool results, install results and stdout/stderr", async () => {
  const fixture = await createFixture();
  const root = mkdtempSync(join(tmpdir(), "mcp-leak-"));
  const token = "tok-d41f7e9a2c";
  const bearer = await authServer("bearer", { token, header: "X-API-Key", echoCredential: true });
  const oauth = await authServer("oauth", { echoCredential: true });
  const auth = service(root);
  const written: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: never[]) => { written.push(String(chunk)); return out(chunk as never, ...rest); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: never[]) => { written.push(String(chunk)); return err(chunk as never, ...rest); }) as typeof process.stderr.write;
  const seenByModel: string[] = [];
  try {
    // Bearer through the model's install tool: the member's token comes from the approval, never from the model.
    const install = capabilityInstallTool(fixture.store, owner, undefined, undefined, { service: auth });
    const installed = await (install.execute as unknown as (id: string, p: unknown) => Promise<{ content: { text: string }[] }>)("t", {
      kind: "mcp", ref: "crm", url: bearer.url, display_name: "CRM", reason: "", credential: { token, header: "X-API-Key" },
    });
    seenByModel.push(JSON.stringify(installed));
    const parameters = JSON.stringify(install.parameters);
    assert(!parameters.includes("credential") && !parameters.includes("token"), "the model's install schema has no credential field");

    await installMcpDirectly(fixture.store, owner, { service: auth }, { ref: "crm2", url: bearer.url, credential: { token, header: "X-API-Key" } });
    const pending = await installMcpDirectly(fixture.store, owner, { service: auth }, { ref: "cr-test", url: oauth.url });
    const state = new URL(pending.login!.authorization_url).searchParams.get("state")!;
    assert.equal(await auth.callback({ state, code: "secret-code-77" }), true);

    for (const tool of personalConnectorTools(fixture.store, owner, snapshot, { service: auth })) {
      // Both fake servers expose the same tool.
      seenByModel.push(JSON.stringify(await call(tool, { tool: "activity_summary", arguments: {} })));
      seenByModel.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    }
    const echoed = seenByModel.join("\n");
    assert.match(echoed, /凭据已隐藏/u, "the echoing server really tried to leak the credential");
    const stored = auth.credentials.get(owner, "cr-test", oauth.url)!;
    const secrets = [token, stored.tokens!.access_token, stored.tokens!.refresh_token!, state, "secret-code-77"];
    for (const secret of secrets) {
      assert(!echoed.includes(secret), `model-visible text holds ${secret.slice(0, 4)}…`);
      assert(!written.join("").includes(secret), `logs hold ${secret.slice(0, 4)}…`);
      assert(!JSON.stringify(fixture.store.listLocalCapabilities("tenant-1", "member-1")).includes(secret), "capability rows hold no secret");
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    bearer.server.close();
    oauth.server.close();
    await fixture.close();
  }
});
