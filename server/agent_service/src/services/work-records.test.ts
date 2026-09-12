import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createFixture } from "../test-fixture.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { aggregateUsage, measureWorkUsage } from "../usage.js";
import type { RuntimePricingSnapshot } from "../pi/model-runtime.js";
import { UsageStatisticsService } from "./usage-statistics.js";
import { WorkRecordReadService } from "./work-records.js";
import { observedWorkOutcome, workEntryTime } from "../pi/work-history.js";
import { SessionHost } from "../pi/session-host.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const owner = { tenantId: "tenant-1", memberId: "member-1" };
const caller = { tenantId: "tenant-1", userId: "member-1", callerId: "member-1" };
const hour = Date.parse("2026-09-05T08:00:00Z");
const pricing: RuntimePricingSnapshot = { pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "0.000001", output_usd_per_million: "0.000001", cache_read_usd_per_million: "0.000001", cache_write_usd_per_million: "0.000001", request_usd: null, currency: "USD", effective_from: "2026-09-01T00:00:00Z" };
const entries = [{ type: "message", id: "a", timestamp: "2026-09-05T08:01:01.000Z", message: { role: "assistant", content: [], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }] as unknown as SessionEntry[];
const capture = { ...owner, employeeId: "e1", startedAt: hour + 1000, endedAt: hour + 2000, settled: true, entries, pricing };
const finish = { outcome: "succeeded" as const, endedAt: hour + 2000, endOrdinal: 1, firstEntryId: "a", lastEntryId: "a", firstEntryAt: hour + 1000, lastEntryAt: hour + 2000, usage: measureWorkUsage(entries, pricing) };

test("work repository atomically finalizes hourly usage once, rolls back errors, scopes access and preserves sequence ordering", async () => {
  const fixture = await createFixture();
  try {
    const repo = fixture.store.workRecords;
    const ids = ["e1", "e2", "e3"].map((employeeId) => repo.start({ ...owner, employeeId, conversationId: "c1", startedAt: hour + 1000, startOrdinal: 0 }));
    assert.equal(new Set(ids).size, 3);
    const startSeq = repo.watermark();
    assert.equal(repo.history(owner, 10).length, 3);
    assert.equal(repo.history({ ...owner, memberId: "other" }, 10).length, 0);
    assert.equal(repo.get(ids[0]!, { ...owner, tenantId: "other" }), undefined);
    const first = repo.history(owner, 1)[0]!;
    assert.equal(repo.history(owner, 10, [first.occurred_at!, first.created_seq]).length, 2);
    fixture.store.db.exec("CREATE TRIGGER fail_work_usage BEFORE INSERT ON usage_summary_outbox BEGIN SELECT RAISE(ABORT, 'test atomic failure'); END");
    assert.throws(() => repo.finish(ids[0]!, owner, finish, aggregateUsage(capture)), /test atomic failure/);
    assert.equal(repo.get(ids[0]!, owner)?.outcome, "active");
    assert.equal(repo.watermark(), startSeq);
    assert.equal(fixture.store.listUsageOutbox().length, 0);
    fixture.store.db.exec("DROP TRIGGER fail_work_usage");
    assert.equal(repo.finish(ids[0]!, owner, finish, aggregateUsage(capture)), true);
    assert.equal(repo.finish(ids[0]!, owner, finish, aggregateUsage(capture)), false);
    assert.equal(repo.finish(ids[1]!, { ...owner, memberId: "other" }, finish), false);
    assert.equal(fixture.store.listUsageOutbox()[0]!.payload!.prompt_count, 1);
    assert.deepEqual(repo.changes(owner, startSeq, 10).map((row) => row.record_id), [ids[0]]);
    assert.equal(repo.changes({ ...owner, employeeId: "e2" }, startSeq, 10).length, 0);
    assert.equal(fixture.store.deleteConversation("c1", owner.tenantId, "other"), false);
    assert.equal(repo.history(owner, 10).length, 3, "unauthorized storage delete must not purge indexes");
    const beforeDelete = repo.watermark();
    assert.equal(fixture.store.deleteConversation("c1", owner.tenantId, owner.memberId), true);
    assert.equal(repo.history(owner, 10).length, 0);
    const tombstones = repo.changes(owner, beforeDelete, 10);
    assert.equal(tombstones.length, 3);
    assert(tombstones.every((row) => row.deleted === 1));
    assert.deepEqual(Object.keys(tombstones[0]!).sort(), ["deleted", "employee_id", "member_id", "record_id", "seq", "tenant_id"]);
    assert.equal(fixture.store.listUsageOutbox()[0]!.payload!.prompt_count, 1);
  } finally { await fixture.close(); }
});

test("warm empty work changes polls read anchor metadata once per participant and perform no write transaction", async (t) => {
  const fixture = await createFixture();
  const history: SessionEntry[] = [];
  const append = (index: number) => history.push(...["user", "assistant"].map((role) => ({ type: "message", id: `${role}-${index}`, parentId: null, timestamp: new Date(hour).toISOString(), message: { role, content: [{ type: "text", text: `${role} ${index}` }], stopReason: "stop" } } as SessionEntry)));
  for (let index = 0; index < 300; index++) append(index);
  const service = new WorkRecordReadService(fixture.store, { readHistorySources: (id, identity) => {
    assert.deepEqual(identity, caller);
    return id === "c1" ? [{ employeeId: "e1", entries: history }] : [];
  } });
  try {
    const initial = service.history(caller, new URLSearchParams("employee_id=e1&limit=1"));
    assert.equal(fixture.store.workRecords.history(owner, 1000).length, 300);
    let queries = 0;
    let materialized = 0;
    let transactions = 0;
    const prepare = fixture.store.db.prepare.bind(fixture.store.db);
    t.mock.method(fixture.store.db, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (/\bFROM work_record\b/u.test(sql)) {
        const all = statement.all.bind(statement);
        t.mock.method(statement, "all", (...args: Parameters<typeof statement.all>) => {
          queries++;
          const rows = all(...args);
          materialized += rows.length;
          return rows;
        });
      }
      return statement;
    });
    const exec = fixture.store.db.exec.bind(fixture.store.db);
    t.mock.method(fixture.store.db, "exec", (sql: string) => {
      if (/\bBEGIN\b/u.test(sql)) transactions++;
      return exec(sql);
    });
    const warm = service.changes(caller, new URLSearchParams({ employee_id: "e1", after: initial.meta.after, limit: "1" }));
    assert.deepEqual(warm.data, []);
    assert.equal(queries, 1, "no per-segment whole-conversation SELECT");
    assert.equal(materialized, 300, "N anchors, not N squared work rows");
    assert.equal(transactions, 0, "known history must not start BEGIN IMMEDIATE");
    append(300);
    append(301);
    const added = service.changes(caller, new URLSearchParams({ employee_id: "e1", after: warm.page.next_cursor, limit: "100" }));
    assert.equal(added.data.length, 2);
    assert.equal(added.data[0]!.operation, "upsert");
    assert.equal(transactions, 1, "only newly discovered segments need a batch transaction");
    queries = materialized = transactions = 0;
    assert.deepEqual(service.changes(caller, new URLSearchParams({ employee_id: "e1", after: added.page.next_cursor, limit: "1" })).data, []);
    assert.equal(queries, 1);
    assert.equal(materialized, 302);
    assert.equal(transactions, 0);
    assert.equal(fixture.store.listUsageOutbox().length, 0, "backfill must not meter historical prompts");
  } finally { t.mock.restoreAll(); await fixture.close(); }
});

test("startup turns unconfirmed work unknown exactly once without guessing end time, usage, success or replay", async () => {
  const fixture = await createFixture();
  const id = fixture.store.workRecords.start({ ...owner, employeeId: "e1", conversationId: "c1", startedAt: hour, startOrdinal: 0 });
  const before = fixture.store.workRecords.watermark();
  await fixture.host.dispose();
  fixture.store.close();
  let store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
  try {
    const row = store.workRecords.get(id, owner)!;
    assert.equal(row.outcome, "unknown");
    assert.equal(row.reason, "process_restart");
    assert.equal(row.ended_at, null);
    assert.equal(row.usage_json, null);
    assert.equal(store.listUsageOutbox().length, 0);
    assert.deepEqual(store.workRecords.changes(owner, before, 10).map((item) => item.record_id), [id]);
    const seq = store.workRecords.watermark();
    store.close();
    store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
    assert.equal(store.workRecords.watermark(), seq);
    assert.equal(store.workRecords.finish(id, owner, finish, aggregateUsage(capture)), false);
    assert.equal(store.listUsageOutbox().length, 0);
  } finally { store.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("pricing uses precise snapshot USD rates, explicit unknowns, nullable missing counters and true terminal evidence", () => {
  assert.equal(measureWorkUsage(entries, pricing)?.cost_total, "0.000000000004");
  assert.equal(aggregateUsage(capture).cost_total, "0.000000000004");
  assert.equal(aggregateUsage(capture).cost_minor, 0);
  assert.equal(measureWorkUsage(entries, { ...pricing, currency: "EUR" } as never)?.pricing_status, "unknown");
  assert.equal(measureWorkUsage(entries, { ...pricing, output_usd_per_million: null })?.cost_total, null);
  assert.equal(measureWorkUsage(entries, { ...pricing, output_usd_per_million: "NaN" })?.cost_total, null);
  const unknown = aggregateUsage({ ...capture, pricing: { ...pricing, pricing_status: "unknown" } });
  assert.equal(unknown.cost_total, null);
  assert.equal(unknown.cost_minor, null);
  assert.equal(measureWorkUsage([], pricing), null);
  assert.equal(measureWorkUsage([{ ...entries[0], message: { role: "assistant", usage: { input: 10 } } } as never], pricing), null);
  assert.equal(aggregateUsage({ ...capture, entries: [] }).pricing_status, "unknown");
  const request = { ...pricing, billing_mode: "request" as const, request_usd: "0.000001" };
  assert.equal(measureWorkUsage(entries, request)?.cost_total, "0.000001000000");
  assert.equal(aggregateUsage({ ...capture, entries: [], pricing: request }).cost_total, null, "initialization failure does not invent a billed request");
  assert.equal(workEntryTime({ timestamp: 0 } as never), 0, "an actual numeric Pi epoch is not a missing timestamp");
  assert.equal(workEntryTime({ timestamp: "bad-date" } as never), null);
  assert.equal(workEntryTime(undefined), null);
  assert.equal(observedWorkOutcome("stop", true), "succeeded");
  assert.equal(observedWorkOutcome("stop", false), "unknown");
  assert.equal(observedWorkOutcome("aborted", true), "aborted");
  assert.equal(observedWorkOutcome("stop", true, true), "aborted");
  assert.equal(observedWorkOutcome("error", true), "error");
  assert.equal(observedWorkOutcome(undefined, false, false, true), "error");
});

test("faux work remains explicitly unmetered and production usage notifications observe an already committed lifecycle/summary", async () => {
  const fixture = await createFixture();
  const expert = { employee_id: "e1", tenant_id: owner.tenantId, member_id: owner.memberId, display_name: "Employee", handle: "employee", revoked: false, version: "1", synced_at: new Date(hour).toISOString() };
  fixture.store.replaceProjections([expert], [], [{ ...expert, snapshot_version: "1", tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("c1", { entryEmployeeId: "e1" });
  let notifications = 0;
  const create = (useFauxModel: boolean) => new SessionHost({
    store: fixture.store, cwdRoot: join(fixture.dataRoot, "workspaces"), agentDir: join(fixture.dataRoot, "pi"), sessionDir: join(fixture.dataRoot, "sessions"),
    modelRuntime: fixture.modelRuntime, model: fixture.faux.getModel(), useFauxModel, resourceLoaderFactory: () => createControlledResourceLoader("test"),
    usageRecorder: () => {
      notifications++;
      assert(fixture.store.workRecords.history(owner, 10).every((row) => row.outcome === "succeeded"));
      assert.equal(fixture.store.listUsageOutbox()[0]!.payload!.prompt_count, 1);
    },
  });
  const fauxHost = create(true);
  const meteredHost = create(false);
  try {
    fixture.faux.setResponses([fauxAssistantMessage("test-only"), fauxAssistantMessage("measured")]);
    await fauxHost.prompt("c1", "faux", undefined, caller);
    assert.equal(fixture.store.workRecords.history(owner, 10)[0]!.usage_json, null);
    assert.equal(fixture.store.listUsageOutbox().length, 0);
    assert.equal(notifications, 0);
    await fauxHost.dispose();
    await meteredHost.prompt("c1", "metered", undefined, caller);
    assert.equal(notifications, 1);
    assert.equal(fixture.store.listUsageOutbox()[0]!.payload!.prompt_count, 1);
  } finally { await fauxHost.dispose(); await meteredHost.dispose(); await fixture.close(); }
});

test("hourly decimal accumulation preserves tiny costs beside large totals and legacy/sent rows survive restart without a second ledger", async () => {
  const fixture = await createFixture();
  const base = { ...aggregateUsage(capture), summary_id: "precision", cost_total: "1000.500000000000", cost_minor: 100050 };
  fixture.store.upsertUsageSummary(base);
  fixture.store.db.prepare("UPDATE usage_summary_outbox SET cost_total_decimal = NULL, status = 'sent' WHERE summary_id = ?").run(base.summary_id);
  for (let index = 0; index < 100; index++) fixture.store.upsertUsageSummary({ ...base, cost_total: "0.000000000001", cost_minor: 0 });
  const row = fixture.store.db.prepare("SELECT cost_total_decimal FROM usage_summary_outbox WHERE summary_id = ?").get(base.summary_id) as { cost_total_decimal: string };
  assert.equal(row.cost_total_decimal, "1000.500000000100");
  const service = new UsageStatisticsService(fixture.store);
  const before = service.statistics(caller, new URLSearchParams()).data;
  assert.equal(before.cost_total, row.cost_total_decimal);
  assert.equal(before.execution_count, 101);
  const claimed = fixture.store.claimUsageOutbox(owner.tenantId, owner.memberId);
  assert.equal(claimed.length, 1);
  assert(!Object.hasOwn(claimed[0]!.payload, "cost_total_decimal"), "local precision must not change the shared payload schema");
  assert.deepEqual(service.statistics(caller, new URLSearchParams()).data, before);
  await fixture.host.dispose();
  fixture.store.close();
  const store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
  try {
    assert.equal(store.listUsageOutbox()[0]!.status, "failed", "in-flight upload recovered without losing aggregate");
    assert.deepEqual(new UsageStatisticsService(store).statistics(caller, new URLSearchParams()).data, before);
    const [claim] = store.claimUsageOutbox(owner.tenantId, owner.memberId);
    store.markUsageSent(claim!.summary_id, claim!.claim_token);
    assert.deepEqual(new UsageStatisticsService(store).statistics(caller, new URLSearchParams()).data, before);
    assert.equal(store.listUsageOutbox().length, 1);
  } finally { store.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("statistics retain all outbox states and deletion totals, sum cost_total not rounded cents, and reject non-hour ranges", async () => {
  const fixture = await createFixture();
  const stats = new UsageStatisticsService(fixture.store);
  const get = (query = "") => stats.statistics(caller, new URLSearchParams(query)).data;
  try {
    const priced = { ...pricing, billing_mode: "request" as const, request_usd: "0.004000" };
    for (const [index, status] of ["pending", "sending", "sent", "failed"].entries()) {
      const summary = aggregateUsage({ ...capture, employeeId: index === 3 ? "e2" : "e1", startedAt: hour + index * 3_600_000 + 1, pricing: priced });
      fixture.store.upsertUsageSummary(summary);
      fixture.store.db.prepare("UPDATE usage_summary_outbox SET status = ? WHERE summary_id = ?").run(status, summary.summary_id);
    }
    assert.equal(get().execution_count, 4);
    assert.equal(get().cost_total, "0.016000000000");
    assert.equal(get().cost_minor, 2, "round total once, never add four rounded-zero cents");
    assert.equal(get("employee_id=e1").execution_count, 3);
    assert.equal(get("window_start=2026-09-05T08:00:00Z&window_end=2026-09-05T09:00:00Z").execution_count, 1);
    const summary = aggregateUsage({ ...capture, pricing: priced });
    fixture.store.upsertUsageSummary(summary);
    const row = fixture.store.listUsageOutbox().find((item) => item.summary_id === summary.summary_id)!;
    assert.equal(row.payload!.cost_minor, 1, "hourly aggregate cents also derive from cumulative cost_total");
    for (const query of ["window_start=2026-09-05T08:01:00Z&window_end=2026-09-05T09:00:00Z", "window_start=2026-09-05T08:00:00Z", "window_start=2026-02-30T08:00:00Z&window_end=2026-03-03T09:00:00Z", "window_start=2026-09-05T08:00:00Z&window_end=2026-09-05T08:00:00Z"]) assert.throws(() => get(query), /paired UTC/);
    assert.throws(() => get("employee_id=e1&employee_id=e2"), /repeated/);
    const before = get();
    fixture.store.deleteConversation("c1", owner.tenantId, owner.memberId);
    assert.deepEqual(get(), before);
    fixture.store.upsertUsageSummary(aggregateUsage({ ...capture, pricing: null }));
    assert.equal(get().cost_total, null);
    assert.equal(get().known_cost_total, before.known_cost_total);
    assert.equal(get().pricing_status, "partial");
    assert.equal(get().unpriced_execution_count, 1);
    fixture.store.upsertUsageSummary({ ...summary, summary_id: "bad-currency", currency: "EUR" } as never);
    assert.equal(get().excluded_summary_count, 1);
    fixture.store.upsertUsageSummary({ ...summary, summary_id: "other-owner", member_id: "other" });
    assert.equal(get().execution_count, 6);
    assert.equal(stats.statistics({ ...caller, userId: "other" }, new URLSearchParams()).data.execution_count, 1);
  } finally { await fixture.close(); }
});
