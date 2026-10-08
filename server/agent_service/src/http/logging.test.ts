import assert from "node:assert/strict";
import test from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { appLogger, ApplicationLogger, requestContext } from "../observability.js";

test("real HTTP handlers retain validated correlation context across async auth", async () => {
  const fixture = await createFixture();
  const contexts: unknown[] = [];
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, allowedOrigins: ["http://ui.test"], authenticate: async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    contexts.push(requestContext.getStore());
    return { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
  } });
  try {
    await http.listen(0);
    const address = http.server.address(); assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const requestId = "req_" + "a".repeat(32);
    const response = await fetch(`${base}/api/agent/conversations`, { headers: { "X-Request-ID": requestId, traceparent: `00-${"b".repeat(32)}-${"c".repeat(16)}-01` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.equal(response.headers.get("x-trace-id"), "b".repeat(32));
    assert.equal((contexts[0] as { request_id: string }).request_id, requestId);
    await response.arrayBuffer();
    const invalid = await fetch(`${base}/healthz?password=secret`, { headers: { "X-Request-ID": "caller-secret", traceparent: "secret" } });
    assert.notEqual(invalid.headers.get("x-request-id"), "caller-secret");
    await invalid.arrayBuffer();
    const cors = await fetch(`${base}/api/agent/conversations`, { method: "OPTIONS", headers: { origin: "http://ui.test", "Access-Control-Request-Headers": "x-request-id,traceparent" } });
    assert.match(cors.headers.get("access-control-allow-headers") ?? "", /traceparent/);
  } finally { await http.close(); await fixture.close(); }
});


test("authenticated request logs bind only the verified tenant and keep concurrent callers isolated", async (t) => {
  const fixture = await createFixture();
  const lines: string[] = [];
  const logger = new ApplicationLogger(line => lines.push(line));
  t.mock.method(appLogger, "log", logger.log.bind(logger));
  const tenants = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: async (request) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const tenantId = request.headers["x-test-tenant"];
    if (typeof tenantId !== "string" || !tenants.includes(tenantId)) throw new Error("invalid caller");
    return { callerId: "member-1", userId: "member-1", tenantId };
  } });
  try {
    await http.listen(0);
    const address = http.server.address(); assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/api/agent/conversations`;
    await Promise.all(tenants.map(async (tenant, index) => {
      const response = await fetch(base + (index ? "?unexpected=1" : ""), { headers: {
        "x-test-tenant": tenant, "x-tenant-id": "33333333-3333-4333-8333-333333333333",
        "x-request-id": `req_${String(index + 1).repeat(32)}`,
      } });
      assert.equal(response.status, index ? 422 : 200);
      await response.arrayBuffer();
    }));
    const denied = await fetch(base, { headers: { "x-tenant-id": tenants[0]! } });
    assert.equal(denied.status, 401);
    await denied.arrayBuffer();
    await new Promise<void>(resolve => setImmediate(resolve));
    const records = lines.map(line => JSON.parse(line));
    for (const [index, tenant] of tenants.entries()) {
      const requestRecords = records.filter(record => record.request_id === `req_${String(index + 1).repeat(32)}`);
      assert(requestRecords.some(record => record.event === "http.completed"));
      assert(requestRecords.every(record => record.tenant_id === tenant));
    }
    assert(records.some(record => record.event === "http.failed" && record.tenant_id === tenants[1]));
    assert(records.filter(record => record.status === 401).every(record => record.tenant_id === undefined));
    assert.doesNotMatch(lines.join(""), /33333333|invalid caller|x-test-tenant/);
  } finally { await http.close(); await fixture.close(); }
});
