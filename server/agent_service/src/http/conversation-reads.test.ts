import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { SessionHost } from "../pi/session-host.js";
import { createControlledResourceLoader } from "../pi/resources.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] };
const timestamp = "2026-09-05T08:00:00.000Z";
type Fixture = Awaited<ReturnType<typeof createFixture>>;

function message(id: string, role: string, content: unknown, time = timestamp) {
  return { type: "message", id, parentId: null, timestamp: time, message: { role, content, timestamp: Date.parse(time) } };
}
function persisted(fixture: Fixture, conversationId: string, employeeId: string | null, entries: unknown[], role: "member" | "coordinator" = "member") {
  const sessionFile = join(fixture.dataRoot, "sessions", `${conversationId}-${employeeId ?? "legacy"}.jsonl`);
  writeFileSync(sessionFile, [JSON.stringify({ type: "session", version: 3, id: `session-${conversationId}-${employeeId}`, timestamp, cwd: fixture.dataRoot }), ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n"));
  if (employeeId) fixture.store.upsertConversationParticipant({ conversation_id: conversationId, employee_id: employeeId, role, session_file: sessionFile, workspace: "", pi_session_id: null, employee_version: "1" });
  else fixture.store.saveConversation({ ...fixture.store.getConversation(conversationId)!, sessionFile });
  return sessionFile;
}
function seedGroup(fixture: Fixture) {
  const experts = ["coord", "worker", "outsider"].map((id) => ({ employee_id: id, tenant_id: "tenant-1", member_id: "member-1", version: "1", display_name: id, handle: id, revoked: false, status: "active", synced_at: timestamp }));
  fixture.store.replaceProjections(experts, [], experts.map((expert) => ({ ...expert, snapshot_version: "1", tool_policy: { allowed_tools: [] } })));
  fixture.store.createConversation({ id: "group", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
  persisted(fixture, "group", "coord", [message("human", "user", "human fanout"), message("same", "assistant", "coord answer")], "coordinator");
  persisted(fixture, "group", "worker", [message("human-copy", "user", "human fanout"), message("same", "assistant", "worker answer")]);
  for (const [employeeId, entryId] of [["coord", "human"], ["worker", "human-copy"]]) fixture.store.upsertConversationEntrySource({ conversation_id: "group", employee_id: employeeId!, pi_entry_id: entryId!, logical_message_id: "logical", source_type: "human", source_id: "member-1" });
}
async function serve(fixture: Pick<Fixture, "host" | "store">) {
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: (request) => ({ ...caller, ...(request.headers.authorization === "Bearer other" ? { userId: "other", callerId: "other" } : {}) }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  return {
    http,
    async request(path: string, status = 200, body?: unknown, other = false, method = "PATCH"): Promise<any> {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent${path}`, { headers: { Authorization: other ? "Bearer other" : "Bearer owner", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { method, body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, status, await response.clone().text());
      if (status >= 400) assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
      return response.json();
    },
  };
}

function snapshot(fixture: Fixture) {
  return {
    conversations: fixture.store.db.prepare("SELECT * FROM conversation ORDER BY id").all(),
    participants: fixture.store.db.prepare("SELECT * FROM conversation_participant_session ORDER BY conversation_id, employee_id").all(),
    files: readdirSync(join(fixture.dataRoot, "sessions")).map((file) => [file, readFileSync(join(fixture.dataRoot, "sessions", file), "utf8")]),
    workspaces: readdirSync(join(fixture.dataRoot, "workspaces")),
  };
}

test("conversation reads are owner-scoped and observational for empty, silent and legacy sessions", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  fixture.store.createConversation({ id: "empty-group", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
  fixture.store.createConversation({ id: "silent", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
  persisted(fixture, "silent", "coord", [message("thinking", "assistant", [{ type: "thinking", thinking: "private thinking" }]), message("tool", "toolResult", "private tool")], "coordinator");
  fixture.store.updateConversation("c1", { entryEmployeeId: "coord" });
  persisted(fixture, "c1", null, [message("legacy", "assistant", "legacy persisted answer")]);
  const { http, request } = await serve(fixture);
  try {
    const before = snapshot(fixture);
    const empty = await request("/conversations/empty-group/entries");
    assert.deepEqual(empty, { data: { conversation_id: "empty-group", entries: [] } });
    assert.deepEqual((await request("/conversations/empty-group/participants")).data, { conversation_id: "empty-group", participants: [], employee_count: 0 });
    for (const id of ["empty-group", "silent"]) {
      const value = (await request(`/conversations/${id}`)).data;
      assert.equal(value.last_preview, null);
      assert.equal(value.unread_count, 0);
    }
    assert.equal((await request("/conversations/c1/entries")).data.entries[0].id, "legacy");
    assert.equal((await request("/messages/search?q=legacy")).data.length, 1);
    assert.equal((await request("/messages/search?q=private")).data.length, 0);
    for (const suffix of ["", "/entries", "/entries?limit=1", "/participants"]) await request(`/conversations/group${suffix}`, 404, undefined, true);
    await request("/messages/search?q=answer&conversation_id=group", 404, undefined, true);
    assert.deepEqual((await request("/messages/search?q=answer", 200, undefined, true)).data, []);
    assert.deepEqual(snapshot(fixture), before, "reads must not initialize sessions, alter indexes or write files");
    assert.throws(() => fixture.host.readEntries("group", { ...caller, userId: "other" }), /not owned/);
  } finally { await http.close(); await fixture.close(); }
});

test("history pagination, search location and read pointers share stable participant-qualified identity", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  const { http, request } = await serve(fixture);
  try {
    const legacy = await request("/conversations/group/entries");
    assert.deepEqual(Object.keys(legacy), ["data"]);
    assert.deepEqual(legacy.data.entries.map((entry: any) => entry.id), ["human", "same", "same"]);
    assert.equal(new Set(legacy.data.entries.map((entry: any) => entry.entry_ref)).size, 3);
    assert.deepEqual(legacy.data.entries.map((entry: any) => entry.source_role), ["human", "coordinator", "participant"]);
    const first = await request("/conversations/group/entries?limit=2");
    assert.equal(first.page.has_more, true);
    const second = await request(`/conversations/group/entries?limit=2&cursor=${first.page.next_cursor}`);
    assert.equal(second.page.has_more, false);
    assert.deepEqual([...first.data.entries, ...second.data.entries], legacy.data.entries);
    for (const path of ["/conversations/c1/entries?cursor=", "/conversations?cursor=", "/messages/search?q=answer&cursor="]) await request(`${path}${first.page.next_cursor}`, 422);
    await request("/conversations/group/entries?cursor=garbage", 422);
    await request("/conversations/group/entries?after=1", 422);
    const hit = (await request("/messages/search?q=worker&conversation_id=group")).data[0];
    assert.equal(hit.source_employee_id, "worker");
    const located = await request(`/conversations/group/entries?entry_ref=${hit.entry_ref}&limit=1`);
    assert.equal(located.data.entries[0].entry_ref, hit.entry_ref);
    await request(`/conversations/c1/entries?entry_ref=${hit.entry_ref}`, 422);
    await request(`/conversations/group/entries?entry_ref=${hit.entry_ref}&cursor=${first.page.next_cursor}`, 422);
    assert.equal((await request("/conversations/group")).data.unread_count, 2);
    assert.equal((await request("/conversations/group")).data.last_preview, "worker answer");
    await request("/conversations/group", 422, { last_read_entry_id: "same" });
    await request("/conversations/group", 422, { last_read_entry_id: "not-an-entry" });
    await request("/conversations/c1", 422, { last_read_entry_id: hit.entry_ref });
    await request("/conversations/group", 404, { last_read_entry_id: hit.entry_ref }, true);
    const mark = await request("/conversations/group", 200, { last_read_entry_id: first.data.entries[1].entry_ref });
    assert.equal(mark.data.unread_count, 1);
    assert.equal((await request("/conversations/group", 200, { last_read_entry_id: hit.entry_ref })).data.unread_count, 0);
    const oldId = await request("/conversations/group", 200, { last_read_entry_id: "human-copy" });
    assert.equal(oldId.data.last_read_entry_id, legacy.data.entries[0].entry_ref);
    assert.equal(oldId.data.unread_count, 2);
    assert.equal((await request("/conversations/group", 200, { last_read_entry_id: null })).data.unread_count, 2);
    assert.equal((await request("/messages/search?q=fanout")).data.length, 1);
    assert.equal((await request("/messages/search?q=fanout&employee_id=coord")).data.length, 0);
  } finally { await http.close(); await fixture.close(); }
});

test("roster uses only real participants, keeps revoked identity and never returns paths or credentials", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  fixture.store.replaceProjections([], [], [], ["worker"], { tenantId: "tenant-1", memberId: "member-1" });
  const { http, request } = await serve(fixture);
  try {
    const roster = await request("/conversations/group/participants");
    assert.equal(roster.data.employee_count, 2);
    assert.deepEqual(roster.data.participants.map((item: any) => [item.employee_id, item.role, item.available]), [["coord", "coordinator", true], ["worker", "participant", false]]);
    for (const item of roster.data.participants) assert.deepEqual(Object.keys(item).sort(), ["available", "department_ids", "display_name", "employee_id", "handle", "role", "role_title"]);
    assert.doesNotMatch(JSON.stringify(roster), /outsider|session_file|workspace|pi_session|credential|\/tmp|\/Users/);
    assert.equal((await request("/messages/search?q=worker&employee_id=worker")).data.length, 1, "revocation does not erase owner-local history");
  } finally { await http.close(); await fixture.close(); }
});

test("full-text search scans beyond display limits, redacts before slicing, and binds all cursor filters", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  const long = `${"x".repeat(4500)} LongNeedle token=supersecretvalue /Users/private/secret.txt END`;
  const blocks = [...Array.from({ length: 35 }, () => ({ type: "text", text: "padding " })), { type: "text", text: "BlockNeedle api_key=" }, { type: "text", text: "splitsecret FINDME" }];
  persisted(fixture, "c1", null, [message("long", "assistant", long), message("blocks", "assistant", blocks)]);
  const { http, request } = await serve(fixture);
  try {
    const legacy = await request("/conversations/c1/entries");
    assert.doesNotMatch(JSON.stringify(legacy), /LongNeedle|BlockNeedle/);
    for (const q of ["longneedle", "BlockNeedle", "FINDME"]) {
      const hits = await request(`/messages/search?q=${q}`);
      assert.equal(hits.data.length, 1);
      assert.match(hits.data[0].snippet.toLowerCase(), new RegExp(q.toLowerCase()));
      assert(hits.data[0].snippet.length <= 240);
      assert.doesNotMatch(JSON.stringify(hits), /supersecretvalue|splitsecret|\/Users|secret\.txt/);
    }
    for (const q of ["supersecret", "splitsecret", "secret.txt"]) assert.equal((await request(`/messages/search?q=${q}`)).data.length, 0);
    const first = await request("/messages/search?q=answer&limit=1");
    assert.equal(first.page.has_more, true);
    assert.equal(first.data[0].source_employee_id, "worker");
    const cursor = first.page.next_cursor;
    const second = await request(`/messages/search?q=answer&limit=1&cursor=${cursor}`);
    assert.equal(second.data[0].source_employee_id, "coord");
    assert.equal(second.page.has_more, false);
    for (const suffix of ["q=changed", "q=answer&employee_id=coord", "q=answer&conversation_id=group"]) await request(`/messages/search?${suffix}&cursor=${cursor}`, 422);
    await request(`/messages/search?q=answer&cursor=${cursor}`, 422, undefined, true);
    await request(`/conversations/group/entries?cursor=${cursor}`, 422);
    for (const query of ["q=", "q=%20%20", "q=x&q=y", "q=x&limit=101", "q=x&after=1", `q=${"a".repeat(201)}`]) await request(`/messages/search?${query}`, 422);
  } finally { await http.close(); await fixture.close(); }
});

test("literal message search preserves repeated spaces and newlines before compacting snippets, including beyond HTTP truncation", async () => {
  const fixture = await createFixture();
  persisted(fixture, "c1", null, [
    message("spaces", "assistant", `${"x".repeat(4500)} alpha  beta`),
    message("newline", "assistant", [{ type: "text", text: "alpha\n" }, { type: "text", text: "beta" }]),
    message("single", "assistant", "alpha beta"),
  ]);
  const { http, request } = await serve(fixture);
  try {
    for (const [q, id] of [[" alpha  beta ", "spaces"], ["alpha\nbeta", "newline"], ["alpha beta", "single"]]) {
      const hits = (await request(`/messages/search?${new URLSearchParams({ q: q! })}`)).data;
      assert.deepEqual(hits.map((hit: any) => hit.id), [id], "matching must use the literal stored whitespace, not the display summary");
      assert.match(hits[0].snippet, /alpha beta/);
      assert(hits[0].snippet.length <= 240);
      assert.doesNotMatch(hits[0].snippet, /\s{2,}/);
    }
    assert.equal((await request("/conversations/c1")).data.last_preview, "alpha beta");
  } finally { await http.close(); await fixture.close(); }
});

test("message search covers more than 100 owner conversations and deleted content is not retained", async () => {
  const fixture = await createFixture();
  fixture.store.saveConversation({ ...fixture.store.getConversation("c1")!, updatedAt: "2020-01-01T00:00:00.000Z" });
  persisted(fixture, "c1", null, [message("old", "assistant", "oldest needle")]);
  fixture.store.saveConversation({ ...fixture.store.getConversation("c1")!, updatedAt: "2020-01-01T00:00:00.000Z" });
  for (let index = 0; index < 105; index += 1) fixture.store.createConversation({ id: `new-${index}`, tenantId: "tenant-1", memberId: "member-1" });
  const { http, request } = await serve(fixture);
  try {
    assert.equal((await request("/messages/search?q=oldest")).data[0].conversation_id, "c1");
    await request("/conversations/c1", 200, {}, false, "DELETE");
    assert.deepEqual((await request("/messages/search?q=oldest")).data, []);
    await request("/conversations/c1", 404);
  } finally { await http.close(); await fixture.close(); }
});

async function waitForSources(fixture: Fixture, conversationId: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = fixture.store.db.prepare("SELECT * FROM conversation_entry_source WHERE conversation_id = ?").all(conversationId);
    if (rows.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("user source indexes must be present before the blocked prompt settles");
}

test("active human fanout is indexed before settlement and stays deduplicated in read-only APIs and cold history", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  fixture.store.createConversation({ id: "live", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
  await fixture.host.initializeConversationParticipants("live", caller);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.faux.setResponses([async () => { await gate; return fauxAssistantMessage("coord done"); }, async () => { await gate; return fauxAssistantMessage("worker done"); }]);
  const { http, request } = await serve(fixture);
  let settled = false;
  const pending = fixture.host.prompt("live", "active fanout", undefined, caller, ["coord", "worker"], { logicalMessageId: "live-human" }).then(() => { settled = true; });
  try {
    await waitForSources(fixture, "live", 2);
    assert.equal(settled, false);
    const history = await request("/conversations/live/entries?limit=100");
    const inputs = history.data.entries.filter((entry: any) => entry.message?.role === "user");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].source_type, "human");
    assert.equal(inputs[0].source_role, "human");
    assert.equal(inputs[0].source_employee_id, undefined);
    assert.equal((await request("/messages/search?q=active%20fanout&conversation_id=live")).data.length, 1);
    const preview = (await request("/conversations/live")).data;
    assert.equal(preview.last_preview, "active fanout");
    assert.equal(preview.unread_count, 0);
    await request("/conversations/live/entries?limit=100", 404, undefined, true);
    assert.equal(settled, false, "observational reads must not wait for execution");
    release();
    await pending;
    const after = (await request("/conversations/live/entries")).data.entries.filter((entry: any) => entry.message?.role === "user");
    assert.deepEqual(after, inputs);
    await fixture.host.dispose();
    const coldHost = fixture.createHost();
    try {
      const cold = await coldHost.entries("live", caller);
      assert.deepEqual(cold.filter((entry) => entry.type === "message" && entry.message.role === "user"), fixture.host.readEntries("live", caller).filter((item) => item.entry.type === "message" && item.entry.message.role === "user").map((item) => item.entry));
      assert.equal(cold.filter((entry) => entry.type === "message" && entry.message.role === "user")[0]?.entry_ref, inputs[0].entry_ref);
    } finally { await coldHost.dispose(); }
  } finally { release(); await pending; await http.close(); await fixture.close(); }
});

test("active employee-to-employee delivery uses its real sender rather than the human or target participant", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  fixture.store.createConversation({ id: "peer", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
  await fixture.host.initializeConversationParticipants("peer", caller);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mention_employee", { employee_id: "worker", task: "peer-command" }), { stopReason: "toolUse" }),
    async () => { await gate; return fauxAssistantMessage("peer reply"); },
    fauxAssistantMessage("coordinator done"),
  ]);
  const { http, request } = await serve(fixture);
  let settled = false;
  const pending = fixture.host.prompt("peer", "ask peer", undefined, caller).then(() => { settled = true; });
  try {
    await waitForSources(fixture, "peer", 2);
    assert.equal(settled, false);
    const hit = (await request("/messages/search?q=peer-command&conversation_id=peer")).data[0];
    assert(hit);
    assert.equal(hit.role, "user");
    assert.equal(hit.source_type, "employee");
    assert.equal(hit.source_role, "participant");
    assert.equal(hit.source_id, "coord");
    assert.equal(hit.source_employee_id, "coord");
    assert.equal(hit.participant_employee_id, "worker");
    assert.equal((await request("/messages/search?q=peer-command&employee_id=worker")).data.length, 0);
    assert.equal((await request("/messages/search?q=peer-command&employee_id=coord")).data.length, 1);
    assert.equal(settled, false);
    release();
    await pending;
    const final = (await request("/messages/search?q=peer-command&conversation_id=peer")).data[0];
    assert.deepEqual(final, hit);
    await fixture.host.dispose();
    const coldHost = fixture.createHost();
    try {
      const cold = coldHost.readEntries("peer", caller).find((item) => item.entry.entry_ref === hit.entry_ref)?.entry;
      assert.equal(cold?.source_type, "employee");
      assert.equal(cold?.source_employee_id, "coord");
      assert.equal(cold?.participant_employee_id, "worker");
    } finally { await coldHost.dispose(); }
  } finally { release(); await pending; await http.close(); await fixture.close(); }
});

test("history references, cursors, unread pointers and office persisted whitespace survive restart", async () => {
  const fixture = await createFixture();
  seedGroup(fixture);
  fixture.store.updateConversation("c1", { entryEmployeeId: "coord" });
  persisted(fixture, "c1", null, [message("office", "assistant", "  saved\n\t   office    task  ")]);
  let service = await serve(fixture);
  const first = await service.request("/conversations/group/entries?limit=2");
  const all = await service.request("/conversations/group/entries");
  await service.request("/conversations/group", 200, { last_read_entry_id: first.data.entries[1].entry_ref });
  await service.http.close();
  await fixture.host.dispose();
  fixture.store.close();
  const store = new AgentSqliteStore(join(fixture.dataRoot, "agent.sqlite"));
  const host = new SessionHost({ store, cwdRoot: join(fixture.dataRoot, "workspaces"), sessionDir: join(fixture.dataRoot, "sessions"), agentDir: join(fixture.dataRoot, "pi"), modelRuntime: fixture.modelRuntime, resourceLoaderFactory: () => createControlledResourceLoader("test") });
  service = await serve({ store, host });
  try {
    assert.deepEqual((await service.request("/conversations/group/entries")).data, all.data);
    assert.equal((await service.request(`/conversations/group/entries?cursor=${first.page.next_cursor}`)).data.entries[0].entry_ref, all.data.entries[2].entry_ref);
    assert.equal((await service.request("/conversations/group")).data.unread_count, 1);
    assert.equal((await service.request("/messages/search?q=worker")).data.length, 1);
    const activity = await host.getOfficeActivities("c1");
    assert.equal(activity[0]?.last_task, "saved office task");
    assert.equal(activity[0]?.last_status, "completed");
  } finally {
    await service.http.close();
    await host.dispose();
    store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
