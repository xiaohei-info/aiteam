import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "./test-fixture.js";
import { authorizedConnectors, connectorTools, enterpriseMcpServerIds, startMcpRelogin, validateConnectorSelection, type McpRuntimeAuth } from "./connectors.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };
test("local MCP is owner/grant scoped, uses current installation, redacts credentials, and uses the existing approval gate", async () => {
  const fixture = await createFixture();
  const oldPath = process.env.AITEAM_CONNECTORS_FILE;
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
      : { content: [{ type: "text", text: `test-result ${process.env.AITEAM_CONNECTOR_TEST_TOKEN}` }] };
    if (message.method === "tools/call") { calls++; assert.equal(req.headers.authorization, "Bearer secret-for-test"); }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const file = join(fixture.root, "connectors.json");
  const config = { ...owner, connector_id: "notion", display_name: "Notion", url: `http://127.0.0.1:${address.port}/mcp`, tools: ["search"], token_env: "AITEAM_CONNECTOR_TEST_TOKEN" };
  process.env.AITEAM_CONNECTORS_FILE = file; process.env.AITEAM_CONNECTOR_TEST_TOKEN = "secret-for-test";
  writeFileSync(file, JSON.stringify([config]), { mode: 0o600 });
  const expert = { employee_id: "e1", tenant_id: owner.tenantId, member_id: owner.memberId, version: "1", handle: "e1", display_name: "Researcher", revoked: false, synced_at: new Date().toISOString(), connector_refs: ["notion"] };
  const snapshot = { ...expert, snapshot_version: "snapshot-1", tools: [] };
  fixture.store.replaceProjections([expert], [], [snapshot]);
  fixture.store.createConversation({ id: "mcp", ...owner, entryEmployeeId: "e1", kind: "private" });
  try {
    assert.equal(authorizedConnectors(fixture.store, owner, "e1")[0]?.status, "enabled");
    assert.deepEqual(authorizedConnectors(fixture.store, { ...owner, memberId: "member-2" }), []);
    assert.throws(() => validateConnectorSelection(fixture.store, owner, "unauthorized", ["notion"]));
    fixture.store.replaceProjections([expert], [], [{ ...snapshot, tool_policy: { allowed_tools: ["read"] } }]);
    assert.deepEqual(authorizedConnectors(fixture.store, owner, "e1"), []);
    fixture.store.replaceProjections([expert], [], [snapshot]);
    const tool = connectorTools(fixture.store, owner, "e1", "mcp", snapshot)[0]!;
    const result = await tool.execute("test", { tool: "search", arguments: { q: "report" } }, undefined, undefined, {} as never);
    assert.equal(calls, 1); assert(!JSON.stringify(result).includes("secret-for-test"));
    await assert.rejects(async () => tool.execute("bad", { tool: "delete", arguments: {} }, undefined, undefined, {} as never));
    fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall("connector_notion", { tool: "search", arguments: { q: "approved" } }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const running = fixture.host.prompt("mcp", "search", undefined, { callerId: owner.memberId, userId: owner.memberId, tenantId: owner.tenantId });
    let approvals = fixture.host.approvalService.list("mcp", owner.tenantId, owner.memberId);
    for (let i = 0; i < 100 && !approvals.length; i++) { await new Promise(resolve => setTimeout(resolve, 10)); approvals = fixture.host.approvalService.list("mcp", owner.tenantId, owner.memberId); }
    assert.equal(approvals.length, 1); assert.equal(calls, 1, "external call must wait for approval");
    fixture.host.approvalService.decide({ id: approvals[0]!.id, tenantId: owner.tenantId, memberId: owner.memberId, conversationId: "mcp", decision: "approve", approvedBy: owner.memberId, idempotencyKey: "approve-1" });
    await running; assert.equal(calls, 2);
    fixture.store.replaceProjections([], [], [], ["e1"], owner);
    await assert.rejects(async () => tool.execute("revoked", { tool: "search", arguments: {} }, undefined, undefined, {} as never));
    assert.equal(calls, 2);
  } finally {
    if (oldPath === undefined) delete process.env.AITEAM_CONNECTORS_FILE; else process.env.AITEAM_CONNECTORS_FILE = oldPath;
    delete process.env.AITEAM_CONNECTOR_TEST_TOKEN;
    await fixture.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// 授权跟着安装走（设计 2026-11-19 §3.2 / §3.4）：只有企业目录 MCP 上报，标识用平台 server_id。
test("enterpriseMcpServerIds keeps only installed enterprise catalog MCP server ids", () => {
  assert.deepEqual(enterpriseMcpServerIds([
    { kind: "mcp", source: "platform_catalog", source_ref: "s9" },
    { kind: "mcp", source: "platform_catalog", source_ref: "s9" },
    { kind: "mcp", source: "platform_catalog", source_ref: "" },
    { kind: "mcp", source: "user_url", source_ref: "" },
    { kind: "skill", source: "platform_catalog", source_ref: "skill-1" },
    { kind: "skill", source: "clawhub_catalog", source_ref: "x" },
  ]), ["s9"]);
});

test("relogin of an enterprise catalog MCP reports the grant before signing in", async () => {
  const fixture = await createFixture();
  const order: string[] = [];
  try {
    const owner = { tenantId: "tenant-1", memberId: "member-1" };
    fixture.store.putLocalCapability("tenant-1", "member-1", { kind: "mcp", ref: "crm", display_name: "CRM", url: "https://crm.example.com/mcp", tools: ["a"], source: "platform_catalog", source_ref: "s9", reason: "", approved_by: "member-1", auth: "oauth" });
    const auth = {
      service: { credentials: { get: () => undefined }, login: async () => { order.push("login"); return { done: Promise.resolve() }; } },
      catalog: { list: async () => [], oauthClient: async () => ({ client_id: "app-1" }), grant: async (id: string) => { order.push(`grant:${id}`); } },
    } as unknown as McpRuntimeAuth;
    assert.deepEqual(await startMcpRelogin(fixture.store, owner, auth, "crm"), { found: true });
    assert.deepEqual(order, ["grant:s9", "login"]);
  } finally { await fixture.close(); }
});
