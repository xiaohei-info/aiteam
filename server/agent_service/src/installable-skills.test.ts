import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHttpServer } from "./http/server.js";
import { ManagerUnavailableError } from "./manager-client.js";
import { listInstallableSkillStates } from "./connectors.js";
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
    assert.deepEqual((await response.json()).data, items.map(item => ({ ...item, state: "install" })));
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

test("each enterprise skill carries its state here: same entry by version, other same-name skill is a conflict", async () => {
  const fixture = await createFixture();
  const owner = { tenantId: "tenant-a", memberId: "member-a" };
  try {
    const put = (ref: string, version: string, source: "platform_catalog" | "enterprise_catalog" | "user_import", source_ref = "") =>
      fixture.store.putLocalCapability(owner.tenantId, owner.memberId, { kind: "skill", ref, display_name: ref, url: "", tools: [], version, source_ref, source, reason: "", approved_by: "member-a" });
    put("platform-p1", "1.0.0", "platform_catalog", "p1");
    put("notes", "a1", "enterprise_catalog");
    put("weather", "x", "user_import");
    put("platform-old-1-h", "1", "platform_catalog", "p9");
    put("ppt-outline", "mine", "user_import");
    const catalog = [
      { skill_id: "platform-p1", display_name: "天气", version: "2.0.0", content_hash: "h", source_skill_id: "p1", name: "weather-pro", namespace: "taiyim" },
      { skill_id: "notes", display_name: "notes", version: "a1", content_hash: "h", source_skill_id: "", name: "notes", namespace: "太一科技" },
      { skill_id: "platform-p2", display_name: "weather", version: "1", content_hash: "h", source_skill_id: "p2", name: "weather", namespace: "taiyim" },
      { skill_id: "platform-p9", display_name: "old", version: "1", content_hash: "h", source_skill_id: "p9", name: "old" },
      { skill_id: "fresh", display_name: "fresh", version: "1", content_hash: "h", source_skill_id: "" },
      { skill_id: "ppt-outline", display_name: "ppt-outline", version: "e1", content_hash: "h", source_skill_id: "", name: "ppt-outline", namespace: "太一科技" },
    ];
    const states = listInstallableSkillStates(fixture.store, owner, catalog);
    assert.deepEqual(states.map(item => [item.skill_id, item.state, item.local_ref ?? ""]), [
      ["platform-p1", "update", "platform-p1"],
      ["notes", "installed", "notes"],
      ["platform-p2", "conflict", "weather"],      // a self-imported skill already uses the SKILL.md name «weather»
      ["platform-p9", "update", "platform-old-1-h"], // the same platform skill installed under an older catalog id
      ["fresh", "install", ""],
      ["ppt-outline", "conflict", "ppt-outline"],  // same ref as a self-imported skill: a different skill, not an update
    ]);
  } finally { await fixture.close(); }
});
