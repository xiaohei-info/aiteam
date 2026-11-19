import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "./test-fixture.js";
import { ApprovalService } from "./approval-service.js";
import { CustomSkillStore, normalizeSkillPackage } from "./custom-skills.js";

const SKILL_MD = `---\nname: weekly-report\ndescription: 把一周的工作记录整理成固定格式的周报\n---\n\n按模板输出周报。\n`;

const owner = { tenantId: "tenant-1", memberId: "member-1" };
const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };

function pendingUsageRows(fixture: Awaited<ReturnType<typeof createFixture>>): number {
  const db = (fixture.store as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
  const rows = db.prepare("SELECT COUNT(*) AS count FROM usage_summary_outbox WHERE kind = 'usage' AND status = 'pending'").all() as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

test("用了成员自己装的 MCP 的运行也计入用量 outbox（口径统一，不再整轮免计）", async () => {
  const fixture = await createFixture();
  const recorded: string[] = [];
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1", permissionMode: "workspace-write" });
    // 成员自己装在本机的 MCP（写入本地能力表，等价于已安装状态）。
    fixture.store.putLocalCapability("tenant-1", "member-1", { kind: "mcp", ref: "notion", display_name: "Notion", url: "http://127.0.0.1:9/mcp", tools: ["search"], source: "user_url", reason: "", approved_by: "member-1" });
    const host = fixture.createHost(undefined, undefined, undefined, undefined, {
      usageRecorder: (_capture, c) => { recorded.push(c.callerId); },
    });
    // 第一次运行：调用个人 MCP 工具 → 整轮照常计入用量
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("connector_my_notion", { tool: "search", arguments: {} }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await host.prompt("conversation-1", "查一下", undefined, caller);
    assert.equal(pendingUsageRows(fixture), 1, "用了个人 MCP 的运行也应产生待上报用量");
    assert.deepEqual(recorded, ["member-1"], "用了个人 MCP 的运行也应触发上报");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("用了本机导入技能的运行也计入用量 outbox", async () => {
  const fixture = await createFixture();
  const root = mkdtempSync(join(tmpdir(), "aiteam-usage-skill-"));
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1", permissionMode: "workspace-write" });
    const store = new CustomSkillStore(root);
    store.install(owner, normalizeSkillPackage([{ path: "SKILL.md", content: Buffer.from(SKILL_MD) }], { kind: "text", label: "粘贴 SKILL.md" }));
    const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
    // Pi 把 /skill: 展开成用户消息里的 <skill name=... location=...>
    const location = store.pathFor(owner, "weekly-report");
    assert.ok(location);
    fixture.faux.setResponses([fauxAssistantMessage("done")]);
    await host.prompt("conversation-1", `<skill name="weekly-report" location="${location}">\n正文\n</skill>`, undefined, caller);
    assert.equal(pendingUsageRows(fixture), 1, "用了本机导入技能的运行也应产生待上报用量");
    await host.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("普通运行（未用个人能力）仍计入用量", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    const host = fixture.createHost();
    fixture.faux.setResponses([fauxAssistantMessage("普通回复")]);
    await host.prompt("conversation-1", "你好", undefined, caller);
    assert.equal(pendingUsageRows(fixture), 1, "普通运行应照常计入用量");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});

test("只读会话调用个人 MCP 仍会弹审批（不静默失败）", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1", permissionMode: "read-only" });
    fixture.store.putLocalCapability("tenant-1", "member-1", { kind: "mcp", ref: "notion", display_name: "Notion", url: "http://127.0.0.1:9/mcp", tools: ["search"], source: "user_url", reason: "", approved_by: "member-1" });
    const host = fixture.createHost(undefined, undefined, undefined, undefined, {
      approvalService: new ApprovalService(fixture.store, { ttlMs: 1_000 }),
    });
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("connector_my_notion", { tool: "search", arguments: {} }), { stopReason: "toolUse" }),
      fauxAssistantMessage("回退回复"),
    ]);
    await host.prompt("conversation-1", "查一下", undefined, caller);
    const approvals = fixture.store.listOwnedApprovalRecords("conversation-1", "tenant-1", "member-1", true);
    assert.equal(approvals.length, 1, "只读会话调用个人 MCP 应产生一条审批记录");
    assert.equal(approvals[0]!.status, "expired");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});
