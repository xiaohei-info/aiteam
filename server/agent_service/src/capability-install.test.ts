import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./test-fixture.js";
import { CustomSkillStore } from "./custom-skills.js";
import { fakeClawHub } from "./custom-skill-import.test.js";
import { approvalRiskForTool, personalConnectorRisk } from "./approval-service.js";
import { capabilityInstallTool, checkCapabilityInstall, installSkillDirectly, personalConnectorTools, SkillInstallError } from "./connectors.js";
import { SkillVerificationError } from "./skills.js";

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
    // 安装工具必须经人工审批；成员自己装的 MCP 默认不再每次弹（只读会话例外，见下方）。
    assert.equal(approvalRiskForTool("capability_install"), "unknown");
    assert.equal(approvalRiskForTool("connector_my_notion"), undefined);
    assert.equal(personalConnectorRisk("connector_my_notion", "read-only"), "external");
    assert.equal(personalConnectorRisk("connector_my_notion", "workspace-write"), undefined);
    assert.equal(personalConnectorRisk("connector_my_notion", "full-access"), undefined);
    // 企业配置的连接器仍然每次弹。
    assert.equal(approvalRiskForTool("connector_notion"), "external");

    const install = capabilityInstallTool(fixture.store, owner);
    const ok = await run(install, { kind: "mcp", ref: "notion", display_name: "Notion", url, reason: "读页面" });
    assert.notEqual(ok.isError, true);
    const stored = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId);
    assert.deepEqual(stored.map(item => [item.ref, item.tools, item.source, item.approved_by]), [["notion", ["search"], "user_url", "member-1"]]);
    assert.deepEqual(fixture.store.listLocalCapabilities(owner.tenantId, "member-2"), []);

    const [tool] = personalConnectorTools(fixture.store, owner);
    assert.equal(tool?.name, "connector_my_notion");
    await run(tool!, { tool: "search", arguments: {} });
    assert.deepEqual(calls, ["search"]);
    await assert.rejects(run(tool!, { tool: "delete", arguments: {} }));
    assert.deepEqual(personalConnectorTools(fixture.store, { ...owner, memberId: "member-2" }), []);

    // 个人 MCP 属于成员自己的 Agent 能力，不受专家快照工具白名单限制（设计 2026-11-17 §10）：
    // 企业专家配了显式工具清单时照样可用，调用仍经审批（见上方 external 风险）。
    assert.deepEqual(personalConnectorTools(fixture.store, owner).map(item => item.name), ["connector_my_notion"]);

    // 撤销后立即失效。
    assert.equal(fixture.store.deleteLocalCapability(owner.tenantId, owner.memberId, "mcp", "notion"), true);
    assert.deepEqual(personalConnectorTools(fixture.store, owner), []);
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

import { recommendedCapabilityContext, soloSolutionContext } from "./pi/session-host.js";

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
    assert.deepEqual([row?.kind, row?.ref, row?.version, row?.source, row?.url, row?.source_ref], ["skill", "sheet", "1", "enterprise_catalog", "", "plat-sheet"]);

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

test("solo solution context matches only applied solo solutions whose single member is the employee", () => {
  const base = { tenant_id: "t", member_id: "m", version: "1" };
  const text = soloSolutionContext([
    { ...base, solution_instance_id: "a", display_name: "单人 A", mode: "solo", status: "applied", expert_employee_ids: ["e1"], recommended_capabilities: [{ kind: "mcp", ref: "mes" }] },
    // 旧方案没有 mode：按专家数推断。
    { ...base, solution_instance_id: "b", display_name: "旧单人 B", expert_employee_ids: ["e1"] },
    { ...base, solution_instance_id: "c", display_name: "组群 C", mode: "group", status: "applied", expert_employee_ids: ["e1", "e2"] },
    { ...base, solution_instance_id: "d", display_name: "已撤销 D", mode: "solo", status: "revoked", expert_employee_ids: ["e1"] },
    { ...base, solution_instance_id: "e", display_name: "别人 E", mode: "solo", status: "applied", expert_employee_ids: ["e2"] },
  ], "e1");
  assert.match(text, /单人 A/);
  assert.match(text, /MCP mes/);
  assert.match(text, /旧单人 B/);
  assert.doesNotMatch(text, /组群 C|已撤销 D|别人 E/);
  assert.equal(soloSolutionContext([], "e1"), "");
});

test("a re-install whose package fails signature verification is refused and the installed version keeps working", async () => {
  const fixture = await createFixture();
  try {
    let catalog = [{ skill_id: "sheet", display_name: "读表", version: "1", content_hash: "h1", source_skill_id: "plat-sheet" }];
    let failWith: Error | undefined;
    const skills = {
      list: async () => catalog,
      install: async () => { if (failWith) throw failWith; },
    };
    const install = capabilityInstallTool(fixture.store, owner, skills);
    assert.notEqual((await run(install, { kind: "skill", ref: "sheet", reason: "" })).isError, true);

    // 企业换了签名密钥后，新包验签不过：明确「不可以安装」，并说明已装版本仍可用。
    catalog = [{ ...catalog[0]!, version: "2", content_hash: "h2" }];
    failWith = new SkillVerificationError("unknown skill signing key id");
    const refused = await run(install, { kind: "skill", ref: "sheet", reason: "", resolution: { action: "replace" } }) as { isError?: boolean; content?: { text: string }[] };
    assert.equal(refused.isError, true);
    assert.match(refused.content?.[0]?.text ?? "", /不可以安装.*已装的 1 版不受影响，仍可继续使用/);
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0]?.version, "1");

    // 企业服务不可用：不是「不可以安装」，是稍后再试。
    failWith = new Error("manager down");
    const later = await run(install, { kind: "skill", ref: "sheet", reason: "", resolution: { action: "replace" } }) as { content?: { text: string }[] };
    assert.match(later.content?.[0]?.text ?? "", /稍后再试/);
  } finally { await fixture.close(); }
});


test("the desktop «添加技能» installs only enterprise-catalog skills, like an approved chat install", async () => {
  const fixture = await createFixture();
  try {
    let catalog = [{ skill_id: "sheet", display_name: "读表", version: "1", content_hash: "h1", source_skill_id: "plat-sheet" }];
    const installed: string[] = [];
    let failWith: Error | undefined;
    const skills = {
      list: async () => catalog,
      install: async (skillId: string) => { if (failWith) throw failWith; installed.push(`${skillId}@${catalog.find(item => item.skill_id === skillId)?.version}`); },
    };
    const code = async (run: Promise<unknown>) => { try { await run; return "ok"; } catch (error) { assert(error instanceof SkillInstallError); return error.code; } };

    // 没有企业服务 / 不在企业目录：不装。
    assert.equal(await code(installSkillDirectly(fixture.store, owner, undefined, { skill_id: "sheet" })), "manager_unavailable");
    assert.equal(await code(installSkillDirectly(fixture.store, owner, skills, { skill_id: "ghost" })), "skill_not_installable");
    assert.deepEqual(installed, []);

    // 平台 skill ID 也能对应到企业目录条目；记录由本人批准。
    const row = await installSkillDirectly(fixture.store, owner, skills, { skill_id: "plat-sheet" });
    assert.deepEqual([row.kind, row.ref, row.version, row.source, row.approved_by, row.source_ref], ["skill", "sheet", "1", "enterprise_catalog", "member-1", "plat-sheet"]);
    assert.deepEqual(installed, ["sheet@1"]);
    assert.equal(await code(installSkillDirectly(fixture.store, owner, skills, { skill_id: "sheet" })), "skill_installed");

    // 新版本：不确认不换；确认后换。
    catalog = [{ ...catalog[0]!, version: "2", content_hash: "h2" }];
    assert.equal(await code(installSkillDirectly(fixture.store, owner, skills, { skill_id: "sheet" })), "skill_exists");
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0]?.version, "1");

    // 签名校验不过 / 企业服务不可用：已装版本不动。
    failWith = new SkillVerificationError("unknown skill signing key id");
    assert.equal(await code(installSkillDirectly(fixture.store, owner, skills, { skill_id: "sheet", replace: true })), "skill_signature_invalid");
    failWith = new Error("manager down");
    assert.equal(await code(installSkillDirectly(fixture.store, owner, skills, { skill_id: "sheet", replace: true })), "skill_install_failed");
    assert.equal(fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId)[0]?.version, "1");

    failWith = undefined;
    assert.equal((await installSkillDirectly(fixture.store, owner, skills, { skill_id: "sheet", replace: true })).version, "2");
    assert.deepEqual(installed, ["sheet@1", "sheet@2"]);
  } finally { await fixture.close(); }
});

test("外部来源的技能（ClawHub / 网址 / 粘贴）也能装，装的是成员个人能力", async () => {
  const fixture = await createFixture();
  const custom = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const { url: clawHub, close } = await fakeClawHub("alice");
  const md = `---\nname: pasted-skill\ndescription: 粘贴进来的技能\n---\n\n正文\n`;
  try {
    process.env.AITEAM_CLAWHUB_BASE_URL = clawHub;
    const install = capabilityInstallTool(fixture.store, owner, undefined, undefined, undefined, custom);

    // ClawHub：地址即来源，装完标 clawhub_catalog，文件在本机目录里。
    const hub = await run(install, { kind: "skill", source: "clawhub", ref: "weekly-report", url: `${clawHub}/alice/skills/self-improving-agent`, reason: "做周报" });
    assert.notEqual(hub.isError, true);
    let row = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.ref === "weekly-report");
    assert.deepEqual([row?.source, row?.display_name], ["clawhub_catalog", "weekly-report"]);
    assert.ok(custom.pathFor(owner, "weekly-report"), "ClawHub 技能应落到本机自定义技能目录");

    // 粘贴：skill_md 即来源。
    const pasted = await run(install, { kind: "skill", source: "text", ref: "pasted-skill", skill_md: md, reason: "试试" });
    assert.notEqual(pasted.isError, true);
    row = fixture.store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.ref === "pasted-skill");
    assert.equal(row?.source, "user_import");

    // 批准后内容变了：哈希对不上，拒绝安装。
    const stale = await run(install, { kind: "skill", source: "text", ref: "pasted-skill", skill_md: md, reason: "", approvedVersion: "deadbeef".repeat(4), resolution: { action: "replace" } });
    assert.equal(stale.isError, true);
    assert.match(String((stale as { content?: { text: string }[] }).content?.[0]?.text ?? ""), /内容.*变化/);
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
  } finally {
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
    await close();
    await fixture.close();
  }
});
