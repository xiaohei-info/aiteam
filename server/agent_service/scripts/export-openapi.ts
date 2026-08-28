import { writeFileSync } from "node:fs";
import { AgentHttpServer } from "../src/http/server.js";
import { createFixture } from "../src/test-fixture.js";

const output = process.argv[2] ?? "/tmp/aiteam-agent-openapi.json";
const fixture = await createFixture();
const http = new AgentHttpServer({
  host: fixture.host,
  store: fixture.store,
  authenticate: () => ({ callerId: "openapi-check", userId: "openapi-check", tenantId: "openapi-check", roles: ["member"] }),
});
try {
  await http.listen(0);
  const address = http.server.address();
  if (!address || typeof address === "string") throw new Error("Agent HTTP server did not expose a TCP port");
  const response = await fetch(`http://127.0.0.1:${address.port}/openapi.json`);
  if (!response.ok) throw new Error(`Agent OpenAPI request failed: HTTP ${response.status}`);
  writeFileSync(output, JSON.stringify(await response.json(), null, 2));
  console.log(`Agent OpenAPI written to ${output}`);
} finally {
  await http.close();
  await fixture.close();
}
