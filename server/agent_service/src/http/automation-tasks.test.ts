import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import test from "node:test";
import assert from "node:assert/strict";
import { createFixture } from "../test-fixture.js";
import { AgentHttpServer } from "./server.js";
import { ScheduleService, validateSchedule } from "../schedule.js";

async function start() {
  const fixture = await createFixture();
  const now = new Date().toISOString();
  fixture.store.replaceProjections(["e1", "e2"].map(id => ({ employee_id: id, tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: id, display_name: id, revoked: false, synced_at: now, tools: [] })), [], ["e1", "e2"].map(id => ({ employee_id: id, tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: id, display_name: id, tools: [] })));
  const http = new AgentHttpServer({ store: fixture.store, host: fixture.host, authenticate: req => ({ tenantId: "tenant-1", callerId: req.headers.authorization === "Bearer other" ? "member-2" : "member-1", userId: req.headers.authorization === "Bearer other" ? "member-2" : "member-1" }) });
  await http.listen(0);
  const addr = http.server.address(); assert(addr && typeof addr !== "string");
  const call = async (path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/agent/${path}`, { method, headers: { Authorization: "Bearer test", "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = res.status === 204 ? null : await res.json() as any;
    return { status: res.status, data: payload?.data, payload, etag: res.headers.get("etag") };
  };
  return { ...fixture, call, async finish() { await http.close(); await fixture.close(); } };
}
const input = () => ({ name: "每日简报", category: "report", prompt: "汇总进度", employee_id: "e1", connector_ids: [], schedule: { mode: "daily", timezone: "Asia/Shanghai", time: "09:00:00" } });
test("automation CRUD shares the existing conversation schedule, scopes owners, and preserves history on task delete", async () => {
  const f = await start();
  try {
    const created = await f.call("automation-tasks", "POST", input(), { "Idempotency-Key": "create" });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    const task = created.data;
    assert.equal(task.schedule.mode, "daily"); assert.equal(task.etag, created.etag);
    const replay = await f.call("automation-tasks", "POST", input(), { "Idempotency-Key": "create" });
    assert.deepEqual(replay.data, task);
    assert.equal((await f.call("automation-tasks", "POST", { ...input(), name: "不同" }, { "Idempotency-Key": "create" })).status, 409);
    assert.equal((await f.call(`automation-tasks/${task.task_id}`, "GET", undefined, { Authorization: "Bearer other" })).status, 404);
    const list = await f.call("automation-tasks"); assert.equal(list.data.length, 1); assert.equal(list.data[0].prompt, undefined);
    const paused = await f.call(`automation-tasks/${task.task_id}/actions/pause`, "POST", {}, { "If-Match": task.etag });
    assert.equal(paused.status, 200); assert.equal(f.store.getConversation(task.conversation_id)?.schedule?.enabled, false);
    assert.equal((await f.call(`automation-tasks/${task.task_id}`, "PATCH", { name: "stale" }, { "If-Match": task.etag })).status, 409);
    const oldSchedule = f.store.getConversation(task.conversation_id)!.schedule!;
    assert.equal((await f.call(`conversations/${task.conversation_id}`, "PATCH", { schedule: { ...oldSchedule, enabled: true } })).status, 200);
    const latest = await f.call(`automation-tasks/${task.task_id}`); assert.equal(latest.data.status, "active");
    const removed = await f.call(`automation-tasks/${task.task_id}`, "DELETE", undefined, { "If-Match": latest.data.etag });
    assert.equal(removed.status, 204); assert(f.store.getConversation(task.conversation_id));
    assert.equal(f.store.getConversation(task.conversation_id)?.schedule?.enabled, false);
    assert.equal((await f.call(`automation-tasks/${task.task_id}`)).status, 404);
    assert.equal((await f.call(`automation-tasks/${task.task_id}/runs?include_deleted=true`)).status, 200);
    assert.equal((await f.call(`conversations/${task.conversation_id}`, "PATCH", { schedule: { ...oldSchedule, enabled: true } })).status, 409);
  } finally { await f.finish(); }
});
test("employee edit switches execution binding without rewriting old participants", async () => {
  const f = await start();
  try {
    const { data: task } = await f.call("automation-tasks", "POST", input(), { "Idempotency-Key": "switch" });
    const changed = await f.call(`automation-tasks/${task.task_id}`, "PATCH", { employee_id: "e2" }, { "If-Match": task.etag });
    assert.equal(changed.status, 200, JSON.stringify(changed.payload));
    assert.notEqual(changed.data.conversation_id, task.conversation_id);
    assert.equal(f.store.getConversation(task.conversation_id)?.entryEmployeeId, "e1");
    assert.equal(f.store.getConversation(task.conversation_id)?.schedule, null);
    assert.equal(changed.data.employee_id, "e2");
    assert.equal((await f.call("automation-tasks")).data.length, 1);
  } finally { await f.finish(); }
});
test("legacy schedule appears once, supports edits, and cursor cannot cross owners", async () => {
  const f = await start();
  try {
    const schedule = validateSchedule({ schedule_id: "old", interval_seconds: 1, prompt_template: "old" });
    f.store.updateConversation("c1", { schedule: { ...schedule } });
    const legacy = await f.call("automation-tasks/c1"); assert.equal(legacy.status, 200); assert.equal(legacy.data.origin, "conversation");
    const changed = await f.call("automation-tasks/c1", "PATCH", { name: "旧任务" }, { "If-Match": legacy.data.etag });
    assert.equal(changed.status, 200); assert.equal(changed.data.origin, "automation");
    assert.equal(f.store.getConversation("c1")?.schedule?.interval_seconds, 1);
    await f.call("automation-tasks", "POST", input(), { "Idempotency-Key": "page" });
    const first = await f.call("automation-tasks?limit=1"); assert(first.payload.page.next_cursor);
    const cursor = encodeURIComponent(first.payload.page.next_cursor);
    assert.equal((await f.call(`automation-tasks?limit=1&cursor=${cursor}`, "GET", undefined, { Authorization: "Bearer other" })).status, 422);
  } finally { await f.finish(); }
});
test("one-shot executes through SessionHost and is linked to work records without replay", async () => {
  const f = await start();
  try {
    const at = Date.now() + 10_000;
    const { data: task } = await f.call("automation-tasks", "POST", { ...input(), schedule: { mode: "once", timezone: "UTC", run_at: new Date(at).toISOString() } }, { "Idempotency-Key": "run" });
    f.faux.setResponses([fauxAssistantMessage("简报完成")]);
    const scheduler = new ScheduleService(f.store, f.host);
    await scheduler.tick(at - 1); assert.equal(await scheduler.tick(at + 1), 1);
    for (let i = 0; i < 100 && f.host.isPrompting(task.conversation_id); i++) await new Promise(r => setTimeout(r, 10));
    const runs = await f.call(`automation-tasks/${task.task_id}/runs`);
    assert.equal(runs.data.length, 1); assert.equal(runs.data[0].work_record_ids.length, 1);
    assert.equal(runs.data[0].status, "succeeded", JSON.stringify(runs.data));
    assert.equal(await scheduler.tick(at + 2), 0);
    const final = await f.call(`automation-tasks/${task.task_id}`); assert.equal(final.data.status, "completed");
    assert.equal((await f.call(`automation-tasks/${task.task_id}/actions/enable`, "POST", {}, { "If-Match": final.data.etag })).status, 409);
  } finally { await f.finish(); }
});
test("deleting a conversation disables its task and stale repeating reservations cannot execute", async () => {
  const f = await start();
  try {
    const { data: task } = await f.call("automation-tasks", "POST", { ...input(), schedule: { mode: "interval", timezone: "UTC", starts_at: new Date(Date.now() + 60_000).toISOString(), interval_seconds: 300 } }, { "Idempotency-Key": "delete-conversation" });
    const captured = f.store.getConversation(task.conversation_id)!;
    const schedule = validateSchedule(captured.schedule);
    await f.call(`automation-tasks/${task.task_id}/actions/pause`, "POST", {}, { "If-Match": task.etag });
    assert.throws(() => f.store.reservePrompt({ conversationId: captured.id, callerId: "member-1", key: "stale", fingerprint: "x", scheduleId: schedule.schedule_id, scheduleRevision: schedule.revision, scheduleGeneration: captured.scheduleGeneration }), /replaced/);
    assert.equal(f.store.db.prepare("SELECT 1 FROM idempotency_receipt WHERE idempotency_key = 'stale'").get(), undefined);
    assert.equal((await f.call(`conversations/${task.conversation_id}`, "DELETE")).status, 200);
    assert.equal((await f.call(`automation-tasks/${task.task_id}`)).status, 404);
    assert.equal((await f.call("automation-tasks")).data.length, 0);
    assert.equal((await f.call(`automation-tasks/${task.task_id}/runs?include_deleted=true`)).status, 200);
  } finally { await f.finish(); }
});
test("calendar tick dedupes an occurrence and pause prevents future calendar launches", async () => {
  const f = await start();
  try {
    const { data: task } = await f.call("automation-tasks", "POST", input(), { "Idempotency-Key": "calendar-tick" });
    const at = Date.parse("2026-09-23T01:00:00Z");
    let launched = 0;
    const scheduler = new ScheduleService(f.store, { isPrompting: () => false, prompt: async () => { launched++; return "entry-1"; } } as never);
    await scheduler.tick(at - 1); assert.equal(await scheduler.tick(at + 1), 1);
    assert.equal(await scheduler.tick(at + 2), 0);
    const latest = await f.call(`automation-tasks/${task.task_id}`);
    await f.call(`automation-tasks/${task.task_id}/actions/pause`, "POST", {}, { "If-Match": latest.data.etag });
    assert.equal(await scheduler.tick(at + 86_400_000), 0); assert.equal(launched, 1);
  } finally { await f.finish(); }
});
