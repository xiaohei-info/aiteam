import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";

test("Agent exposes standard docs and readiness boundaries", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1" }),
    runtimeReady: () => false,
    spaRoot: fixture.root,
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    writeFileSync(join(fixture.root, "index.html"), "<main>Agent</main>");
    const spa = await fetch(`${base}/dashboard`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /Agent/);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id")?.length, 36);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /aiteam_agent_http_requests_total/);
    const openapi = await fetch(`${base}/openapi.json`);
    assert.equal(openapi.status, 200);
    const schema = await openapi.json() as { paths: Record<string, unknown> };
    assert(schema.paths["/api/agent/conversations/{conversation_id}/prompt"]);
    const docs = await fetch(`${base}/docs`);
    assert.equal(docs.status, 200);
    const docsHtml = await docs.text();
    assert.match(docsHtml, /\/docs\/static\/swagger-ui-bundle\.js/u);
    assert.doesNotMatch(docsHtml, /https?:\/\/(?:unpkg|cdn\.jsdelivr)/u);
    const swaggerBundle = await fetch(`${base}/docs/static/swagger-ui-bundle.js`);
    assert.equal(swaggerBundle.status, 200);
    assert.match(swaggerBundle.headers.get("content-type") ?? "", /javascript/u);
    await swaggerBundle.arrayBuffer();
    const redoc = await fetch(`${base}/redoc`);
    assert.equal(redoc.status, 200);
    assert.match(await redoc.text(), /\/redoc\/redoc\.standalone\.js/u);
    const redocBundle = await fetch(`${base}/redoc/redoc.standalone.js`);
    assert.equal(redocBundle.status, 200);
    assert.match(redocBundle.headers.get("content-type") ?? "", /javascript/u);
    await redocBundle.arrayBuffer();
    const missing = await fetch(`${base}/api/missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/problem+json; charset=utf-8");
  } finally {
    await http.close();
    await fixture.close();
  }
});
