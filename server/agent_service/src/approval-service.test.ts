import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ApprovalDeniedError, ApprovalService, approvalRiskForTool } from "./approval-service.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1",
  sessionId: "session-1", snapshotVersion: "snapshot-1", permissionRevision: "1:full-access", toolCallId: "call-1",
  toolName: "bash", args: { command: "printf safe" }, riskLevel: "bash" as const, permissionMode: "full-access" as const,
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
    await assert.rejects(service.execute(request({ permissionRevision: "2:full-access" }), async () => "changed"), /binding changed/);
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
