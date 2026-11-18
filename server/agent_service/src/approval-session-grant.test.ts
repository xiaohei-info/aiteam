import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFixture } from "./test-fixture.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };
const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };

test("HTTP: session_allow 只对 external 审批有效，非布尔值被拒", async () => {
  const fixture = await createFixture();
  try {
    const { AgentHttpServer } = await import("./http/server.js");
    const host = fixture.createHost();
    const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ ...caller, roles: ["member"] }) });
    await http.listen(0);
    const address = http.server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
    try {
      let pendingId = "";
      const run = host.approvalService.execute({
        tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1",
        sessionId: "s1", snapshotVersion: "v1", permissionRevision: "1:workspace-write", toolCallId: "call-1",
        toolName: "connector:jira", args: { issue: "A" }, riskLevel: "external", permissionMode: "workspace-write",
      }, async () => "ran");
      run.catch(() => undefined);
      while (!pendingId) { pendingId = host.approvalService.list("conversation-1", "tenant-1", "member-1").find(item => item.status === "pending")?.id ?? ""; await new Promise(resolve => setImmediate(resolve)); }
      const decide = (body: Record<string, unknown>) => fetch(`${base}/api/agent/conversations/conversation-1/approvals/${pendingId}/decision`, { method: "POST", headers: { ...headers, "Idempotency-Key": `k-${Math.random()}` }, body: JSON.stringify(body) });

      const badType = await decide({ decision: "approve", session_allow: "yes" });
      assert.equal(badType.status, 422);
      assert.equal((await badType.json() as { code: string }).code, "invalid_approval_session_allow");
      assert.equal(fixture.store.getApprovalRecord(pendingId)?.status, "pending", "校验失败不消耗审批");

      const ok = await decide({ decision: "approve", session_allow: true });
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.equal(fixture.store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "connector:jira"), true);
      assert.equal(await run, "ran");

      // 本地工具（bash）的审批不接受 session_allow。
      let bashId = "";
      const bashRun = host.approvalService.execute({
        tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1",
        sessionId: "s1", snapshotVersion: "v1", permissionRevision: "1:workspace-write", toolCallId: "call-2",
        toolName: "bash", args: { command: "echo hi" }, riskLevel: "bash", permissionMode: "workspace-write",
      }, async () => "ran");
      bashRun.catch(() => undefined);
      while (!bashId) { bashId = host.approvalService.list("conversation-1", "tenant-1", "member-1").find(item => item.status === "pending")?.id ?? ""; await new Promise(resolve => setImmediate(resolve)); }
      const refused = await fetch(`${base}/api/agent/conversations/conversation-1/approvals/${bashId}/decision`, { method: "POST", headers: { ...headers, "Idempotency-Key": `k-${Math.random()}` }, body: JSON.stringify({ decision: "approve", session_allow: true }) });
      assert.equal(refused.status, 422);
      assert.equal((await refused.json() as { code: string }).code, "invalid_approval_session_allow");
      assert.equal(fixture.store.hasApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "bash"), false);
    } finally {
      await http.close();
    }
  } finally {
    await fixture.close();
  }
});

test("会话授权命中后不再产生待审批，且审计里标成 policy:session-grant", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1", permissionMode: "read-only" });
    fixture.store.putApprovalSessionGrant("tenant-1", "member-1", "conversation-1", "connector:jira");
    const host = fixture.createHost();
    // 只读会话也按用户选择的口径不弹。
    fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall("connector:jira", { issue: "A" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await host.prompt("conversation-1", "处理一下", undefined, caller);
    const pending = host.approvalService.list("conversation-1", "tenant-1", "member-1").filter(item => item.status === "pending");
    assert.deepEqual(pending, [], "只读会话里已授权的工具不该再有待审批");
    await host.dispose();
  } finally {
    await fixture.close();
  }
});
