/** Platform-catalog installs and the member's auto-install grant (design §11.3). */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFixture } from "./test-fixture.js";
import { ApprovalRememberError, ApprovalService, AUTO_INSTALL_APPROVER } from "./approval-service.js";
import { capabilityInstallTool, checkCapabilityInstall, type InstallableMcpInfo } from "./connectors.js";
import { AgentHttpServer } from "./http/server.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };

async function mcpServer(advertised: string[]) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }
      : { tools: advertised.map(name => ({ name, description: name, inputSchema: { type: "object" } })) };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

const run = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
  (tool.execute as (id: string, p: unknown) => Promise<{ isError?: boolean; content?: { text: string }[] }>)("t", params);

test("a catalog MCP uses the enterprise catalog address and only declared tools; unknown refs need a user URL", async () => {
  const fixture = await createFixture();
  const { server, url } = await mcpServer(["search", "export"]);
  try {
    let entries: InstallableMcpInfo[] = [{ server_id: "s1", ref: "mes", display_name: "MES 查询", summary: "", url, tools: ["search", "delete"], revision: 1 }];
    let down = false;
    const mcps = { list: async () => { if (down) throw new Error("down"); return entries; } };

    // The model's URL is ignored for a catalog ref; the summary says platform_catalog.
    const check = await checkCapabilityInstall(fixture.store, owner, { kind: "mcp", ref: "mes", url: "https://evil.example/mcp", reason: "查批次" }, undefined, undefined, mcps);
    assert(check.ok);
    assert.deepEqual([check.platform, check.replaces, check.kind], [true, false, "mcp"]);
    assert.deepEqual([JSON.parse(check.summary).source, JSON.parse(check.summary).url], ["platform_catalog", url]);

    const install = capabilityInstallTool(fixture.store, owner, undefined, mcps);
    assert.notEqual((await run(install, { kind: "mcp", ref: "mes", url: "https://evil.example/mcp", reason: "查批次" })).isError, true);
    const [row] = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId);
    // Intersection of advertised (search, export) and declared (search, delete).
    assert.deepEqual([row?.url, row?.tools, row?.source, row?.source_ref, row?.approved_by], [url, ["search"], "platform_catalog", "s1", "member-1"]);

    // Not in the catalog and no URL: bounced before the prompt; catalog down says try later.
    const missing = await checkCapabilityInstall(fixture.store, owner, { kind: "mcp", ref: "ghost", reason: "" }, undefined, undefined, mcps);
    assert.match(missing.ok ? "" : missing.message, /管理员/);
    down = true;
    const unavailable = await checkCapabilityInstall(fixture.store, owner, { kind: "mcp", ref: "ghost", reason: "" }, undefined, undefined, mcps);
    assert.match(unavailable.ok ? "" : unavailable.message, /稍后再试/);
    // With a URL the manual flow still works (never auto-installable).
    const manual = await checkCapabilityInstall(fixture.store, owner, { kind: "mcp", ref: "ghost", url, reason: "" }, undefined, undefined, mcps);
    assert(manual.ok);
    assert.equal(manual.platform, false);

    // A catalog entry with none of the server's tools is not installed.
    down = false;
    entries = [{ ...entries[0]!, ref: "nodecl", server_id: "s2", tools: ["other"] }];
    assert.equal((await run(install, { kind: "mcp", ref: "nodecl", reason: "" })).isError, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fixture.close();
  }
});

test("a platform-origin skill is a platform_catalog install; an enterprise-built one is not", async () => {
  const fixture = await createFixture();
  try {
    const catalog = [
      { skill_id: "plat", display_name: "平台", version: "1", content_hash: "h", source_skill_id: "p1", origin: "platform" as const },
      { skill_id: "own", display_name: "自建", version: "1", content_hash: "h", source_skill_id: "" },
    ];
    const skills = { list: async () => catalog, install: async () => undefined };
    const platform = await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "plat", reason: "" }, skills);
    const own = await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "own", reason: "" }, skills);
    assert.deepEqual([platform.ok && platform.platform, own.ok && own.platform], [true, false]);

    const install = capabilityInstallTool(fixture.store, owner, skills);
    assert.notEqual((await run(install, { kind: "skill", ref: "plat", reason: "", autoApproved: true })).isError, true);
    const row = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.ref === "plat");
    assert.deepEqual([row?.source, row?.approved_by], ["platform_catalog", AUTO_INSTALL_APPROVER]);

    // An auto-approval never covers a non-platform install or one that would replace something.
    assert.equal((await run(install, { kind: "skill", ref: "own", reason: "", autoApproved: true })).isError, true);
    catalog[0] = { ...catalog[0]!, version: "2" };
    assert.equal((await run(install, { kind: "skill", ref: "plat", reason: "", autoApproved: true, resolution: { action: "replace" } })).isError, true);
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.ref === "plat")?.version, "1");
  } finally { await fixture.close(); }
});

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-autoinstall-test-"));
  return { root, store: new AgentSqliteStore(join(root, "agent.sqlite")) };
}

const installRequest = (source: string, overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", sessionId: "session-1",
  snapshotVersion: "snapshot-1", permissionRevision: "1:read-only", toolCallId: `call-${source}`, toolName: "capability_install",
  args: { kind: "mcp", ref: "mes" }, summary: `capability_install: ${JSON.stringify({ kind: "mcp", ref: "mes", source })}`,
  riskLevel: "unknown" as const, permissionMode: "read-only" as const, ...overrides,
});

test("remember is accepted only when approving a platform-catalog install, and records the grant for that kind", async () => {
  const { root, store } = storeFixture();
  try {
    const required: ReturnType<ApprovalService["list"]> = [];
    const service = new ApprovalService(store, { onRequired: (record) => { required.push(record); } });
    const decide = (id: string, decision: "approve" | "deny", key: string) =>
      service.decide({ id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision, approvedBy: "member-1", idempotencyKey: key, remember: true });

    const manual = service.execute(installRequest("user_url"), async () => "manual");
    const platform = service.execute(installRequest("platform_catalog"), async () => "platform");
    while (required.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const [manualRecord, platformRecord] = [required.find(r => r.tool_call_id === "call-user_url")!, required.find(r => r.tool_call_id === "call-platform_catalog")!];

    assert.throws(() => decide(manualRecord.id, "approve", "k1"), ApprovalRememberError);
    assert.throws(() => decide(platformRecord.id, "deny", "k2"), ApprovalRememberError);
    assert.equal(store.hasCapabilityAutoInstall("tenant-1", "member-1", "mcp"), false);

    decide(platformRecord.id, "approve", "k3");
    assert.equal(await platform, "platform");
    assert.deepEqual(store.listCapabilityAutoInstall("tenant-1", "member-1").map(item => item.kind), ["mcp"]);
    assert.equal(store.hasCapabilityAutoInstall("tenant-1", "member-1", "skill"), false);
    assert.equal(store.hasCapabilityAutoInstall("tenant-1", "member-2", "mcp"), false);
    manual.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("autoApproveBy approves a capability install by policy without a prompt, and is ignored for other tools", async () => {
  const { root, store } = storeFixture();
  try {
    let prompts = 0;
    const service = new ApprovalService(store, { onRequired: () => { prompts += 1; } });
    assert.equal(await service.execute(installRequest("platform_catalog", { autoApproveBy: AUTO_INSTALL_APPROVER }), async () => "installed"), "installed");
    assert.equal(prompts, 0);
    const [audit] = service.list("conversation-1", "tenant-1", "member-1");
    assert.deepEqual([audit?.status, audit?.approved_by], ["succeeded", AUTO_INSTALL_APPROVER]);

    const other = service.execute(installRequest("x", { toolName: "connector:jira", riskLevel: "external", toolCallId: "call-other", autoApproveBy: AUTO_INSTALL_APPROVER }), async () => "nope");
    while (prompts === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.list("conversation-1", "tenant-1", "member-1").find(r => r.tool_call_id === "call-other")?.status, "pending");
    other.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an older local_capability table is rebuilt to accept platform_catalog and keeps its rows", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-autoinstall-migrate-"));
  const path = join(root, "agent.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE local_capability (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mcp', 'skill')), ref TEXT NOT NULL,
      display_name TEXT NOT NULL, url TEXT NOT NULL, tools_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user_url', 'enterprise_catalog')), version TEXT NOT NULL DEFAULT '',
      source_ref TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, member_id, kind, ref));
      INSERT INTO local_capability VALUES ('tenant-1', 'member-1', 'skill', 'sheet', '读表', '', '[]', 'enterprise_catalog', '1', 'p1', '', 'member-1', '2026-11-17T00:00:00.000Z');`);
    legacy.close();
    const store = new AgentSqliteStore(path);
    try {
      assert.deepEqual(store.listLocalCapabilities("tenant-1", "member-1").map(item => [item.ref, item.version, item.source_ref]), [["sheet", "1", "p1"]]);
      store.putLocalCapability("tenant-1", "member-1", { kind: "mcp", ref: "mes", display_name: "MES", url: "https://mcp.example.com/mes", tools: ["a"], source: "platform_catalog", reason: "", approved_by: AUTO_INSTALL_APPROVER });
      assert.equal(store.listLocalCapabilities("tenant-1", "member-1").length, 2);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("auto-install grants are listed and revoked per owner over HTTP", async () => {
  const fixture = await createFixture();
  fixture.store.putCapabilityAutoInstall("tenant-1", "member-1", "mcp");
  fixture.store.putCapabilityAutoInstall("tenant-1", "member-2", "skill");
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test" };
  try {
    const listed = await (await fetch(`${base}/api/agent/capabilities/auto-install`, { headers })).json() as { data: { kind: string }[] };
    assert.deepEqual(listed.data.map(item => item.kind), ["mcp"]);
    assert.equal((await fetch(`${base}/api/agent/capabilities/auto-install/skill`, { method: "DELETE", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/agent/capabilities/auto-install/mcp`, { method: "DELETE", headers })).status, 200);
    assert.deepEqual(fixture.store.listCapabilityAutoInstall("tenant-1", "member-1"), []);
    assert.equal(fixture.store.hasCapabilityAutoInstall("tenant-1", "member-2", "skill"), true);
  } finally {
    await http.close();
    await fixture.close();
  }
});
