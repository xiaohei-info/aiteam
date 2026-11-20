import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ApprovalDeniedError, ApprovalRememberError, ApprovalService, ApprovalSessionAllowError, ApprovalSkippedError, POLICY_APPROVER, SESSION_GRANT_APPROVER, approvalRiskForTool, isPersonalConnectorTool, personalConnectorRisk } from "./approval-service.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1",
  sessionId: "session-1", snapshotVersion: "snapshot-1", permissionRevision: "1:workspace-write", toolCallId: "call-1",
  toolName: "bash", args: { command: "printf safe" }, riskLevel: "bash" as const, permissionMode: "workspace-write" as const,
  ...overrides,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-approval-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  return { root, store };
}

test("approval classification gates every requested side-effect class and keeps trusted reads free", () => {
  assert.equal(approvalRiskForTool("bash"), "bash");
  assert.equal(approvalRiskForTool("write"), "write");
  assert.equal(approvalRiskForTool("edit"), "edit");
  assert.equal(approvalRiskForTool("connector:jira"), "external");
  assert.equal(approvalRiskForTool("future_tool"), "unknown");
  assert.equal(approvalRiskForTool("read"), undefined);
});

test("member-installed MCP connectors skip the per-call prompt, except in a read-only conversation", () => {
  // 成员自己装在本机的 MCP：装的时候已授权过，之后调用不再每次弹框。
  assert.equal(isPersonalConnectorTool("connector_my_notion"), true);
  assert.equal(approvalRiskForTool("connector_my_notion"), undefined);
  assert.equal(personalConnectorRisk("connector_my_notion", "workspace-write"), undefined);
  assert.equal(personalConnectorRisk("connector_my_notion", "full-access"), undefined);
  // 只读会话不允许写：仍然弹框，让用户看到“这次调用不被允许”。
  assert.equal(personalConnectorRisk("connector_my_notion", "read-only"), "external");
  // 企业配置的连接器与名字相近的其他工具不受影响。
  assert.equal(isPersonalConnectorTool("connector_notion"), false);
  assert.equal(isPersonalConnectorTool("connector_my_"), false);
  assert.equal(approvalRiskForTool("connector_notion"), "external");
  assert.equal(personalConnectorRisk("connector_notion", "read-only"), undefined);
});

test("approval is pending before the operation, CAS-approved, and consumed once", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    let executions = 0;
    const pending = service.execute(request(), async () => { executions += 1; return "done"; });
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 0);
    assert.equal(required.status, "pending");
    const approved = service.decide({ id: required.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "decision-1" });
    assert.equal(approved.status, "approved");
    assert.equal(await pending, "done");
    assert.equal(executions, 1);
    assert.equal(store.getApprovalRecord(required.id)?.status, "succeeded");
    await assert.rejects(service.execute(request(), async () => { executions += 1; return "duplicate"; }), ApprovalDeniedError);
    assert.equal(executions, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission changes and owner cancellation cannot execute an old approval", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const pending = service.execute(request(), async () => "must-not-run");
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.execute(request({ permissionRevision: "2:workspace-write" }), async () => "changed"), /binding changed/);
    service.cancelOwner("tenant-1", "member-1");
    await assert.rejects(pending, /cancelled/);
    assert.equal(store.getApprovalRecord(required.id)?.status, "invalidated");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("logout/abort cancellation makes an executing approval uncertain and blocks late success", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const pending = service.execute(request(), async () => { await gate; return "late-result"; });
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    service.decide({ id: required.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "decision-executing" });
    while (store.getApprovalRecord(required.id)?.status !== "executing") await new Promise((resolve) => setImmediate(resolve));
    service.cancelOwner("tenant-1", "member-1");
    assert.equal(store.getApprovalRecord(required.id)?.status, "uncertain");
    release();
    assert.equal(await pending, "late-result");
    assert.equal(store.getApprovalRecord(required.id)?.status, "uncertain");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-access auto-approves local bash/write/edit by policy without a prompt but still audits, caps by lease, and gates external tools", async () => {
  const { root, store } = fixture();
  try {
    let required = 0;
    const service = new ApprovalService(store, { onRequired: () => { required += 1; } });
    const full = { permissionMode: "full-access" as const, permissionRevision: "1:full-access" };
    assert.equal(await service.execute(request(full), async () => "ran"), "ran");
    assert.equal(required, 0);
    const [audit] = service.list("conversation-1", "tenant-1", "member-1");
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.approved_by, POLICY_APPROVER);
    assert.equal(audit.consumed, true);
    // The same tool call cannot be replayed through the policy path.
    await assert.rejects(service.execute(request(full), async () => "again"), ApprovalDeniedError);
    // The lease/JWT cutoff still bounds policy approval.
    await assert.rejects(service.execute(request({ ...full, toolCallId: "call-expired", expiresAt: Date.now() - 1 }), async () => "late"), /expired/i);
    const pending = service.execute(request({ ...full, toolName: "connector:jira", riskLevel: "external", toolCallId: "call-2" }), async () => "x");
    while (required === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.list("conversation-1", "tenant-1", "member-1").find((record) => record.tool_call_id === "call-2")?.status, "pending");
    pending.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("approval summary preserves command file paths", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const command = "cp '/Users/chendian/a.txt' '/Users/chendian/b.txt'";
    const pending = service.execute(request({ args: { command } }), async () => "ok");
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(required.redacted_summary.includes("/Users/chendian/a.txt"), true);
    assert.equal(required.redacted_summary.includes("[路径已隐藏]"), false);
    service.decide({ id: required.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "test-path" });
    assert.equal(await pending, "ok");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_allow stops asking for that external tool in this conversation only", async () => {
  const { root, store } = fixture();
  try {
    let required = 0;
    const service = new ApprovalService(store, { onRequired: () => { required += 1; } });
    const external = { toolName: "connector:jira", riskLevel: "external" as const, permissionMode: "workspace-write" as const, permissionRevision: "1:workspace-write" };
    // 第一次：照常弹框，成员勾选「本会话不再询问」后批准。
    const first = service.execute(request({ ...external, toolCallId: "call-1" }), async () => "ran");
    while (required === 0) await new Promise((resolve) => setImmediate(resolve));
    const record = service.list("conversation-1", "tenant-1", "member-1").find((item) => item.tool_call_id === "call-1")!;
    assert.equal(record.status, "pending");
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "connector:jira"), false);
    service.decide({ id: record.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k-1", sessionAllow: true });
    assert.equal(await first, "ran");
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "connector:jira"), true);
    // 第二次：同一会话不再弹，按策略自动批准，但仍留审批记录。
    const second = service.execute(request({ ...external, toolCallId: "call-2", args: { issue: "A" } }), async () => "ran-2");
    assert.equal(await second, "ran-2");
    assert.equal(required, 1, "同一会话只弹一次");
    const audit = service.list("conversation-1", "tenant-1", "member-1").find((item) => item.tool_call_id === "call-2")!;
    assert.equal(audit.approved_by, SESSION_GRANT_APPROVER);
    // 换一个会话：授权不跟着走。
    const other = service.execute(request({ ...external, conversationId: "conversation-2", toolCallId: "call-3" }), async () => "x");
    while (required === 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(required, 2, "换会话要重新询问");
    other.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session_allow is refused for local tools and for a denial", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const pending = service.execute(request({ toolName: "bash", riskLevel: "bash", permissionMode: "workspace-write", permissionRevision: "1:workspace-write" }), async () => "x");
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    // decide 同步抛错（不是返回 rejected promise）。
    assert.throws(
      () => service.decide({ id: required.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k", sessionAllow: true }),
      ApprovalSessionAllowError,
    );
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "bash"), false);
    pending.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("deleting the conversation clears its session grants", () => {
  const { root, store } = fixture();
  try {
    store.createConversation({ id: "conversation-1", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
    store.putApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "connector:jira");
    assert.deepEqual(JSON.parse(JSON.stringify(store.listApprovalSessionGrants("tenant-1", "member-1", "conversation-1"))), [{ tool_name: "connector:jira", subject: "" }]);
    assert.equal(store.deleteConversation("conversation-1"), true);
    assert.deepEqual(store.listApprovalSessionGrants("tenant-1", "member-1", "conversation-1"), []);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session_allow 对技能安装生效（本会话），对 MCP 安装不生效", async () => {
  const { root, store } = fixture();
  try {
    let required = 0;
    const service = new ApprovalService(store, { onRequired: () => { required += 1; } });
    const skillInstall = `capability_install:${JSON.stringify({ kind: "skill", ref: "weekly-report", display_name: "周报", version: "2", source: "enterprise_catalog", reason: "" })}`;
    // 技能安装第一次照常弹，勾「本会话不再询问」后批准。
    const first = service.execute(request({ toolName: "capability_install", riskLevel: "unknown", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", summary: skillInstall }), async () => "installed");
    while (required === 0) await new Promise((resolve) => setImmediate(resolve));
    const record = service.list("conversation-1", "tenant-1", "member-1").find((item) => item.status === "pending")!;
    service.decide({ id: record.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k", sessionAllow: true });
    assert.equal(await first, "installed");
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill:enterprise_catalog"), true);
    // 第二次技能安装不再弹（会话授权命中）。
    assert.equal(await service.execute(request({ toolName: "capability_install", riskLevel: "unknown", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId: "call-skill-2", summary: skillInstall }), async () => "again"), "again");
    assert.equal(required, 1, "技能安装只弹一次");
    // MCP 安装是同一个工具名：会话授权不覆盖它，但同工具冷却窗口仍生效 → 不重弹。
    const mcpInstall = `capability_install:${JSON.stringify({ kind: "mcp", ref: "crm", display_name: "CRM", url: "https://crm.example.com/mcp", source: "user_url", reason: "" })}`;
    assert.equal(await service.execute(request({ toolName: "capability_install", riskLevel: "unknown", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId: "call-mcp", summary: mcpInstall }), async () => "mcp"), "mcp");
    assert.equal(required, 1, "同工具冷却窗口内不重弹");
    // 换个工具名（模拟另一个工具）仍走自己的审批，不被这次冷却兼底。
    const other = service.execute(request({ toolName: "connector:jira", riskLevel: "external", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId: "call-other", summary: "" }), async () => "other");
    while (required === 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(required, 2, "不同工具不受同工具冷却影响");
    other.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("session_allow 对 MCP 安装（subject 为空）被拒", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const mcpInstall = `capability_install:${JSON.stringify({ kind: "mcp", ref: "crm", display_name: "CRM", url: "https://crm.example.com/mcp", source: "user_url", reason: "" })}`;
    const pending = service.execute(request({ toolName: "capability_install", riskLevel: "unknown", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", summary: mcpInstall }), async () => "x");
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => service.decide({ id: required.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k", sessionAllow: true }),
      ApprovalSessionAllowError,
    );
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", ""), false);
    pending.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// 回归（#218 复核）：会话授权限来源。外部来源（ClawHub / 网址 / 粘贴）不允许写会话授权，
// 也不能靠旧键 `skill` 命中免问；目录来源（平台 / 企业）仍可授权。
test("session_allow 限来源：外部技能不允许，目录技能允许", async () => {
  const { root, store } = fixture();
  try {
    const service = new ApprovalService(store, { onRequired: () => undefined });
    const external = `capability_install:${JSON.stringify({ kind: "skill", ref: "weather", display_name: "天气", source: "clawhub_catalog", reason: "" })}`;
    const pending = service.execute(request({ toolName: "capability_install", riskLevel: "unknown", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", summary: external }), async () => "x");
    for (let i = 0; i < 2000 && service.list("conversation-1", "tenant-1", "member-1").every((item) => item.status !== "pending"); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const record = service.list("conversation-1", "tenant-1", "member-1").find((item) => item.status === "pending")!;
    assert.throws(
      () => service.decide({ id: record.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k", sessionAllow: true }),
      ApprovalSessionAllowError,
    );
    // 外部来源的 subject 是 skill:external，且旧键 `skill` 不会被写入。
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill:external"), false);
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill"), false);
    pending.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("旧键 skill 仍可读（升级期兼容），但不被当作目录来源重复写入", () => {
  const { root, store } = fixture();
  try {
    store.createConversation({ id: "conversation-1", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
    store.putApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill");
    // 旧客户端写的是 `skill`；按旧键读仍能命中，升级期不会突然每次都弹。
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill"), true);
    // 但新代码写入 / 读取的是带来源的键，不会被旧键冒充。
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill:platform_catalog"), false);
    assert.equal(store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "capability_install", "skill:external"), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// 节流（设计 2026-11-19 §3.1）：同工具冷却窗口内复用上次批准，不重弹；拒绝不自动放行。
test("同工具冷却窗口内复用上次批准，被拒绝的记录不放行", async () => {
  const { root, store } = fixture();
  try {
    let required = 0;
    const service = new ApprovalService(store, { onRequired: () => { required += 1; } });
    const run = (toolCallId: string) => service.execute(request({ toolName: "connector:jira", riskLevel: "external", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId, args: { issue: "A-1" } }), async () => "ok");

    const first = run("call-1");
    while (required === 0) await new Promise((resolve) => setImmediate(resolve));
    const record = service.list("conversation-1", "tenant-1", "member-1").find((item) => item.status === "pending")!;
    service.decide({ id: record.id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve", approvedBy: "member-1", idempotencyKey: "k1" });
    assert.equal(await first, "ok");
    // 冷却窗口内、不同参数的同工具调用不再弹。
    assert.equal(await run("call-2"), "ok");
    assert.equal(required, 1, "冷却窗口内不重弹");

    // 拒绝过的记录不作为放行依据：另一会话里同工具仍要弹。
    const other = service.execute(request({ conversationId: "conversation-2", toolName: "connector:jira", riskLevel: "external", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId: "call-3", args: { issue: "A-1" } }), async () => "ok");
    while (required === 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(required, 2, "跨会话不共享冷却");
    other.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// 无人值守（设计 2026-11-19 §3.1）：定时任务里未授权的动作不弹框、跳过并记录，不中止整次运行。
test("无人值守时未授权动作被跳过而不是中止", async () => {
  const { root, store } = fixture();
  try {
    let required = 0;
    const service = new ApprovalService(store, { onRequired: () => { required += 1; } });
    const unattended = service.execute(request({ toolName: "connector:jira", riskLevel: "external", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", unattended: true }), async () => "ok");
    await assert.rejects(unattended, ApprovalSkippedError);
    assert.equal(required, 0, "无人值守不弹审批");

    // 交互会话同样动作仍正常弹。
    const interactive = service.execute(request({ toolName: "connector:jira", riskLevel: "external", permissionMode: "workspace-write", permissionRevision: "1:workspace-write", toolCallId: "call-2" }), async () => "ok");
    while (required === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(required, 1);
    interactive.catch(() => undefined);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
