import assert from "node:assert/strict";
import test from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { requestContext } from "../observability.js";

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
