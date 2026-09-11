/** 公开登录端点的企业解析契约：不填 tenant_id 时由同源 Agent 让 Manager 解析。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { ManagerAuthError } from "../manager-client.js";
import { createFixture } from "../test-fixture.js";

const CLAIMS = (account: string, tenantId: string) => ({
  user_id: account, tenant_id: tenantId, enterprise_id: null, roles: ["member"], exp: 9_999_999_999,
});

async function withServer(
  run: (base: string, calls: { path: string; body: unknown }[]) => Promise<void>,
  opts: { resolve?: boolean; login?: boolean } = {},
): Promise<void> {
  const fixture = await createFixture();
  const calls: { path: string; body: unknown }[] = [];
  const managerClient = {
    ...(opts.resolve === false ? {} : {
      resolveTenantByAccount: async (account: string, enterprise?: string | null) => {
        calls.push({ path: "resolve", body: { account, enterprise } });
        return { data: { tenant_id: "tenant-resolved" } };
      },
    }),
    ...(opts.login === false ? {} : {
      login: async (input: { account: string; tenant_id: string }) => {
        calls.push({ path: "login", body: input });
        return { data: { token: "tok", claims: CLAIMS(input.account, input.tenant_id) } };
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

test("login 只传 enterprise 时自行解析租户，并只用解析结果调 Manager", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", enterprise: "acme" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [
      { path: "resolve", body: { account: "alice", enterprise: "acme" } },
      { path: "login", body: { tenant_id: "tenant-resolved", account: "alice", password: "pw" } },
    ]);
    const body = (await response.json()) as { data: { claims: { tenant_id: string } } };
    assert.equal(body.data.claims.tenant_id, "tenant-resolved");
  });
});

test("login 传 tenant_id 时跳过解析（调用方已自行解析）", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", tenant_id: "tenant-explicit" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ path: "login", body: { tenant_id: "tenant-explicit", account: "alice", password: "pw" } }]);
  });
});

test("login 只传 account 时按账号解析企业（单企业用户无需填写企业标识）", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [
      { path: "resolve", body: { account: "alice", enterprise: undefined } },
      { path: "login", body: { tenant_id: "tenant-resolved", account: "alice", password: "pw" } },
    ]);
  });
});

test("login 在 Manager 拒绝解析时透传其 problem 状态与 code", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    managerClient: {
      resolveTenantByAccount: async () => {
        throw new ManagerAuthError(409, { code: "enterprise_ambiguous", detail: "enterprise identifier is ambiguous" });
      },
      login: async () => { throw new Error("login must not be called when resolution fails"); },
    } as never,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await post(`http://127.0.0.1:${address.port}`, "/api/agent/login", { account: "alice", password: "pw", enterprise: "acme" });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; detail: string };
    assert.equal(body.code, "enterprise_ambiguous");
    assert.match(body.detail, /ambiguous/u);
  } finally {
    await http.close();
    await fixture.close();
  }
});

test("login 无 Manager 解析能力时返回 503 manager_unavailable", async () => {
  await withServer(async (base, calls) => {
    const response = await post(base, "/api/agent/login", { account: "alice", password: "pw", enterprise: "acme" });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "manager_unavailable");
    assert.deepEqual(calls, []);
  }, { resolve: false });
});

test("OpenAPI 上 login/reset-password 暴露 enterprise，tenant_id 不再必填", async () => {
  await withServer(async (base) => {
    const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, { post: { requestBody?: { content: { "application/json": { schema: unknown } } } } }>;
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
  });
});
