import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFixture } from "./test-fixture.js";
import { approvalRiskForTool } from "./approval-service.js";
import { capabilityInstallTool, checkCapabilityInstall, personalConnectorTools } from "./connectors.js";

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

test("a same-ref clash goes to the approval dialog; nothing is overwritten unless the user chose replace or rename", async () => {
  const fixture = await createFixture();
  const { server, url } = await mcpServer([]);
  try {
    const install = capabilityInstallTool(fixture.store, owner);
    const input = { kind: "mcp", ref: "notion", display_name: "Notion", url, reason: "读页面" };
    await run(install, input);

    // 同名不再退回模型：照常进审批，摘要带完整新地址与被替换的条目。
    const long = `https://example.com/${"a".repeat(400)}`;
    const clash = await checkCapabilityInstall(fixture.store, owner, { ...input, url: long });
    assert.equal(clash.ok, true);
    const summary = JSON.parse(clash.ok ? clash.summary : "{}");
    assert.equal(summary.url, long);
    assert.deepEqual(summary.replaces, { display_name: "Notion", url });

    // 超长地址、非本机明文地址在审批前被拒绝；全新 ref 没有 replaces。
    assert.equal((await checkCapabilityInstall(fixture.store, owner, { ...input, ref: "y", url: `https://example.com/${"a".repeat(1100)}` })).ok, false);
    assert.equal((await checkCapabilityInstall(fixture.store, owner, { ...input, ref: "x", url: "http://example.com/mcp" })).ok, false);
    const fresh = await checkCapabilityInstall(fixture.store, owner, { ...input, ref: "other" });
    assert.equal(fresh.ok && "replaces" in JSON.parse(fresh.summary), false);

    // 用户没有选择覆盖或改名：不安装。
    assert.equal((await run(install, { ...input, display_name: "Notion 2" })).isError, true);
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0]?.display_name, "Notion");

    // 改名：装到新标识，原条目保留；新标识也被占用则失败。
    assert.notEqual((await run(install, { ...input, display_name: "Notion 副本", resolution: { action: "rename", ref: "notion2" } })).isError, true);
    assert.deepEqual(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).map(item => item.ref).sort(), ["notion", "notion2"]);
    assert.equal((await run(install, { ...input, resolution: { action: "rename", ref: "notion2" } })).isError, true);

    // 覆盖：替换原条目。
    assert.notEqual((await run(install, { ...input, display_name: "Notion 2", resolution: { action: "replace" } })).isError, true);
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.ref === "notion")?.display_name, "Notion 2");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fixture.close();
  }
});

test("a skill can only be installed from the enterprise catalog; a newer version needs the user's replace choice", async () => {
  const fixture = await createFixture();
  try {
    let catalog = [{ skill_id: "sheet", display_name: "读表", version: "1", content_hash: "h1", source_skill_id: "plat-sheet" }];
    const installed: string[] = [];
    const skills = {
      list: async () => catalog,
      install: async (skillId: string) => { installed.push(`${skillId}@${catalog.find(item => item.skill_id === skillId)?.version}`); },
    };
    const install = capabilityInstallTool(fixture.store, owner, skills);

    // 不在企业目录：审批前就退回，提示找管理员；没有 Manager 时也退回。
    const missing = await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "ghost", reason: "" }, skills);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.message, /管理员/);
    assert.equal((await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "sheet", reason: "" })).ok, false);

    // 推荐清单里的平台 skill_id 能对应到企业目录条目。
    const byPlatform = await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "plat-sheet", reason: "读表" }, skills);
    assert.equal(byPlatform.ok, true);
    assert.equal(JSON.parse(byPlatform.ok ? byPlatform.summary : "{}").ref, "sheet");

    assert.notEqual((await run(install, { kind: "skill", ref: "plat-sheet", reason: "读表" })).isError, true);
    assert.deepEqual(installed, ["sheet@1"]);
    const row = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0];
    assert.deepEqual([row?.kind, row?.ref, row?.version, row?.source, row?.url], ["skill", "sheet", "1", "enterprise_catalog", ""]);

    // 同版本已装：不打扰用户。
    assert.equal((await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "sheet", reason: "" }, skills)).ok, false);

    // 新版本：进审批并标明替换；不选覆盖不装，改名不允许，选覆盖才装。
    catalog = [{ ...catalog[0]!, version: "2", content_hash: "h2" }];
    const upgrade = await checkCapabilityInstall(fixture.store, owner, { kind: "skill", ref: "sheet", reason: "" }, skills);
    assert.deepEqual(JSON.parse(upgrade.ok ? upgrade.summary : "{}").replaces, { display_name: "读表", version: "1" });
    assert.equal((await run(install, { kind: "skill", ref: "sheet", reason: "" })).isError, true);
    assert.equal((await run(install, { kind: "skill", ref: "sheet", reason: "", resolution: { action: "rename", ref: "sheet2" } })).isError, true);
    assert.notEqual((await run(install, { kind: "skill", ref: "sheet", reason: "", resolution: { action: "replace" } })).isError, true);
    assert.deepEqual(installed, ["sheet@1", "sheet@2"]);
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0]?.version, "2");
  } finally { await fixture.close(); }
});
