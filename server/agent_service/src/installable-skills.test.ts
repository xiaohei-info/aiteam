import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./http/server.js";
import { ManagerUnavailableError } from "./manager-client.js";
import { createFixture } from "./test-fixture.js";

async function serve(managerClient: unknown) {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] }),
    managerClient: managerClient as never,
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const get = () => fetch(`http://127.0.0.1:${address.port}/api/agent/capabilities/installable-skills`, { headers: { Authorization: "Bearer test" } });
  return { get, close: async () => { await http.close(); await fixture.close(); } };
}

test("installable skills are read through Manager for the current member, read-only", async () => {
  const seen: unknown[] = [];
  const items = [{ skill_id: "tenant-sampling", display_name: "抽样检验", version: "1.2.0", content_hash: "h", source_skill_id: "plat-1" }];
  const server = await serve({ listInstallableSkills: async (caller: unknown) => { seen.push(caller); return items; } });
  try {
    const response = await server.get();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, items);
    assert.equal((seen[0] as { tenantId: string }).tenantId, "tenant-a");
  } finally { await server.close(); }
});

test("installable skills answer 503 when Manager is unreachable or not configured", async () => {
  for (const client of [{ listInstallableSkills: async () => { throw new ManagerUnavailableError(); } }, {}]) {
    const server = await serve(client);
    try {
      const response = await server.get();
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "manager_unavailable");
    } finally { await server.close(); }
  }
});
