import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateUsage } from "../usage.js";
import { UsageFlushService } from "../usage-flush.js";
import { ScheduleService, validateSchedule } from "../schedule.js";
import { AgentHttpServer } from "../http/server.js";
import { AgentSqliteStore } from "../storage/sqlite.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-schedule-usage-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  return { root, store };
}

test("schedule validation is explicit and rejects unknown fields", () => {
  const schedule = validateSchedule({ schedule_id: "daily", at: "2026-01-01T00:00:00Z", interval_seconds: 3600, prompt_template: "check", overlap: "skip", misfire: "skip" });
  assert.equal(schedule.one_shot, false);
  assert.throws(() => validateSchedule({ ...schedule, cron: "* * * * *" }), /not supported/);
  assert.throws(() => validateSchedule({ schedule_id: "once", one_shot: true, prompt_template: "run" }), /require at/);
});

test("schedule occurrence receipts dedupe and never replay unknown", () => {
  const fixture = storeFixture();
  try {
    fixture.store.createConversation({ id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", schedule: validateSchedule({ schedule_id: "once", at: "2026-01-01T00:00:00Z", one_shot: true, prompt_template: "run" }) as unknown as Record<string, unknown> });
    const input = { conversationId: "scheduled", callerId: "schedule:tenant-1:member-1", key: "occurrence-key", fingerprint: "fingerprint", oneShot: true };
    const first = fixture.store.reservePrompt(input);
    assert.equal(first.isNew, true);
    assert.equal(fixture.store.getConversation("scheduled")?.schedule?.enabled, false);
    assert.equal(fixture.store.reservePrompt(input).isNew, false);
    fixture.store.markUnknown("scheduled", input.callerId, input.key, first.ownerInstance);
    assert.throws(() => fixture.store.reservePrompt(input), /unknown execution state/);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("local scheduler invokes SessionHost prompt once and shuts down cleanly", async () => {
  const fixture = storeFixture();
  const at = Date.parse("2026-01-01T00:00:00Z");
  const calls: string[] = [];
  try {
    fixture.store.createConversation({ id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1", schedule: validateSchedule({ schedule_id: "once", at: new Date(at).toISOString(), one_shot: true, prompt_template: "scheduled prompt" }) as unknown as Record<string, unknown> });
    const host = { isPrompting: () => false, prompt: async (_id: string, text: string) => { calls.push(text); return "entry-1"; } };
    const scheduler = new ScheduleService(fixture.store, host as never);
    await scheduler.tick(at - 1);
    assert.equal(await scheduler.tick(at + 1), 1);
    await scheduler.stop();
    assert.deepEqual(calls, ["scheduled prompt"]);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("usage aggregation is deterministic, bucketed, and contains no prompt data", () => {
  const summary = aggregateUsage({
    tenantId: "tenant-1", memberId: "member-1", employeeId: "employee-1", startedAt: Date.parse("2026-01-01T01:23:00Z"), endedAt: Date.parse("2026-01-01T01:24:02Z"), settled: true,
    entries: [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: { total: 0.17 } }, content: [{ type: "text", text: "secret prompt" }] } } as never],
  });
  assert.equal(summary.input_tokens, 10);
  assert.equal(summary.output_tokens, 5);
  assert.equal(summary.cache_tokens, 5);
  assert.equal(summary.cost_minor, 17);
  assert.equal(summary.duration_ms_total, 62000);
  assert.equal(summary.window_start, "2026-01-01T01:00:00.000Z");
  assert(!JSON.stringify(summary).includes("secret prompt"));
});

test("authenticated HTTP usage flush delegates and reports explicit status", async () => {
  const fixture = storeFixture();
  const summary = aggregateUsage({ tenantId: "tenant-1", memberId: "member-1", employeeId: "employee-1", startedAt: Date.now(), endedAt: Date.now(), settled: true, entries: [] });
  fixture.store.upsertUsageSummary(summary);
  const http = new AgentHttpServer({
    host: { abortAll: async () => {} } as never,
    store: fixture.store,
    authenticate: () => caller,
    usageFlush: new UsageFlushService(fixture.store, { uploadUsage: async () => ({ ok: true }) } as never),
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/usage/flush`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.sent, [summary.summary_id]);
  } finally {
    await http.close();
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("new usage in a sent hourly summary is requeued for flush", async () => {
  const fixture = storeFixture();
  try {
    const summary = aggregateUsage({ tenantId: "tenant-1", memberId: "member-1", employeeId: "employee-1", startedAt: Date.now(), endedAt: Date.now(), settled: true, entries: [] });
    let calls = 0;
    const manager = { uploadUsage: async () => { calls += 1; } };
    const flush = new UsageFlushService(fixture.store, manager as never);
    fixture.store.upsertUsageSummary(summary);
    assert.deepEqual(await flush.flush(caller), { sent: [summary.summary_id], failed: [] });
    assert.equal(fixture.store.listUsageOutbox("tenant-1")[0].status, "sent");

    fixture.store.upsertUsageSummary({ ...summary, prompt_count: 2 });
    assert.equal(fixture.store.listUsageOutbox("tenant-1")[0].status, "pending");
    assert.deepEqual(await flush.flush(caller), { sent: [summary.summary_id], failed: [] });
    assert.equal(calls, 2);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("usage outbox flush marks sent and failed with stable summary ids", async () => {
  const fixture = storeFixture();
  try {
    const summary = aggregateUsage({ tenantId: "tenant-1", memberId: "member-1", employeeId: "employee-1", startedAt: Date.now(), endedAt: Date.now(), settled: true, entries: [] });
    fixture.store.upsertUsageSummary(summary);
    let calls = 0;
    const manager = { uploadUsage: async (_caller: typeof caller, uploaded: typeof summary) => { calls += 1; assert.equal(uploaded.summary_id, summary.summary_id); } };
    const flush = new UsageFlushService(fixture.store, manager as never);
    assert.deepEqual(await flush.flush(caller), { sent: [summary.summary_id], failed: [] });
    assert.equal(fixture.store.listUsageOutbox("tenant-1")[0].status, "sent");
    fixture.store.upsertUsageSummary({ ...summary, summary_id: "failed-summary" });
    const failing = new UsageFlushService(fixture.store, { uploadUsage: async () => { throw new Error("offline"); } } as never);
    assert.deepEqual(await failing.flush(caller), { sent: [], failed: ["failed-summary"] });
    assert.equal(fixture.store.listUsageOutbox("tenant-1").find((item) => item.summary_id === "failed-summary")?.status, "failed");
    assert.equal(calls, 1);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
