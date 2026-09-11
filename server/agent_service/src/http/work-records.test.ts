import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
import { SessionHost } from "../pi/session-host.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { createFixture } from "../test-fixture.js";
import { aggregateUsage } from "../usage.js";

const caller = { tenantId: "tenant-1", userId: "member-1", callerId: "member-1", roles: ["member"] };
const owner = { tenantId: "tenant-1", memberId: "member-1" };
const timestamp = "2026-09-05T08:01:02.123Z";
type Fixture = Awaited<ReturnType<typeof createFixture>>;
function seed(fixture: Fixture, group = false) {
  const experts = ["e1", "e2"].map((id) => ({ employee_id: id, tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: id, handle: id, revoked: false, synced_at: timestamp }));
  fixture.store.replaceProjections(experts, [], experts.map((expert) => ({ ...expert, snapshot_version: "1", tool_policy: { allowed_tools: [] } })));
  fixture.store.updateConversation("c1", group ? { kind: "group", coordinatorEmployeeId: "e1" } : { entryEmployeeId: "e1" });
}
function response(text: string) {
  const value = fauxAssistantMessage(text);
  value.usage = { ...value.usage, input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
  return value;
}
async function serve(fixture: Pick<Fixture, "store" | "host">) {
  const http = new AgentHttpServer({ store: fixture.store, host: fixture.host, authenticate: (request) => ({ ...caller, ...(request.headers.authorization === "Bearer other" ? { userId: "other", callerId: "other" } : {}) }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  return { http, async request(path: string, options: { status?: number; method?: string; body?: unknown; other?: boolean; key?: string } = {}): Promise<any> {
    const result = await fetch(`http://127.0.0.1:${address.port}${path.startsWith("/openapi") ? "" : "/api/agent"}${path}`, {
      method: options.method, headers: { Authorization: options.other ? "Bearer other" : "Bearer owner", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.key ? { "Idempotency-Key": options.key } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    assert.equal(result.status, options.status ?? 200, await result.clone().text());
    if (result.status === 204) return null;
    if (result.status >= 400) assert.match(result.headers.get("content-type") ?? "", /application\/problem\+json/);
    return result.json();
  } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("timed out waiting for real prompt observation");
}
function sources(fixture: Fixture) { return (fixture.store.db.prepare("SELECT COUNT(*) AS n FROM conversation_entry_source WHERE conversation_id = 'c1'").get() as { n: number }).n; }

test("work HTTP observes actual active→success with stable polling, safe summaries and idempotent HTTP receipts", async () => {
  const fixture = await createFixture();
  seed(fixture);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.faux.setResponses([async () => { await gate; return response("done api_key=privatevalue /Users/private/file.txt"); }]);
  const { http, request } = await serve(fixture);
  try {
    const initial = await request("/work-records?employee_id=e1");
    assert.deepEqual(initial.data, []);
    const prompt = { status: 202, method: "POST", body: { text: "task token=privatevalue /Users/private/file.txt" }, key: "same-work" };
    await request("/conversations/c1/prompt", prompt);
    await request("/conversations/c1/prompt", prompt);
    await until(() => sources(fixture) === 1);
    const history = await request("/work-records?employee_id=e1");
    assert.equal(history.data.length, 1);
    const active = history.data[0];
    assert.equal(active.outcome, "active");
    assert.equal(active.ended_at, null);
    assert.equal(active.provenance, "live");
    assert.equal(active.time_basis, "prompt_start");
    assert.equal(active.source_type, "human");
    assert.equal(active.source_id, "member-1");
    assert.equal(active.usage, null);
    assert.match(active.task_summary, /task/);
    assert.doesNotMatch(JSON.stringify(active), /privatevalue|\/Users|file\.txt/);
    const firstChange = await request(`/work-records/changes?employee_id=e1&after=${initial.meta.after}`);
    assert.equal(firstChange.data[0].record.id, active.id);
    release();
    await until(() => !fixture.host.isPrompting("c1"));
    const changes = await request(`/work-records/changes?employee_id=e1&after=${firstChange.page.next_cursor}`);
    assert.equal(changes.data.length, 1);
    const final = changes.data[0].record;
    assert.equal(final.id, active.id);
    assert.equal(final.outcome, "succeeded");
    assert(final.ended_at >= final.started_at);
    const assistant = fixture.host.readHistorySources("c1", caller)[0]!.entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    const actualTokens = assistant.reduce((sum, entry) => { const usage = (entry as any).message.usage; return sum + usage.input + usage.output + usage.cacheRead + usage.cacheWrite; }, 0);
    assert(actualTokens > 0);
    assert.equal(final.usage.token_total, actualTokens, "faux provider calculates its own counters; use persisted Pi evidence");
    assert.equal(final.usage.cost_total, null);
    assert.equal(final.usage.pricing_status, "unknown");
    assert.doesNotMatch(JSON.stringify(final), /privatevalue|\/Users|file\.txt/);
    assert.equal((await request(`/conversations/c1/entries?entry_ref=${final.input_entry_ref}&limit=1`)).data.entries[0].entry_ref, final.input_entry_ref);
    await request("/conversations/c1/prompt", prompt);
    assert.equal((await request("/work-records")).data.length, 1);
    assert.equal((await request("/usage/statistics")).data.execution_count, 1);
    assert.deepEqual((await request(`/work-records/changes?employee_id=e1&after=${changes.page.next_cursor}`)).data, []);
    for (const path of [`/work-records/changes?employee_id=e2&after=${changes.page.next_cursor}`, `/work-records?before=${changes.page.next_cursor}`, "/work-records?before=garbage", "/work-records?limit=0", "/work-records?limit=1&limit=2", "/work-records?employee_id=%20", "/work-records/changes?window_start=2026-09-05T08:00:00Z", "/usage/statistics?window_start=2026-09-05T08:01:00Z&window_end=2026-09-05T09:00:00Z"]) await request(path, { status: 422 });
    await request(`/work-records/changes?employee_id=e1&after=${changes.page.next_cursor}`, { status: 422, other: true });
    assert.deepEqual((await request("/work-records", { other: true })).data, []);
    assert.equal((await request("/usage/statistics", { other: true })).data.execution_count, 0);
    await request("/conversations/c1", { method: "DELETE", other: true, status: 404 });
    await request("/conversations/c1", { method: "DELETE", status: 200 });
    const deleted = await request(`/work-records/changes?employee_id=e1&after=${changes.page.next_cursor}`);
    assert.deepEqual(deleted.data, [{ operation: "delete", record_id: active.id }]);
    assert.deepEqual((await request("/work-records")).data, []);
    assert.equal((await request("/usage/statistics")).data.execution_count, 1);
    assert.deepEqual((await request("/messages/search?q=task")).data, []);
  } finally { release(); await http.close(); await fixture.close(); }
});

test("Pi resolved-error and explicit abort are not success; initialization failure has no invented per-record usage", async () => {
  const fixture = await createFixture();
  seed(fixture);
  const { http, request } = await serve(fixture);
  let release = () => {};
  try {
    fixture.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "not retryable" })]);
    await fixture.host.prompt("c1", "error attempt", undefined, caller);
    assert.equal((await request("/work-records")).data[0].outcome, "error");
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.faux.setResponses([async () => { entered = true; await gate; return response("interrupted"); }]);
    const pending = fixture.host.prompt("c1", "abort attempt", undefined, caller);
    await until(() => entered);
    const abort = fixture.host.abort("c1");
    release();
    await abort;
    await pending; // Pinned Pi abort resolves this promise; result must still be aborted.
    const records = (await request("/work-records")).data;
    assert.equal(records[0].outcome, "aborted");
    assert.equal(records.length, 2);
    const stats = (await request("/usage/statistics")).data;
    assert.equal(stats.execution_count, 2);
    assert.equal(stats.succeeded_count, 0);
    assert.equal(stats.non_success_count, 2);
    const failing = fixture.createHost(fixture.faux.getModel(), undefined, () => { throw new Error("initialization failure token=secretvalue"); });
    try { await assert.rejects(failing.prompt("c1", "not appended", undefined, caller), /initialization failure/); }
    finally { await failing.dispose(); }
    const failed = (await request("/work-records")).data[0];
    assert.equal(failed.outcome, "error");
    assert.equal(failed.usage, null);
    assert.equal(failed.task_summary, null);
    assert.equal(failed.input_entry_ref, null);
    assert.equal((await request("/usage/statistics")).data.execution_count, 3);
  } finally { release(); await http.close(); await fixture.close(); }
});

test("deleting a genuinely active prompt settles abort accounting before purging records and emits only a minimal tombstone", async () => {
  const fixture = await createFixture();
  seed(fixture);
  let release!: () => void;
  let aborted = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.faux.setResponses([async (_context, options) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; release(); }, { once: true });
    await gate;
    return response("deleted response");
  }]);
  const { http, request } = await serve(fixture);
  const pending = fixture.host.prompt("c1", "deleted task", undefined, caller);
  try {
    await until(() => sources(fixture) === 1);
    const initial = await request("/work-records");
    const deleting = request("/conversations/c1", { method: "DELETE" });
    await until(() => aborted);
    await deleting;
    await pending;
    assert.deepEqual((await request("/work-records")).data, []);
    const changes = (await request(`/work-records/changes?after=${initial.meta.after}`)).data;
    assert.deepEqual(changes, [{ operation: "delete", record_id: initial.data[0].id }]);
    const stats = (await request("/usage/statistics")).data;
    assert.equal(stats.execution_count, 1);
    assert.equal(stats.succeeded_count, 0);
    assert.equal(stats.non_success_count, 1);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS n FROM work_record").get()!.n, 0);
    assert.deepEqual((await request("/messages/search?q=deleted")).data, []);
  } finally { release(); await pending; await http.close(); await fixture.close(); }
});

test("concurrent group fan-out counts actual employee executions once, and peer tool delivery shares the lifecycle and source seam", async () => {
  const fixture = await createFixture();
  seed(fixture, true);
  await fixture.host.initializeConversationParticipants("c1", caller);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.faux.setResponses([async () => { await gate; return response("identical"); }, async () => { await gate; return response("identical"); }]);
  const { http, request } = await serve(fixture);
  try {
    const body = { text: "fanout", mentions: ["e1", "e2"] };
    await request("/conversations/c1/prompt", { method: "POST", status: 202, body, key: "group-once" });
    await request("/conversations/c1/prompt", { method: "POST", status: 202, body, key: "group-once" });
    await until(() => sources(fixture) === 2);
    const active = await request("/work-records?limit=1");
    assert.equal(active.page.has_more, true);
    const older = await request(`/work-records?limit=1&before=${active.page.next_cursor}`);
    assert.equal(older.data.length, 1);
    assert.notEqual(active.data[0].employee_id, older.data[0].employee_id);
    assert.equal(older.meta.after, active.meta.after);
    await request(`/work-records?employee_id=e1&before=${active.page.next_cursor}`, { status: 422 });
    release();
    await until(() => !fixture.host.isPrompting("c1"));
    let cursor = active.meta.after;
    const finalIds = [];
    do {
      const page = await request(`/work-records/changes?limit=1&after=${cursor}`);
      finalIds.push(...page.data.map((item: any) => { assert.equal(item.record.outcome, "succeeded"); return item.record.id; }));
      cursor = page.page.next_cursor;
      if (!page.page.has_more) break;
    } while (true);
    assert.equal(new Set(finalIds).size, 2);
    assert.equal((await request("/usage/statistics")).data.execution_count, 2);
    assert.equal((await request("/usage/statistics?employee_id=e1")).data.execution_count, 1);
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mention_employee", { employee_id: "e2", task: "peer task" }), { stopReason: "toolUse" }),
      response("peer result"), response("coordinator result"),
    ]);
    await fixture.host.prompt("c1", "ask colleague", undefined, caller);
    const work = (await request("/work-records?employee_id=e2")).data;
    assert.equal(work.length, 2);
    assert.equal(work[0].source_type, "employee");
    assert.equal(work[0].source_id, "e1");
    assert.equal(work[0].task_summary, "peer task");
    assert.equal(work[0].result_summary, "peer result");
    assert.equal((await request("/usage/statistics")).data.execution_count, 4);
    assert.equal((await request("/work-records")).data.length, 4, "live ranges must not be backfilled again");
  } finally { release(); await http.close(); await fixture.close(); }
});

function persisted(fixture: Fixture, conversationId: string, employeeId: string | null, entries: unknown[]) {
  const path = join(fixture.dataRoot, "sessions", `${conversationId}-${employeeId ?? "legacy"}.jsonl`);
  writeFileSync(path, [JSON.stringify({ type: "session", version: 3, id: `${conversationId}-${employeeId}`, timestamp, cwd: fixture.dataRoot }), ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n"));
  if (employeeId) fixture.store.upsertConversationParticipant({ conversation_id: conversationId, employee_id: employeeId, role: "member", session_file: path, workspace: "", pi_session_id: null, employee_version: "1" });
  else fixture.store.saveConversation({ ...fixture.store.getConversation(conversationId)!, sessionFile: path });
  return path;
}
function message(id: string, role: string, text: string, time: string | null = timestamp) { return { type: "message", id, parentId: null, ...(time ? { timestamp: time } : {}), message: { role, content: [{ type: "text", text }], stopReason: "stop" } }; }
function legacySession(fixture: Fixture) {
  const model = fixture.faux.getModel();
  return persisted(fixture, "c1", null, [
    { type: "model_change", id: "legacy-model", parentId: null, timestamp, provider: model.provider, modelId: model.id },
    { type: "thinking_level_change", id: "legacy-thinking", parentId: "legacy-model", timestamp, thinkingLevel: "off" },
    { ...message("legacy-u", "user", "LEGACY_AUDIT_INPUT"), parentId: "legacy-thinking" },
    { ...message("legacy-a", "assistant", "LEGACY_AUDIT_RESULT"), parentId: "legacy-u", message: { ...response("LEGACY_AUDIT_RESULT"), provider: model.provider, api: model.api, model: model.id, timestamp: Date.parse(timestamp) } },
  ]);
}

test("legacy context reopen retains the designated managed Session and existing work entry identities without executing", async () => {
  const fixture = await createFixture();
  seed(fixture);
  const path = legacySession(fixture);
  const raw = readFileSync(path, "utf8");
  const { http, request } = await serve(fixture);
  try {
    const before = (await request("/work-records")).data;
    assert.equal(before.length, 1);
    assert.equal(before[0].task_summary, "LEGACY_AUDIT_INPUT");
    await request("/conversations/c1/context");
    assert.equal(fixture.store.getConversationParticipant("c1", "e1")!.session_file, path);
    assert.equal(fixture.store.getConversation("c1")!.sessionFile, path);
    assert.deepEqual((await request("/work-records")).data, before);
    assert.equal((await request("/messages/search?q=LEGACY_AUDIT_INPUT")).data.length, 1);
    assert.equal((await request(`/conversations/c1/entries?entry_ref=${before[0].input_entry_ref}&limit=1`)).data.entries[0].id, "legacy-u");
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal((await request("/usage/statistics")).data.execution_count, 0);
  } finally { await http.close(); await fixture.close(); }
});

test("legacy prompt and restart append to the same Session without rebinding old observations or re-metering history", async () => {
  const fixture = await createFixture();
  seed(fixture);
  const path = legacySession(fixture);
  let service = await serve(fixture);
  try {
    const before = (await service.request("/work-records")).data[0];
    fixture.faux.setResponses([response("NEW_AUDIT_RESULT")]);
    await service.request("/conversations/c1/prompt", { method: "POST", status: 202, key: "legacy-new-prompt", body: { text: "NEW_AUDIT_INPUT" } });
    await until(() => !fixture.host.isPrompting("c1"));
    assert.equal(fixture.store.getConversationParticipant("c1", "e1")!.session_file, path);
    const after = (await service.request("/work-records")).data;
    assert.equal(after.length, 2);
    assert.deepEqual(after.find((row: any) => row.id === before.id), before);
    assert.equal(after[0].task_summary, "NEW_AUDIT_INPUT");
    assert.equal(after[0].result_summary, "NEW_AUDIT_RESULT");
    assert.equal((await service.request("/usage/statistics")).data.execution_count, 1);
    await service.http.close();
    await fixture.host.dispose();
    fixture.store.close();
    const store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
    const host = new SessionHost({ store, cwdRoot: join(fixture.dataRoot, "workspaces"), sessionDir: join(fixture.dataRoot, "sessions"), agentDir: join(fixture.dataRoot, "pi"), modelRuntime: fixture.modelRuntime, resourceLoaderFactory: () => createControlledResourceLoader("test") });
    service = await serve({ store, host });
    try {
      assert.deepEqual((await service.request("/work-records")).data, after);
      assert.equal((await service.request("/usage/statistics")).data.execution_count, 1);
      for (const q of ["LEGACY_AUDIT_INPUT", "LEGACY_AUDIT_RESULT", "NEW_AUDIT_INPUT", "NEW_AUDIT_RESULT"]) assert.equal((await service.request(`/messages/search?q=${q}`)).data.length, 1);
      assert.equal((await service.request(`/conversations/c1/entries?entry_ref=${before.input_entry_ref}&limit=1`)).data.entries[0].id, "legacy-u");
    } finally { await service.http.close(); await host.dispose(); store.close(); }
  } finally { await service.http.close().catch(() => undefined); await fixture.close().catch(() => undefined); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("legacy group first opening a peer preserves old history and assigns the old Session only to the indexed employee", async () => {
  const fixture = await createFixture();
  seed(fixture, true);
  const path = legacySession(fixture);
  const { http, request } = await serve(fixture);
  try {
    const before = (await request("/work-records")).data[0];
    fixture.faux.setResponses([response("peer result")]);
    await fixture.host.prompt("c1", "peer input", undefined, caller, ["e2"]);
    assert.equal(fixture.store.getConversationParticipant("c1", "e1"), undefined);
    assert.equal((await request("/messages/search?q=LEGACY_AUDIT_INPUT")).data.length, 1, "a new peer participant must not hide the indexed employee's legacy file");
    assert.deepEqual((await request("/work-records")).data.find((row: any) => row.id === before.id), before);
    await fixture.host.initializeConversationParticipants("c1", caller);
    assert.equal(fixture.store.getConversationParticipant("c1", "e1")!.session_file, path);
    assert.notEqual(fixture.store.getConversationParticipant("c1", "e2")!.session_file, path);
    const after = (await request("/work-records")).data;
    assert.equal(after.length, 2);
    assert.deepEqual(after.find((row: any) => row.id === before.id), before);
    const peerEntries = fixture.host.readHistorySources("c1", caller).find((source) => source.employeeId === "e2")!.entries;
    assert.doesNotMatch(JSON.stringify(peerEntries), /LEGACY_AUDIT/);
  } finally { await http.close(); await fixture.close(); }
});

test("legacy Session adoption rejects paths outside managed data roots without reading, indexing or overwriting them", async () => {
  const fixture = await createFixture();
  seed(fixture);
  const original = readFileSync(legacySession(fixture), "utf8");
  const outside = join(fixture.root, "outside-managed.jsonl");
  writeFileSync(outside, original);
  fixture.store.saveConversation({ ...fixture.store.getConversation("c1")!, sessionFile: outside });
  try {
    assert.deepEqual(fixture.host.readHistorySources("c1", caller)[0]!.entries, []);
    await assert.rejects(fixture.host.getConversationContext("c1", caller), /Path escapes Agent data root/);
    await assert.rejects(fixture.host.prompt("c1", "must not run", undefined, caller), /Path escapes Agent data root/);
    assert.equal(fixture.store.getConversationParticipant("c1", "e1"), undefined);
    assert.equal(fixture.store.workRecords.history(owner, 10).length, 0);
    assert.equal(readFileSync(outside, "utf8"), original);
  } finally { await fixture.close(); }
});

test("work summaries fail closed when same ordinals in a replaced file have different first or last entry identities", async () => {
  const fixture = await createFixture();
  seed(fixture);
  const path = legacySession(fixture);
  const { http, request } = await serve(fixture);
  try {
    const before = (await request("/work-records")).data[0];
    const original = readFileSync(path, "utf8");
    const replacement = join(fixture.dataRoot, "sessions", "replacement.jsonl");
    fixture.store.upsertConversationParticipant({ conversation_id: "c1", employee_id: "e1", role: "member", session_file: replacement, workspace: "", pi_session_id: null, employee_version: "1" });
    for (const [firstId, lastId] of [["new-u", "new-a"], ["legacy-u", "new-a"], ["new-u", "legacy-a"]]) {
      writeFileSync(replacement, original.replaceAll("legacy-u", firstId!).replaceAll("legacy-a", lastId!).replaceAll("LEGACY_AUDIT", "UNRELATED_AUDIT"));
      const row = (await request("/work-records")).data.find((item: any) => item.id === before.id);
      assert.equal(row.id, before.id);
      assert.equal(row.occurred_at, before.occurred_at);
      for (const key of ["task_summary", "result_summary", "input_entry_ref", "output_entry_ref", "source_type", "source_id"]) assert.equal(row[key], null, `${key} must not bind different entries at the same ordinals`);
    }
    assert.equal((await request("/usage/statistics")).data.execution_count, 0);
  } finally { await http.close(); await fixture.close(); }
});

test("old Pi history is queryable with truthful time/usage provenance, precise filters, stable restart cursors and no re-metering", async () => {
  const fixture = await createFixture();
  seed(fixture, true);
  const paths = ["e1", "e2"].map((employee) => persisted(fixture, "c1", employee, [message("u", "user", "old fanout"), message("a", "assistant", "old reply")]));
  fixture.store.updateConversation("conversation-1", { entryEmployeeId: "e1" });
  persisted(fixture, "conversation-1", "e1", [message("no-time", "assistant", "unknown time", null)]);
  fixture.store.upsertUsageSummary(aggregateUsage({ ...owner, employeeId: "e1", startedAt: Date.parse(timestamp), endedAt: Date.parse(timestamp), entries: [], settled: true }));
  const raw = paths.map((path) => readFileSync(path, "utf8"));
  let service = await serve(fixture);
  const first = await service.request("/work-records?limit=1");
  try {
    const all = (await service.request("/work-records")).data;
    assert.equal(all.length, 3);
    assert.equal(all[0].occurred_at, timestamp);
    for (const row of all) {
      assert.equal(row.provenance, "pi_history");
      assert.equal(row.started_at, null);
      assert.equal(row.ended_at, null);
      assert.equal(row.usage, null);
    }
    assert.equal(all[2].time_basis, "unknown");
    assert.equal(all[2].occurred_at, null);
    assert.equal((await service.request("/work-records?window_start=2026-09-05T08:01:02.123Z&window_end=2026-09-05T08:01:02.124Z")).data.length, 2);
    assert.equal((await service.request("/work-records?window_start=2026-09-05T08:01:02.124Z&window_end=2026-09-05T08:01:02.125Z")).data.length, 0);
    await service.request(`/work-records?window_start=2026-09-05T08:00:00Z&window_end=2026-09-05T09:00:00Z&before=${first.page.next_cursor}`, { status: 422 });
    assert.equal((await service.request("/usage/statistics")).data.execution_count, 1, "backfill never writes usage");
    assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")), raw);
    await service.http.close();
    await fixture.host.dispose();
    fixture.store.close();
    const store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
    const host = new SessionHost({ store, cwdRoot: join(fixture.dataRoot, "workspaces"), sessionDir: join(fixture.dataRoot, "sessions"), agentDir: join(fixture.dataRoot, "pi"), modelRuntime: fixture.modelRuntime, resourceLoaderFactory: () => createControlledResourceLoader("test") });
    service = await serve({ store, host });
    try {
      assert.deepEqual((await service.request("/work-records")).data, all);
      const second = await service.request(`/work-records?limit=1&before=${first.page.next_cursor}`);
      assert.equal(second.data[0].id, all[1].id);
      assert.deepEqual((await service.request(`/work-records/changes?after=${first.meta.after}`)).data, []);
      assert.equal((await service.request("/usage/statistics")).data.execution_count, 1);
      await service.request("/conversations/c1", { method: "DELETE", status: 200 });
      const changes = (await service.request(`/work-records/changes?after=${first.meta.after}`)).data;
      assert.equal(changes.length, 2);
      assert(changes.every((item: any) => item.operation === "delete" && Object.keys(item).length === 2));
    } finally { await service.http.close(); await host.dispose(); store.close(); }
  } finally { await service.http.close().catch(() => undefined); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("changes pagination cannot miss same-timestamp active records finalized between pages or a deleted history anchor", async () => {
  const fixture = await createFixture();
  const { http, request } = await serve(fixture);
  try {
    const initial = await request("/work-records");
    const repo = fixture.store.workRecords;
    const ids = ["e1", "e2", "e3"].map((employeeId) => repo.start({ ...owner, conversationId: "c1", employeeId, startedAt: Date.parse(timestamp), startOrdinal: 0 }));
    const history = await request("/work-records?limit=1");
    const page1 = await request(`/work-records/changes?after=${initial.meta.after}&limit=1`);
    assert.equal(page1.data[0].record_id, ids[0]);
    assert.equal(page1.data[0].record.outcome, "active");
    const finish = { outcome: "succeeded" as const, endedAt: Date.parse(timestamp), endOrdinal: 0, firstEntryId: null, lastEntryId: null, firstEntryAt: null, lastEntryAt: null, usage: null };
    repo.finish(ids[0]!, owner, finish);
    repo.finish(ids[1]!, owner, finish);
    let cursor = page1.page.next_cursor;
    const seen = new Map<string, string>();
    while (true) {
      const page = await request(`/work-records/changes?after=${cursor}&limit=1`);
      for (const item of page.data) seen.set(item.record_id, item.record.outcome);
      cursor = page.page.next_cursor;
      if (!page.page.has_more) break;
    }
    assert.equal(seen.get(ids[0]!), "succeeded", "already-seen active ID must be upserted again");
    assert.equal(seen.get(ids[1]!), "succeeded", "unseen ID moved by finalization must not be skipped");
    assert.equal(seen.get(ids[2]!), "active");
    assert.equal((await request("/work-records?window_start=2026-09-05T08:01:02.123Z&window_end=2026-09-05T08:01:02.124Z")).data.length, 3);
    await request("/conversations/c1", { method: "DELETE" });
    assert.deepEqual((await request(`/work-records?limit=1&before=${history.page.next_cursor}`)).data, [], "before uses a frozen tuple, not a deleted anchor lookup");
    const changes = (await request(`/work-records/changes?after=${cursor}`)).data;
    assert.equal(changes.length, 3);
    assert(changes.every((item: any) => item.operation === "delete"));
  } finally { await http.close(); await fixture.close(); }
});

test("crash recovery remains unknown despite terminal JSONL and cannot absorb later work or be re-metered after restart", async () => {
  const fixture = await createFixture();
  seed(fixture);
  persisted(fixture, "c1", "e1", [message("old-u", "user", "crashed task"), message("old-a", "assistant", "unconfirmed result")]);
  const id = fixture.store.workRecords.start({ ...owner, conversationId: "c1", employeeId: "e1", startedAt: Date.parse(timestamp), startOrdinal: 0 });
  let service = await serve(fixture);
  const initial = await service.request("/work-records");
  assert.equal(initial.data.length, 1, "active interval must exclude backfill");
  await service.http.close();
  await fixture.host.dispose();
  fixture.store.close();
  const store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
  const host = new SessionHost({ store, cwdRoot: join(fixture.dataRoot, "workspaces"), sessionDir: join(fixture.dataRoot, "sessions"), agentDir: join(fixture.dataRoot, "pi"), modelRuntime: fixture.modelRuntime, resourceLoaderFactory: () => createControlledResourceLoader("test") });
  service = await serve({ store, host });
  try {
    const changes = await service.request(`/work-records/changes?after=${initial.meta.after}`);
    assert.equal(changes.data.length, 1);
    assert.equal(changes.data[0].record.outcome, "unknown");
    assert.equal(changes.data[0].record.reason, "process_restart");
    assert.equal(changes.data[0].record.ended_at, null);
    assert.equal(changes.data[0].record.usage, null);
    const newId = store.workRecords.start({ ...owner, conversationId: "c1", employeeId: "e1", startedAt: Date.parse(timestamp) + 1000, startOrdinal: 2 });
    const path = store.getConversationParticipant("c1", "e1")!.session_file;
    writeFileSync(path, readFileSync(path, "utf8") + [message("new-u", "user", "later task"), message("new-a", "assistant", "later result")].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    store.workRecords.finish(newId, owner, { outcome: "succeeded", endedAt: Date.parse(timestamp) + 2000, endOrdinal: 4, firstEntryId: "new-u", lastEntryId: "new-a", firstEntryAt: Date.parse(timestamp), lastEntryAt: Date.parse(timestamp), usage: null });
    const rows = (await service.request("/work-records")).data;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row: any) => row.id === id).outcome, "unknown");
    assert.equal(rows.find((row: any) => row.id === id).result_summary, "unconfirmed result");
    assert.equal(rows.find((row: any) => row.id === newId).result_summary, "later result");
    assert.equal((await service.request("/usage/statistics")).data.execution_count, 0);
    await service.request("/conversations/c1", { method: "DELETE" });
    const deleted = (await service.request(`/work-records/changes?after=${changes.page.next_cursor}`)).data;
    assert.equal(deleted.length, 2);
    assert(deleted.every((item: any) => item.operation === "delete"));
    await service.http.close();
    await host.dispose();
    store.close();
    const reopened = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
    try {
      assert.equal(reopened.workRecords.history(owner, 10).length, 0);
      assert.equal(reopened.workRecords.changes(owner, 0, 10).filter((row) => row.deleted === 1).length, 2);
      assert.equal(reopened.workRecords.changes({ ...owner, memberId: "other" }, 0, 10).length, 0);
    } finally { reopened.close(); }
  } finally { await service.http.close().catch(() => undefined); await host.dispose(); try { store.close(); } catch {} rmSync(fixture.root, { recursive: true, force: true }); }
});

test("work APIs expose concrete OpenAPI schemas, cursor directions, nullable provenance and hour range errors", async () => {
  const fixture = await createFixture();
  const { http, request } = await serve(fixture);
  try {
    const doc = await request("/openapi.json");
    for (const [path, parameters] of [["work-records", ["employee_id", "window_start", "window_end", "limit", "before"]], ["work-records/changes", ["employee_id", "after", "limit"]], ["usage/statistics", ["employee_id", "window_start", "window_end"]]] as const) {
      const operation = doc.paths[`/api/agent/${path}`].get;
      assert(operation.summary && operation.description && operation.security.length);
      assert.deepEqual(operation.parameters.map((item: any) => item.name).sort(), [...parameters].sort());
      for (const status of [200, 401, 422]) assert(operation.responses[status]);
      assert(operation.responses[200].content["application/json"].examples);
    }
    const schema = doc.components.schemas.WorkRecord;
    assert(schema.properties.provenance);
    assert(schema.properties.started_at.anyOf.some((item: any) => item.type === "null"));
    assert.equal(doc.components.schemas.UsageStatistics.properties.known_cost_total.pattern, "^\\d+\\.\\d{12}$");
  } finally { await http.close(); await fixture.close(); }
});

test("group tool cycles, peer deliveries and repeat prompts share work IDs across SSE, HTTP history and cold reads", async () => {
  const fixture = await createFixture();
  seed(fixture, true);
  await fixture.host.initializeConversationParticipants("c1", caller);
  const events: import("../pi/session-host.js").PiEventEnvelope[] = [];
  const unsubscribe = await fixture.host.subscribe("c1", (event) => { events.push(event); });
  const { http, request } = await serve(fixture);
  try {
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mention_employee", { employee_id: "e2", task: "peer task" }), { stopReason: "toolUse" }),
      response("peer reply"), response("final JD"), response("new JD"),
    ]);
    await fixture.host.prompt("c1", "write JD", undefined, caller);
    await fixture.host.prompt("c1", "write another JD", undefined, caller);
    const records = fixture.store.workRecords.forConversation("c1", owner);
    assert.equal(records.length, 3);
    const history = (await request("/conversations/c1/entries")).data.entries;
    for (const record of records) {
      const outputs = history.filter((entry: any) => entry.work_id === record.id);
      assert(outputs.length > 0);
      assert(outputs.every((entry: any) => entry.source_employee_id === record.employee_id && entry.message?.role !== "user"));
      assert(events.some((event) => event.event.type === "agent_settled" && event.source_employee_id === record.employee_id));
    }
    const coordinatorWork = records.filter((record) => record.employee_id === "e1").sort((a, b) => a.created_seq - b.created_seq)[0]!;
    assert(history.filter((entry: any) => entry.work_id === coordinatorWork.id && entry.message?.role === "assistant").length >= 2);
    assert(history.filter((entry: any) => entry.message?.role === "user").every((entry: any) => entry.work_id === undefined));
    const page = (await request("/conversations/c1/entries?limit=100")).data.entries;
    assert.deepEqual(page.map((entry: any) => [entry.entry_ref, entry.work_id]), history.map((entry: any) => [entry.entry_ref, entry.work_id]));
    const cold = fixture.createHost();
    try {
      assert.deepEqual(cold.readEntries("c1", caller).map(({ entry }) => [entry.entry_ref, entry.work_id]), history.map((entry: any) => [entry.entry_ref, entry.work_id]));
    } finally { await cold.dispose(); }
    await request("/conversations/c1/entries", { other: true, status: 404 });
    const schema = (await request("/openapi.json")).components.schemas;
    assert(schema.ConversationEntry.properties.work_id);
    // work_id is a history-entry field only; the SSE wire shape stays Pi-native.
    assert.equal(schema.PiSseEventData.properties.work_id, undefined);
  } finally { unsubscribe(); await http.close(); await fixture.close(); }
});
