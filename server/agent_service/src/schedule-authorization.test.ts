import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ExecutionAuthorizationRegistry } from "./execution-authorization.js";
import { ScheduleService, validateSchedule } from "./schedule.js";
import { PreExecutionAuthorizationError } from "./pi/session-host.js";
import { AgentSqliteStore, ScheduleRevisionConflictError } from "./storage/sqlite.js";
import { UsageFlushService } from "./usage-flush.js";
import { aggregateUsage } from "./usage.js";

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  return { root, store };
}

test("missing scheduler identity retains a one-shot occurrence until a valid bearer is registered", async () => {
  const { root, store } = fixture("aiteam-scheduler-auth");
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  const registry = new ExecutionAuthorizationRegistry({ now: () => at + 1 });
  const calls: string[] = [];
  try {
    store.createConversation({
      id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1",
      schedule: validateSchedule({ schedule_id: "one", at: new Date(at).toISOString(), one_shot: true, prompt_template: "run" }) as unknown as Record<string, unknown>,
    });
    const scheduler = new ScheduleService(store, { isPrompting: () => false, prompt: async (_id: string, text: string) => { calls.push(text); return "entry-1"; } } as never, { authorization: registry });
    await scheduler.tick(at - 1);
    assert.equal(await scheduler.tick(at + 1), 0);
    assert.equal(store.getConversation("scheduled")?.schedule?.enabled, true);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM idempotency_receipt").get()?.count, 0);

    registry.register({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt", claims: { exp: Math.floor((at + 60_000) / 1_000) } });
    assert.equal(await scheduler.tick(at + 2), 1);
    assert.equal(store.getConversation("scheduled")?.schedule?.enabled, false);
    assert.deepEqual(calls, ["run"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proven pre-execution authorization failure releases a one-shot for retry while unknown does not", async () => {
  const { root, store } = fixture("aiteam-scheduler-preflight");
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  const registry = new ExecutionAuthorizationRegistry({ now: () => at + 1 });
  let attempts = 0;
  try {
    store.createConversation({
      id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1",
      schedule: validateSchedule({ schedule_id: "one", at: new Date(at).toISOString(), one_shot: true, prompt_template: "run" }) as unknown as Record<string, unknown>,
    });
    registry.register({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt", claims: { exp: Math.floor((at + 60_000) / 1_000) } });
    const scheduler = new ScheduleService(store, { isPrompting: () => false, prompt: async () => { attempts += 1; if (attempts === 1) throw new PreExecutionAuthorizationError("authorization changed before Pi"); return "entry-1"; } } as never, { authorization: registry });
    await scheduler.tick(at - 1);
    assert.equal(await scheduler.tick(at + 1), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getConversation("scheduled")?.schedule?.enabled, true);
    assert.equal(await scheduler.tick(at + 2), 1);
    assert.equal(attempts, 2);

    store.createConversation({
      id: "scheduled-unknown", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1",
      schedule: validateSchedule({ schedule_id: "unknown", at: new Date(at + 10).toISOString(), one_shot: true, prompt_template: "unknown" }) as unknown as Record<string, unknown>,
    });
    let unknownCalls = 0;
    const unknownScheduler = new ScheduleService(store, { isPrompting: () => false, prompt: async () => { unknownCalls += 1; throw Object.assign(new Error("downstream denied after reservation"), { status: 403 }); } } as never, { authorization: registry });
    await unknownScheduler.tick(at + 9);
    assert.equal(await unknownScheduler.tick(at + 11), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getConversation("scheduled-unknown")?.schedule?.enabled, false);
    assert.equal(await unknownScheduler.tick(at + 12), 0);
    assert.equal(unknownCalls, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("released pre-execution one-shot occurrences survive Agent restart with a durable block reason", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-scheduler-restart-"));
  const path = join(root, "agent.sqlite");
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  let store = new AgentSqliteStore(path);
  try {
    store.createConversation({
      id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1",
      schedule: validateSchedule({ schedule_id: "one", at: new Date(at).toISOString(), one_shot: true, prompt_template: "run" }) as unknown as Record<string, unknown>,
    });
    const registry = new ExecutionAuthorizationRegistry({ now: () => at + 1 });
    registry.register({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt", claims: { exp: Math.floor((at + 60_000) / 1_000) } });
    const first = new ScheduleService(store, { isPrompting: () => false, prompt: async () => { throw new PreExecutionAuthorizationError("pre-execution denial"); } } as never, { authorization: registry });
    await first.tick(at - 1);
    assert.equal(await first.tick(at + 1), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.db.prepare("SELECT block_reason FROM schedule_retry WHERE conversation_id = 'scheduled'").get()?.block_reason, "authorization_required");
    store.close();

    store = new AgentSqliteStore(path);
    const second = new ScheduleService(store, { isPrompting: () => false, prompt: async () => "entry-after-restart" } as never, { authorization: registry });
    await second.tick(at + 1);
    assert.equal(await second.tick(at + 2), 1);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM schedule_retry WHERE conversation_id = 'scheduled'").get()?.count, 0);
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("schedule reservation and late pre-execution release are CAS-bound to schedule id and revision", () => {
  const { root, store } = fixture("aiteam-scheduler-cas");
  try {
    const first = validateSchedule({ schedule_id: "first", revision: 4, at: "2026-01-01T00:00:00Z", one_shot: true, prompt_template: "first" });
    store.createConversation({ id: "scheduled", sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1", schedule: first as unknown as Record<string, unknown> });
    assert.throws(() => store.reservePrompt({ conversationId: "scheduled", callerId: "member-1", key: "wrong-reservation", fingerprint: "f", oneShot: true, scheduleId: "first", scheduleRevision: 3 }), ScheduleRevisionConflictError);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM idempotency_receipt WHERE idempotency_key = 'wrong-reservation'").get()?.count, 0);
    const receipt = store.reservePrompt({ conversationId: "scheduled", callerId: "member-1", key: "old-reservation", fingerprint: "f", oneShot: true, scheduleId: "first", scheduleRevision: 4, scheduleGeneration: 0 });
    assert.equal(store.getConversation("scheduled")?.schedule?.enabled, false);
    const sameIdentityUpdate = validateSchedule({ schedule_id: "first", revision: 4, enabled: false, at: "2026-01-01T00:00:00Z", one_shot: true, prompt_template: "updated" });
    store.updateConversation("scheduled", { schedule: sameIdentityUpdate as unknown as Record<string, unknown> });
    assert.equal(store.getConversation("scheduled")?.scheduleGeneration, 2);
    assert.equal(store.releasePreExecutionPrompt("scheduled", "member-1", "old-reservation", receipt.ownerInstance, true, { scheduleId: "first", occurrenceAt: "2026-01-01T00:00:00.000Z", revision: 4, scheduleGeneration: receipt.scheduleGeneration ?? 1 }), false);
    assert.equal(store.getConversation("scheduled")?.schedule?.schedule_id, "first");
    assert.equal(store.getConversation("scheduled")?.schedule?.prompt_template, "updated");
    assert.equal(store.getConversation("scheduled")?.schedule?.enabled, false);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM schedule_retry WHERE conversation_id = 'scheduled'").get()?.count, 0);

    store.updateConversation("scheduled", { schedule: null });
    store.updateConversation("scheduled", { schedule: { ...sameIdentityUpdate, enabled: true } as unknown as Record<string, unknown> });
    const current = store.getConversation("scheduled");
    assert.equal(current?.scheduleGeneration, 4);
    const second = store.reservePrompt({ conversationId: "scheduled", callerId: "member-1", key: "cleared-reservation", fingerprint: "f2", oneShot: true, scheduleId: "first", scheduleRevision: 4, scheduleGeneration: current?.scheduleGeneration });
    store.updateConversation("scheduled", { schedule: null });
    assert.equal(store.releasePreExecutionPrompt("scheduled", "member-1", "cleared-reservation", second.ownerInstance, true, { scheduleId: "first", occurrenceAt: "2026-01-02T00:00:00.000Z", revision: 4, scheduleGeneration: second.scheduleGeneration ?? 5 }), false);
    assert.equal(store.getConversation("scheduled")?.schedule, null);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM schedule_retry WHERE conversation_id = 'scheduled'").get()?.count, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage authorization denial invalidates the registered identity and leaves the row retryable", async () => {
  const { root, store } = fixture("aiteam-usage-auth");
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };
  const registry = new ExecutionAuthorizationRegistry();
  registry.register(caller);
  const summary = aggregateUsage({ tenantId: "tenant-1", memberId: "member-1", employeeId: "employee-1", startedAt: Date.now(), endedAt: Date.now(), settled: true, entries: [] });
  store.upsertUsageSummary(summary);
  try {
    const flush = new UsageFlushService(store, { uploadUsage: async () => { throw Object.assign(new Error("denied"), { status: 403 }); } } as never, { authorization: registry });
    assert.deepEqual(await flush.flush(caller), { sent: [], failed: [summary.summary_id] });
    assert.equal(registry.resolve("tenant-1", "member-1", { requireAccessToken: true }), undefined);
    assert.equal(store.listUsageOutbox("tenant-1", "member-1")[0]?.status, "failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
