import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApprovalResolutionError, ApprovalService } from "./approval-service.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", participantEmployeeId: "employee-1",
  sessionId: "session-1", snapshotVersion: "snapshot-1", permissionRevision: "1:read-only", toolCallId: "call-1",
  toolName: "capability_install", args: { kind: "mcp", ref: "notion", url: "https://example.com/mcp", reason: "" },
  riskLevel: "unknown" as const, permissionMode: "read-only" as const, ...overrides,
});
const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tenantId: "tenant-1", memberId: "member-1", conversationId: "conversation-1", decision: "approve" as const,
  approvedBy: "member-1", idempotencyKey: `d-${id}`, ...extra,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-resolution-test-"));
  return { root, store: new AgentSqliteStore(join(root, "agent.sqlite")) };
}

test("the user's rename choice is stored on the approval and handed to the operation", async () => {
  const { root, store } = fixture();
  try {
    let required!: ReturnType<ApprovalService["list"]>[number];
    const service = new ApprovalService(store, { onRequired: (record) => { required = record; } });
    const pending = service.execute(request(), async (claimed) => claimed.resolution);
    while (!required) await new Promise((resolve) => setImmediate(resolve));
    const approved = service.decide(decision(required.id, { resolution: { action: "rename", ref: "notion2" } }));
    assert.deepEqual(approved.resolution, { action: "rename", ref: "notion2" });
    assert.deepEqual(await pending, { action: "rename", ref: "notion2" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a resolution is refused for other tools, for a deny, or with an invalid new ref", async () => {
  const { root, store } = fixture();
  try {
    const seen: ReturnType<ApprovalService["list"]> = [];
    const service = new ApprovalService(store, { onRequired: (record) => { seen.push(record); } });
    void service.execute(request({ toolName: "bash", riskLevel: "bash", permissionMode: "workspace-write", args: { command: "ls" } }), async () => "x").catch(() => {});
    void service.execute(request({ toolCallId: "call-2" }), async () => "x").catch(() => {});
    while (seen.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const [bash, install] = seen;
    assert.throws(() => service.decide(decision(bash!.id, { resolution: { action: "replace" } })), ApprovalResolutionError);
    assert.throws(() => service.decide(decision(install!.id, { decision: "deny", resolution: { action: "replace" } })), ApprovalResolutionError);
    assert.throws(() => service.decide(decision(install!.id, { resolution: { action: "rename", ref: "Bad Ref" } })), ApprovalResolutionError);
    assert.equal(store.getApprovalRecord(install!.id)?.status, "pending");
    // 不带选择的批准照旧可用，记录里 resolution 为 null。
    assert.equal(service.decide(decision(install!.id)).resolution, null);
    service.clear();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an Agent database from before personal skills keeps its MCP rows and accepts skills after migration", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-capability-migration-"));
  const path = join(root, "agent.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE local_capability (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mcp')), ref TEXT NOT NULL,
      display_name TEXT NOT NULL, url TEXT NOT NULL, tools_json TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('user_url')),
      reason TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, member_id, kind, ref));
      INSERT INTO local_capability VALUES ('t', 'm', 'mcp', 'notion', 'Notion', 'https://example.com/mcp', '["search"]', 'user_url', '', 'm', '2026-11-17T00:00:00Z');`);
    old.close();
    const store = new AgentSqliteStore(path);
    try {
      store.putLocalCapability("t", "m", { kind: "skill", ref: "sheet", display_name: "读表", url: "", tools: [], version: "2", source_ref: "plat-sheet", source: "enterprise_catalog", reason: "", approved_by: "m" });
      assert.deepEqual(store.listLocalCapabilities("t", "m").map((item) => [item.kind, item.ref, item.version, item.tools, item.source_ref]),
        [["mcp", "notion", "", ["search"], ""], ["skill", "sheet", "2", [], "plat-sheet"]]);
      assert.equal(store.deleteLocalCapability("t", "m", "skill", "sheet"), true);
    } finally { store.close(); }
    // 再次打开不会重复迁移或丢数据。
    const again = new AgentSqliteStore(path);
    try { assert.equal(again.listLocalCapabilities("t", "m").length, 1); } finally { again.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
