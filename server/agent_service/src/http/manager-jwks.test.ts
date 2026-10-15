import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import { ManagerJwksAuthenticator } from "./manager-jwks.js";
import { AgentHttpServer } from "./server.js";
import { HttpManagerClient } from "../manager-client.js";
import { createFixture } from "../test-fixture.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function material(tenant: string, version: number) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...pair, jwk: { ...pair.publicKey.export({ format: "jwk" }), kid: `${tenant}:${version}`, alg: "RS256" } };
}
function jwt(key: ReturnType<typeof material>, tenant: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.jwk.kid, ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ tenant_id: tenant, enterprise_id: tenant, user_id: "member", roles: ["member"], iss: "aiteam-manager", aud: "aiteam-agent", iat: now, exp: now + 3600, ...claims })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url")}`;
}
const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);

async function mockManager() {
  const a1 = material(A, 1), a2 = material(A, 2), b1 = material(B, 1);
  const state = { keys: [a1.jwk], hits: 0, paths: [] as string[], mode: "ok", token: "", failAuth: false, scoped: false };
  const server = createServer(async (req, res) => {
    state.paths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/jwks.json")) {
      state.hits++;
      if (state.mode === "failure") { res.writeHead(503); res.end("{}"); return; }
      if (state.mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/forbidden" }); res.end(); return; }
      if (state.mode === "html") { res.setHeader("content-type", "text/html"); res.end("<html>"); return; }
      if (state.mode === "large") { res.end(" ".repeat(65_537)); return; }
      res.end(JSON.stringify({ keys: state.scoped ? [{ ...a1.jwk, kid: `${req.url.split("/")[3]}:1` }] : req.url.includes(B) ? [b1.jwk] : state.keys })); return;
    }
    if (state.mode === "auth-disconnect") { req.socket.destroy(); return; }
    if (state.mode === "auth-redirect") { res.writeHead(307, { location: "http://127.0.0.1:1/forbidden" }); res.end(); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (state.failAuth) { res.writeHead(401); res.end(JSON.stringify({ code: "unauthorized" })); return; }
    if (req.url?.includes("resolve-tenant")) { res.end(JSON.stringify({ data: { tenant_id: body.account === "b" ? B : A } })); return; }
    const tenant = body.tenant_id;
    res.end(JSON.stringify({ data: { token: state.token || jwt(tenant === B ? b1 : a1, tenant), claims: { tenant_id: tenant, roles: ["untrusted-response-role"] } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { state, a1, a2, b1, origin, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("real Agent HTTP login verifies Manager token before return; multiple tenants and protected routes", async () => {
  const manager = await mockManager();
  const fixture = await createFixture();
  const auth = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, managerClient: new HttpManagerClient(manager.origin), authenticate: auth.authenticate, verifyLoginToken: (token, tenant) => auth.verifyLoginToken(token, tenant) });
  await http.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(http.server.address() as { port: number }).port}`;
  const login = (account: string, extra = {}) => fetch(`${base}/api/agent/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, password: "synthetic-only", ...extra }) });
  try {
    for (const bearer of [undefined, "local-development", jwt(manager.a1, A)]) {
      const r = await fetch(`${base}/api/agent/conversations`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
      assert.equal(r.status, 401);
    }
    assert.equal(manager.state.hits, 0, "unknown bearer must not fetch/create tenant keys");
    for (const [account, tenant] of [["a", A], ["b", B]]) {
      const r = await login(account);
      assert.equal(r.status, 200);
      const { data } = await r.json() as any;
      assert.deepEqual(data.claims.roles, ["member"], "return verified claims rather than response metadata");
      assert.equal(data.claims.tenant_id, tenant);
      for (const path of ["/api/agent/whoami", "/api/agent/conversations"]) assert.equal((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${data.token}` } })).status, 200);
    }
    fixture.store.createConversation({ id: "private-a", sessionFile: "", workspace: "", tenantId: A, memberId: "member" });
    const listB = await fetch(`${base}/api/agent/conversations`, { headers: { authorization: `Bearer ${jwt(manager.b1, B)}` } });
    assert.equal(JSON.stringify(await listB.json()).includes("private-a"), false);
    const invalid = [jwt(manager.b1, A, {}, { kid: manager.a1.jwk.kid }), jwt(manager.a1, A, { exp: 1 }), jwt(manager.a1, B), jwt(manager.a1, A, { iss: "evil" }), jwt(manager.a1, A, { aud: "evil" }), jwt(manager.a1, A, { nbf: Math.floor(Date.now() / 1000) + 100 }), jwt(manager.a1, A, {}, { alg: "none" }), jwt(manager.a1, A, {}, { kid: `${A}:999` })];
    for (const token of invalid) {
      assert.equal((await fetch(`${base}/api/agent/whoami`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
      manager.state.token = token;
      assert.equal((await login("a")).status, 503, "invalid Manager token must not be returned as a successful login");
    }
    manager.state.token = "";
    manager.state.failAuth = true;
    const before = manager.state.hits;
    assert.equal((await login("a")).status, 401);
    assert.equal(manager.state.hits, before);
    manager.state.failAuth = false;
    for (const mode of ["auth-disconnect", "auth-redirect"]) {
      manager.state.mode = mode;
      assert.equal((await login("a")).status, 503);
    }
    manager.state.mode = "ok";
    const reset = await fetch(`${base}/api/agent/reset-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "a", old_password: "synthetic-old", new_password: "synthetic-new" }) });
    assert.equal(reset.status, 200);
    manager.state.token = jwt(manager.a1, A);
    assert.equal((await login("a", { tenant_id: B })).status, 503);
  } finally { await http.close(); await fixture.close(); await manager.close(); }
});

test("bounded tenant refresh: single flight, unknown kid cooldown, rotation grace, removal and Manager failure", async () => {
  const manager = await mockManager();
  const auth = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const old = jwt(manager.a1, A);
    await Promise.all(Array.from({ length: 20 }, () => auth.verifyLoginToken(old, A)));
    assert.equal(manager.state.hits, 1);
    now += 5001;
    const unknown = jwt(manager.a1, A, {}, { kid: `${A}:99` });
    await Promise.all(Array.from({ length: 20 }, () => assert.rejects(() => auth.authenticate(request(unknown)))));
    assert.equal(manager.state.hits, 2);
    await assert.rejects(() => auth.authenticate(request(unknown)));
    assert.equal(manager.state.hits, 2);
    now += 5001;
    manager.state.keys = [manager.a1.jwk, manager.a2.jwk];
    const next = jwt(manager.a2, A);
    await auth.authenticate(request(next));
    await auth.authenticate(request(old));
    assert.equal(manager.state.hits, 3, "Manager's current+grace keys remain accepted");
    now += 60_001;
    manager.state.keys = [manager.a2.jwk];
    await assert.rejects(() => auth.authenticate(request(old)), /Unknown JWT key/);
    await auth.authenticate(request(next));
    now += 60_001;
    manager.state.mode = "failure";
    await assert.rejects(() => auth.authenticate(request(next)));
    const hits = manager.state.hits;
    await assert.rejects(() => auth.authenticate(request(next)), /cooling down/);
    assert.equal(manager.state.hits, hits);
    now += 5001;
    manager.state.mode = "ok";
    await auth.authenticate(request(next));
    const restart = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
    await assert.rejects(() => restart.authenticate(request(next)), /requires Manager login/);
  } finally { Date.now = realNow; await manager.close(); }
});

test("fixed Manager origin and scoped JWKS reject URL injection, redirects, HTML, oversized and wrong-tenant keys", async () => {
  const manager = await mockManager();
  try {
    for (const url of ["file:///etc/passwd", "http://user:pass@localhost", `${manager.origin}/other`, `${manager.origin}?x=1`, `${manager.origin}#x`]) assert.throws(() => new ManagerJwksAuthenticator(url, "issuer", "audience"));
    for (const mode of ["redirect", "html", "large", "failure"]) {
      manager.state.mode = mode;
      const auth = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
      await assert.rejects(() => auth.verifyLoginToken(jwt(manager.a1, A), A));
    }
    manager.state.mode = "ok";
    manager.state.keys = [manager.b1.jwk];
    await assert.rejects(() => new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent").verifyLoginToken(jwt(manager.a1, A), A), /scope/);
    manager.state.keys = [manager.a1.jwk];
    const auth = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
    await auth.verifyLoginToken(jwt(manager.a1, A, {}, { jku: "http://127.0.0.1:1/evil", x5u: "file:///etc/passwd" }), A);
    const before = manager.state.hits;
    await assert.rejects(() => auth.verifyLoginToken(jwt(manager.a1, "../../evil"), "../../evil"));
    assert.equal(manager.state.hits, before);
    assert(manager.state.paths.filter((p) => p.endsWith("/jwks.json")).every((p) => p === `/api/auth/${A}/jwks.json`));
  } finally { await manager.close(); }
});

test("cache eviction, global download rate and concurrency remain bounded", async () => {
  const manager = await mockManager();
  manager.state.scoped = true;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const tenant = (i: number) => `${i.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`;
  const token = (i: number) => jwt({ ...manager.a1, jwk: { ...manager.a1.jwk, kid: `${tenant(i)}:1` } }, tenant(i));
  try {
    const auth = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
    for (let i = 0; i < 257; i++) {
      now += 1001;
      await auth.verifyLoginToken(token(i), tenant(i));
    }
    await assert.rejects(() => auth.authenticate(request(token(0))), /requires Manager login/);
    await auth.authenticate(request(token(256)));
    const rate = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
    now += 1001;
    for (let i = 0; i < 16; i++) await rate.verifyLoginToken(token(i), tenant(i));
    const beforeRate = manager.state.hits;
    await assert.rejects(() => rate.verifyLoginToken(token(16), tenant(16)), /busy/);
    assert.equal(manager.state.hits, beforeRate);
    const parallel = new ManagerJwksAuthenticator(manager.origin, "aiteam-manager", "aiteam-agent");
    now += 1001;
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => parallel.verifyLoginToken(token(i), tenant(i))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
    assert.equal(manager.state.hits - beforeRate, 4);
  } finally { Date.now = realNow; await manager.close(); }
});

test("actual main startup wires secure login and rejects conflicting modes before listening", async () => {
  const manager = await mockManager();
  const data = mkdtempSync(join(tmpdir(), "aiteam-auth-startup-"));
  async function launch(extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: new URL("../../", import.meta.url),
      env: { PATH: process.env.PATH, HOME: data, TMPDIR: tmpdir(), AITEAM_ENV: "test", AITEAM_PI_FAKE: "true", AITEAM_AGENT_DEV_AUTH: "false", AITEAM_AGENT_JWKS_MODE: "manager", AITEAM_MANAGER_URL: manager.origin, AITEAM_AGENT_JWT_ISSUER: "aiteam-manager", AITEAM_AGENT_JWT_AUDIENCE: "aiteam-agent", AITEAM_AGENT_DATA_DIR: join(data, "state"), PORT: "0", HOST: "127.0.0.1", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Agent startup timed out: ${output}`)); }, 15_000);
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        const line = output.match(/AI_TEAM_AGENT_READY (\{[^\n]+\})/);
        if (line) { clearTimeout(timer); resolve(`http://127.0.0.1:${JSON.parse(line[1]).port}`); }
      };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Agent exited ${code}: ${output}`)); });
    });
    return { child, ready, exited };
  }
  try {
    const running = await launch();
    try {
      const base = await running.ready;
      assert.equal((await fetch(`${base}/api/agent/whoami`, { headers: { authorization: "Bearer local-development" } })).status, 401);
      const response = await fetch(`${base}/api/agent/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "a", password: "synthetic-only" }) });
      assert.equal(response.status, 200);
      const payload = await response.json() as any;
      assert.equal((await fetch(`${base}/api/agent/conversations`, { headers: { authorization: `Bearer ${payload.data.token}` } })).status, 200);
      assert.equal(manager.state.hits, 1);
    } finally { running.child.kill("SIGTERM"); await running.exited; }
    for (const extra of [{ AITEAM_AGENT_JWKS_JSON: "{}" }, { AITEAM_AGENT_DEV_AUTH: "true" }, { AITEAM_AGENT_JWKS_MODE: "invalid" }]) {
      const invalid = await launch(extra);
      await assert.rejects(invalid.ready, /conflicts|Invalid Agent JWKS mode/);
      assert.equal(await invalid.exited, 1);
    }
  } finally { rmSync(data, { recursive: true, force: true }); await manager.close(); }
});
