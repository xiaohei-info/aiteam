/** 公开登录端点的企业匹配契约：Agent 不再「凭账号查企业」，企业参数原样转交 Manager，由 Manager 按账号和密码匹配。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JwtClockError } from "./auth.js";
import { AgentHttpServer } from "./server.js";
import { ManagerAuthError } from "../manager-client.js";
import { createFixture } from "../test-fixture.js";

const CLAIMS = (account: string, tenantId: string) => ({
  user_id: account, tenant_id: tenantId, enterprise_id: null, roles: ["member"], exp: 9_999_999_999,
});

async function withServer(
  run: (base: string, calls: { path: string; body: unknown }[]) => Promise<void>,
  opts: { login?: boolean; matchedTenant?: string } = {},
): Promise<void> {
  const fixture = await createFixture();
  const calls: { path: string; body: unknown }[] = [];
  const managerClient = {
    ...(opts.login === false ? {} : {
      login: async (input: { account: string; tenant_id?: string }) => {
        calls.push({ path: "login", body: input });
        return { data: { token: "tok", claims: CLAIMS(input.account, input.tenant_id ?? opts.matchedTenant ?? "tenant-matched") } };
      },
      ownerReset: async (input: { account: string; tenant_id?: string }) => {
        calls.push({ path: "ownerReset", body: input });
        return { data: { token: "tok", claims: CLAIMS(input.account, input.tenant_id ?? opts.matchedTenant ?? "tenant-matched") } };
      },
    }),
  };
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient: managerClient as never,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await http.close();
    await fixture.close();
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("login 只传 account 时不预先解析企业，直接交 Manager 按账号和密码匹配", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ path: "login", body: { account: "alice", password: "pw" } }]);
    const body = (await response.json()) as { data: { claims: { tenant_id: string } } };
    assert.equal(body.data.claims.tenant_id, "tenant-matched");
  });
});

test("login 传 enterprise 时原样转交 Manager", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", enterprise: " acme " });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ path: "login", body: { enterprise: "acme", account: "alice", password: "pw" } }]);
  });
});

test("login 传候选 tenant_id 时只按该企业登录，且 Manager 返回别的企业视为无效", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", tenant_id: "tenant-explicit" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ path: "login", body: { tenant_id: "tenant-explicit", account: "alice", password: "pw" } }]);
  });
});

test("reset-password 未填企业时也直接交 Manager（旧密码通过后匹配企业）", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/reset-password", { account: "owner", old_password: "old", new_password: "new" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ path: "ownerReset", body: { account: "owner", old_password: "old", new_password: "new" } }]);
  });
});

test("resolve-tenant-by-account 已停用：不论账号是否存在都返回同一个 410，且不访问 Manager", async () => {
  await withServer(async (base, calls) => {
    const bodies: unknown[] = [];
    for (const body of [{ account: "exists" }, { account: "nobody-" + Date.now() }, { account: "x", enterprise: "acme" }, {}]) {
      const response = await post(base, "/api/auth/resolve-tenant-by-account", body);
      assert.equal(response.status, 410);
      assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/u);
      const payload = (await response.json()) as Record<string, unknown>;
      bodies.push({ code: payload.code, detail: payload.detail, meta: payload.meta });
    }
    assert.deepEqual(bodies[0], { code: "client_upgrade_required", detail: "客户端版本过旧，请升级后登录", meta: undefined });
    for (const body of bodies) assert.deepEqual(body, bodies[0]);
    assert.deepEqual(calls, []);
  });
});

test("login 无 Manager 认证能力时返回 503 manager_unavailable", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", enterprise: "acme" });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "manager_unavailable");
    assert.deepEqual(calls, []);
  }, { login: false });
});

test("OpenAPI 上 login/reset-password 暴露 enterprise，tenant_id 不必填；resolve-tenant-by-account 只文档化 410（另保留全局统一的 422/500）", async () => {
  await withServer(async (base) => {
    const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, { post: { deprecated?: boolean; responses: Record<string, unknown>; requestBody?: { content: { "application/json": { schema: unknown } } } } }>;
      components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
    };
    for (const path of ["/api/agent/login", "/api/agent/reset-password"]) {
      const ref = JSON.stringify(document.paths[path]!.post.requestBody).match(/"#\/components\/schemas\/(\w+)"/);
      assert(ref, `${path} 请求体应引用组件 schema`);
      const schema = document.components.schemas[ref[1]!]!;
      assert(schema.properties.enterprise, `${ref[1]} 应暴露 enterprise`);
      assert(!schema.required?.includes("tenant_id"), `${ref[1]} 不应再要求 tenant_id`);
      assert(schema.required?.includes("account"), `${ref[1]} 应要求 account`);
    }
    const retired = document.paths["/api/auth/resolve-tenant-by-account"]!.post;
    assert.equal(retired.deprecated, true);
    assert.deepEqual(Object.keys(retired.responses).sort(), ["410", "422", "500"]);
    assert.equal(retired.requestBody, undefined);
  });
});

async function loginWithVerifier(verify: () => Promise<never>): Promise<{ status: number; body: { code: string; detail: string; meta?: Record<string, unknown> } }> {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient: {
      login: async (input: { account: string; tenant_id: string }) => ({ data: { token: "tok", claims: CLAIMS(input.account, input.tenant_id) } }),
    } as never,
    verifyLoginToken: verify,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await post(`http://127.0.0.1:${address.port}`, "/api/agent/login", { account: "alice", password: "pw", tenant_id: "tenant-1" });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    await http.close();
    await fixture.close();
  }
}

test("login 在本机时钟与 Manager 不一致时返回 503 clock_skew_detected 并带偏差秒数", async () => {
  const { status, body } = await loginWithVerifier(async () => { throw new JwtClockError("JWT issued-at claim is in the future", 754); });
  assert.equal(status, 503);
  assert.equal(body.code, "clock_skew_detected");
  assert.deepEqual(body.meta, { skew_seconds: 754 });
});

test("login 其他本地校验失败仍是 manager_unavailable，不带时钟信息", async () => {
  const { status, body } = await loginWithVerifier(async () => { throw new Error("Invalid JWT signature"); });
  assert.equal(status, 503);
  assert.equal(body.code, "manager_unavailable");
  assert.match(body.detail, /authentication is unavailable/u);
  assert.equal(body.meta, undefined);
});

async function withRejectingManager(
  managerClient: Record<string, unknown>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient: managerClient as never,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await http.close();
    await fixture.close();
  }
}

const SELECTION_REQUIRED = new ManagerAuthError(409, {
  code: "tenant_selection_required",
  detail: "account and password match multiple enterprises; select one by tenant_id",
  meta: {
    candidates: [
      { tenant_id: "tenant-a", enterprise_name: "甲企业", secret: "must-not-leak" },
      { tenant_id: "", enterprise_name: "坏数据" },
      { enterprise_name: "缺 tenant_id" },
    ],
    internal: "must-not-leak",
  },
});

test("login 透传 tenant_selection_required 的候选企业，只放行校验过的字段", async () => {
  await withRejectingManager({ login: async () => { throw SELECTION_REQUIRED; } }, async (base) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw" });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; meta?: unknown };
    assert.equal(body.code, "tenant_selection_required");
    assert.deepEqual(body.meta, { candidates: [{ tenant_id: "tenant-a", enterprise_name: "甲企业" }] });
  });
});

test("login 透传「需要改密」响应的 meta.tenant_id，供改密定位企业", async () => {
  await withRejectingManager({
    login: async () => { throw new ManagerAuthError(403, { code: "password_reset_required", detail: "reset", meta: { tenant_id: "tenant-a", other: "x" } }); },
  }, async (base) => {
    const response = await post(base, "/api/agent/login", { account: "owner", password: "boot" });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code: string; meta?: unknown };
    assert.equal(body.code, "password_reset_required");
    assert.deepEqual(body.meta, { tenant_id: "tenant-a" });
  });
});

for (const status of [401, 403, 404, 409, 422, 429]) {
  test(`Manager 认证 ${status} 不会被本地 Agent 映射成 5xx`, async () => {
    await withRejectingManager({
      login: async () => { throw new ManagerAuthError(status, { code: `manager_${status}`, detail: "rejected" }); },
    }, async (base) => {
      const response = await post(base, "/api/agent/login", { account: "alice", password: "pw" });
      assert.equal(response.status, status);
      const body = (await response.json()) as { code: string; meta?: unknown };
      assert.equal(body.code, `manager_${status}`);
      assert.equal(body.meta, undefined);
    });
  });
}
