import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore } from "./sqlite.js";
import { outcomeStatistics } from "../http/context-segments.js";
import { ManagerPolicyDeniedError, ManagerValidationError } from "../manager-client.js";
import { UsageFlushService } from "../usage-flush.js";
import type { SegmentOutcomeSummary } from "../usage.js";

const owner = { tenantId: "tenant-1", memberId: "member-1" };
const caller = { tenantId: "tenant-1", userId: "member-1", callerId: "member-1", accessToken: "jwt" };
const HOUR_MS = 60 * 60 * 1000;
const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
const resolved = { outcome: "resolved" as const, reasons: [], note: "只留在本机的备注", followUp: false };
const unresolved = { outcome: "unresolved" as const, reasons: ["missing_info" as const], note: null, followUp: true };
const cleared = { outcome: null, reasons: [], note: null, followUp: false };

function withStore(run: (store: AgentSqliteStore) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "aiteam-segment-outcome-test-"));
    const store = new AgentSqliteStore(join(root, "agent.sqlite"));
    try { await run(store); } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  };
}

function outcomeRows(store: AgentSqliteStore): Array<{ status: string; payload: SegmentOutcomeSummary }> {
  return (store.db.prepare("SELECT status, payload_json FROM usage_summary_outbox WHERE kind = 'segment_outcome' ORDER BY json_extract(payload_json, '$.employee_id')").all() as Array<{ status: string; payload_json: string }>)
    .map((row) => ({ status: row.status, payload: JSON.parse(row.payload_json) as SegmentOutcomeSummary }));
}

test("segment verdicts publish absolute per employee-hour counts and never the note or reasons", withStore((store) => {
  const segments = store.contextSegments;
  segments.record(owner, { conversationId: "c1", segmentId: "s0", employeeIds: ["e1"], messageCount: 2, endedAt: hour + 500 });
  assert.equal(outcomeRows(store).length, 0, "an unevaluated segment creates no outcome row");
  segments.record(owner, { conversationId: "c1", segmentId: "s1", employeeIds: ["e1", "e2"], messageCount: 4, endedAt: hour + 1_000, evaluation: resolved });
  segments.record(owner, { conversationId: "c1", segmentId: "s1", employeeIds: ["e1", "e2"], messageCount: 4, endedAt: hour + 1_000, evaluation: resolved });
  const s2 = segments.record(owner, { conversationId: "c1", segmentId: "s2", employeeIds: ["e1"], messageCount: 3, endedAt: hour + 2_000 });
  segments.evaluate(owner, "c1", "s2", unresolved, s2.revision);

  const rows = outcomeRows(store);
  assert.deepEqual(rows.map((row) => [row.payload.employee_id, row.payload.evaluated_count, row.payload.resolved_count]), [["e1", 2, 1], ["e2", 1, 1]]);
  const [e1] = rows;
  assert.equal(e1!.status, "pending");
  assert.equal(e1!.payload.window_start, new Date(hour).toISOString());
  assert.equal(e1!.payload.window_end, new Date(hour + HOUR_MS).toISOString());
  assert.equal(e1!.payload.summary_id.length, 64);
  assert.deepEqual(Object.keys(e1!.payload).sort(), ["employee_id", "evaluated_count", "member_id", "resolved_count", "schema_version", "summary_id", "tenant_id", "window_end", "window_start"]);
  assert.doesNotMatch(JSON.stringify(rows), /备注|missing_info|follow/);
}));

test("changing, clearing and deleting verdicts overwrite the same row instead of adding", withStore((store) => {
  const segments = store.contextSegments;
  store.createConversation({ id: "c1", tenantId: owner.tenantId, memberId: owner.memberId });
  const first = segments.record(owner, { conversationId: "c1", segmentId: "s1", employeeIds: ["e1"], messageCount: 2, endedAt: hour + 1_000, evaluation: resolved });
  store.db.prepare("UPDATE usage_summary_outbox SET status = 'sent'").run();

  // Note-only edits do not touch the counts and do not re-send.
  const noted = segments.evaluate(owner, "c1", "s1", { ...resolved, note: "改了备注" }, first.revision);
  assert.equal(outcomeRows(store)[0]!.status, "sent");

  const changed = segments.evaluate(owner, "c1", "s1", unresolved, noted.revision);
  assert.deepEqual(outcomeRows(store).map((row) => [row.status, row.payload.evaluated_count, row.payload.resolved_count]), [["pending", 1, 0]]);
  segments.evaluate(owner, "c1", "s1", cleared, changed.revision);
  assert.deepEqual(outcomeRows(store).map((row) => [row.payload.evaluated_count, row.payload.resolved_count]), [[0, 0]]);

  const again = segments.record(owner, { conversationId: "c1", segmentId: "s2", employeeIds: ["e1"], messageCount: 2, endedAt: hour + 2_000, evaluation: resolved });
  assert.equal(again.outcome, "resolved");
  store.db.prepare("UPDATE usage_summary_outbox SET status = 'sent'").run();
  assert.equal(store.deleteConversation("c1", owner.tenantId, owner.memberId), true);
  assert.deepEqual(outcomeRows(store).map((row) => [row.status, row.payload.evaluated_count]), [["pending", 0]]);
  assert.equal(store.listUsageOutbox().length, 1, "one row per employee hour, no ledger growth");
}));

test("flush uploads outcome rows through their own uploader and leaves them pending for clients without one", withStore(async (store) => {
  store.contextSegments.record(owner, { conversationId: "c1", segmentId: "s1", employeeIds: ["e1"], messageCount: 2, endedAt: hour + 1_000, evaluation: resolved });

  const legacy = new UsageFlushService(store, { uploadUsage: async () => { throw new Error("usage uploader must not receive outcome rows"); } } as never);
  assert.deepEqual(await legacy.flush(caller), { sent: [], failed: [] });
  assert.equal(outcomeRows(store)[0]!.status, "pending");

  const uploaded: SegmentOutcomeSummary[] = [];
  const modern = new UsageFlushService(store, { uploadUsage: async () => ({}), uploadSegmentOutcomes: async (_caller: unknown, summary: SegmentOutcomeSummary) => { uploaded.push(summary); } } as never);
  const result = await modern.flush(caller);
  assert.equal(result.sent.length, 1);
  assert.equal(uploaded[0]!.evaluated_count, 1);
  assert.equal(outcomeRows(store)[0]!.status, "sent");
}));

test("a Manager without the outcome endpoint (404) leaves outcome rows pending and pauses retries; 422 stays a real failure", withStore(async (store) => {
  store.contextSegments.record(owner, { conversationId: "c1", segmentId: "s1", employeeIds: ["e1", "e2"], messageCount: 2, endedAt: hour + 1_000, evaluation: resolved });
  let calls = 0;
  const missing = new UsageFlushService(store, {
    uploadUsage: async () => ({}),
    uploadSegmentOutcomes: async () => { calls += 1; throw new ManagerPolicyDeniedError(404, "Manager returned HTTP 404 for /api/manager/usage/segment-outcomes", "not_found"); },
  } as never);
  assert.deepEqual(await missing.flush(caller), { sent: [], failed: [] });
  assert.equal(calls, 1, "one 404 is enough to stop offering the rest of the batch");
  assert.deepEqual(outcomeRows(store).map((row) => row.status), ["pending", "pending"]);
  assert.deepEqual(await missing.flush(caller), { sent: [], failed: [] });
  assert.equal(calls, 1, "retries pause after the endpoint was reported missing");
  const attempts = store.db.prepare("SELECT attempts FROM usage_summary_outbox WHERE kind = 'segment_outcome'").all() as Array<{ attempts: number }>;
  assert.deepEqual(attempts.map((row) => row.attempts), [0, 0]);

  const invalid = new UsageFlushService(store, {
    uploadUsage: async () => ({}),
    uploadSegmentOutcomes: async () => { throw new ManagerValidationError("Manager returned HTTP 422 for /api/manager/usage/segment-outcomes: validation_error", "validation_error"); },
  } as never);
  const result = await invalid.flush(caller);
  assert.equal(result.failed.length, 2);
  const errors = store.db.prepare("SELECT status, last_error FROM usage_summary_outbox WHERE kind = 'segment_outcome'").all() as Array<{ status: string; last_error: string }>;
  assert.ok(errors.every((row) => row.status === "failed" && row.last_error.includes("422")));
}));

test("group-chat segments count once per employee so totals equal the sum of the groups", () => {
  const rows = [
    { employeeIds: ["e1", "e2"], outcome: "resolved" as const, reasons: [] },
    { employeeIds: ["e1"], outcome: "unresolved" as const, reasons: ["missing_info" as const] },
  ];
  const all = outcomeStatistics(rows);
  assert.equal(all.totals.evaluated_count, 3);
  assert.equal(all.totals.resolved_count, 2);
  assert.equal(all.totals.evaluated_count, all.groups.reduce((sum, group) => sum + group.evaluated_count, 0));
  assert.deepEqual(all.groups.map((group) => [group.employee_id, group.evaluated_count, group.resolved_count]), [["e1", 2, 1], ["e2", 1, 1]]);
  const one = outcomeStatistics(rows, "e2");
  assert.deepEqual([one.totals.evaluated_count, one.groups.length], [1, 1]);
});
