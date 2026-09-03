import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";

test("configured Agent client origin receives CORS preflight and response headers", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }),
    allowedOrigins: ["aiteam://desktop"],
  });
  try {
    await http.listen(0, "127.0.0.1");
    const address = http.server.address();
    assert(address && typeof address === "object");
    const origin = "aiteam://desktop";
    const preflight = await fetch(`http://127.0.0.1:${address.port}/api/agent/ping`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Authorization" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/ping`, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-ID");
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/agent/ping`, { method: "OPTIONS", headers: { Origin: "https://unexpected.example" } });
    assert.equal(denied.status, 403);
  } finally {
    await http.close();
    await fixture.close();
  }
});
