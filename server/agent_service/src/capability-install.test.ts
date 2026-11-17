import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFixture } from "./test-fixture.js";
import { approvalRiskForTool } from "./approval-service.js";
import { capabilityInstallTool, personalConnectorTools } from "./connectors.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };
const snapshot: Record<string, unknown> = { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "E", tools: [] };
const snap = (extra: Record<string, unknown> = {}) => ({ ...snapshot, ...extra }) as never;

async function mcpServer(calls: string[]) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "search", description: "s", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "ok" }] };
    if (message.method === "tools/call") calls.push(message.params.name);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

const run = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
  (tool.execute as (id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<{ isError?: boolean }>)("t", params, undefined, undefined, {});

test("installing asks for a human decision, stores the real tool list, and the personal tool is owner-scoped and approval-gated", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];
  const { server, url } = await mcpServer(calls);
  try {
    // 安装工具与个人连接器调用都必须经人工审批。
    assert.equal(approvalRiskForTool("capability_install"), "unknown");
    assert.equal(approvalRiskForTool("connector_my_notion"), "external");

    const install = capabilityInstallTool(fixture.store, owner);
    const ok = await run(install, { kind: "mcp", ref: "notion", display_name: "Notion", url, reason: "读页面" });
    assert.notEqual(ok.isError, true);
    const stored = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId);
    assert.deepEqual(stored.map(item => [item.ref, item.tools, item.source, item.approved_by]), [["notion", ["search"], "user_url", "member-1"]]);
    assert.deepEqual(fixture.store.listLocalCapabilities(owner.tenantId, "member-2"), []);

    const [tool] = personalConnectorTools(fixture.store, owner, snap());
    assert.equal(tool?.name, "connector_my_notion");
    await run(tool!, { tool: "search", arguments: {} });
    assert.deepEqual(calls, ["search"]);
    await assert.rejects(run(tool!, { tool: "delete", arguments: {} }));
    assert.deepEqual(personalConnectorTools(fixture.store, { ...owner, memberId: "member-2" }, snap()), []);

    // 员工快照里的显式工具白名单可以排除个人连接器。
    assert.deepEqual(personalConnectorTools(fixture.store, owner, snap({ tool_policy: { allowed_tools: ["read"] } })), []);

    // 撤销后立即失效。
    assert.equal(fixture.store.deleteLocalCapability(owner.tenantId, owner.memberId, "mcp", "notion"), true);
    assert.deepEqual(personalConnectorTools(fixture.store, owner, snap()), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fixture.close();
  }
});

test("install refuses unsafe or invalid requests without storing anything", async () => {
  const fixture = await createFixture();
  try {
    const install = capabilityInstallTool(fixture.store, owner);
    for (const input of [
      { ref: "x", url: "http://example.com/mcp" },          // 明文非本机
      { ref: "x", url: "https://user:pw@example.com/mcp" },  // 带凭据
      { ref: "x", url: "https://example.com/mcp?token=1" },  // 查询串
      { ref: "Bad Ref", url: "https://example.com/mcp" },    // 非法 ref
      { ref: "x", url: "http://127.0.0.1:1/mcp" },           // 连不上
    ]) {
      const result = await run(install, { kind: "mcp", display_name: "X", reason: "", ...input });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId), []);
  } finally { await fixture.close(); }
});

import { recommendedCapabilityContext } from "./pi/session-host.js";

test("recommended capabilities become a bounded, non-authorizing hint", () => {
  assert.equal(recommendedCapabilityContext(undefined), "");
  assert.equal(recommendedCapabilityContext([{ kind: "bad", ref: "x" }, null, { kind: "mcp" }]), "");
  const text = recommendedCapabilityContext([
    { kind: "skill", ref: "sk-1", purpose: "读表" },
    { kind: "mcp", ref: "mes", display_name: "MES", purpose: "读取工单" },
  ]);
  assert.match(text, /skill sk-1：读表；MCP MES（mes）：读取工单/);
  assert.match(text, /并未安装或授权/);
});
