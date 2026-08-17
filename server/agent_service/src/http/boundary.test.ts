import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";

test("Agent exposes standard docs and readiness boundaries", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-1" }),
    runtimeReady: () => false,
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id")?.length, 36);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    const openapi = await fetch(`${base}/openapi.json`);
    assert.equal(openapi.status, 200);
    const schema = await openapi.json() as { paths: Record<string, unknown> };
    assert(schema.paths["/api/agent/conversations/{conversation_id}/prompt"]);
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/problem+json; charset=utf-8");
  } finally {
    await http.close();
    await fixture.close();
  }
});
