import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";
import { hasProjectFile, managedWorkspaceKey } from "../services/conversation-workspaces.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const owner = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] };
const other = { ...owner, callerId: "member-2", userId: "member-2" };
const key = (seed: string) => `conversation-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;

function writeTree(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

function workspace(fixture: Fixture, seed: string, files: Record<string, string> = {}): string {
  const path = join(fixture.dataRoot, "workspaces", key(seed));
  mkdirSync(path, { recursive: true });
  writeTree(path, files);
  return path;
}

function participant(fixture: Fixture, conversationId: string, employeeId: string, role: "coordinator" | "member", path: string): void {
  fixture.store.upsertConversationParticipant({ conversation_id: conversationId, employee_id: employeeId, role, session_file: "", workspace: path, pi_session_id: null, employee_version: "1" });
}

async function list(fixture: Fixture, asOther = false): Promise<{ text: string; body: any }> {
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, authenticate: (request) => (request.headers.authorization === "Bearer other" ? other : owner) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/workspaces`, { headers: { Authorization: asOther ? "Bearer other" : "Bearer owner" } });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return { text, body: JSON.parse(text) };
  } finally {
    await http.close();
  }
}

test("workspace index is owner-scoped and returns directory keys without local paths", async () => {
  const fixture = await createFixture();
  try {
    const mine = workspace(fixture, "private", { "index.html": "<h1>hi</h1>", "js/app.js": "console.log(1)" });
    fixture.store.createConversation({ id: "private", sessionFile: "", workspace: mine, title: "小游戏", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1" });
    participant(fixture, "private", "employee-1", "member", mine);
    const legacy = workspace(fixture, "legacy", { "notes.md": "# notes" });
    fixture.store.createConversation({ id: "legacy", sessionFile: "", workspace: legacy, tenantId: "tenant-1", memberId: "member-1" });
    const theirs = workspace(fixture, "theirs", { "a.md": "x" });
    fixture.store.createConversation({ id: "theirs", sessionFile: "", workspace: theirs, tenantId: "tenant-1", memberId: "member-2" });

    const { text, body } = await list(fixture);
    assert(!text.includes(fixture.root), "response must not contain local paths");
    assert.deepEqual(body.page, { next_cursor: null, has_more: false });
    // Fixture conversations without any workspace are omitted.
    assert.deepEqual(body.data.map((item: any) => item.conversation_id).sort(), ["legacy", "private"]);
    const byId = new Map(body.data.map((item: any) => [item.conversation_id, item]));
    const privateChat = byId.get("private") as any;
    assert.equal(privateChat.title, "小游戏");
    assert.equal(privateChat.entry_employee_id, "employee-1");
    // Conversation-level and participant workspace point at the same directory: listed once.
    assert.deepEqual(privateChat.workspaces, [{ employee_id: "employee-1", role: "entry", removed: false, workspace_key: key("private"), has_files: true }]);
    assert.deepEqual((byId.get("legacy") as any).workspaces, [{ employee_id: null, role: "entry", removed: false, workspace_key: key("legacy"), has_files: true }]);

    const foreign = await list(fixture, true);
    assert.deepEqual(foreign.body.data.map((item: any) => item.conversation_id), ["theirs"]);
  } finally {
    await fixture.close();
  }
});

test("group workspaces merge into one conversation and keep removed members", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.createConversation({ id: "group", kind: "group", coordinatorEmployeeId: "coord", tenantId: "tenant-1", memberId: "member-1" });
    participant(fixture, "group", "worker", "member", workspace(fixture, "group:worker", { "data.csv": "a,b" }));
    participant(fixture, "group", "coord", "coordinator", workspace(fixture, "group:coord", { "site/index.html": "<p>x</p>" }));
    participant(fixture, "group", "left", "member", workspace(fixture, "group:left"));
    fixture.store.db.prepare("UPDATE conversation_participant_session SET removed_at = ? WHERE conversation_id = ? AND employee_id = ?").run("2026-11-03T00:00:00.000Z", "group", "left");

    const { body } = await list(fixture);
    const group = body.data.find((item: any) => item.conversation_id === "group");
    assert.equal(group.kind, "group");
    assert.equal(group.coordinator_employee_id, "coord");
    assert.deepEqual(group.workspaces, [
      { employee_id: "coord", role: "coordinator", removed: false, workspace_key: key("group:coord"), has_files: true },
      { employee_id: "left", role: "member", removed: true, workspace_key: key("group:left"), has_files: false },
      { employee_id: "worker", role: "member", removed: false, workspace_key: key("group:worker"), has_files: true },
    ]);
  } finally {
    await fixture.close();
  }
});

test("workspaces outside the managed root, symlinked or misnamed are skipped", async () => {
  const fixture = await createFixture();
  const outside = mkdtempSync(join(tmpdir(), "aiteam-outside-"));
  try {
    const root = join(fixture.dataRoot, "workspaces");
    const escaped = join(outside, key("escaped"));
    mkdirSync(escaped);
    writeTree(escaped, { "index.html": "x" });
    const linked = join(root, key("linked"));
    symlinkSync(escaped, linked);
    const misnamed = join(root, "not-a-workspace");
    mkdirSync(misnamed);
    writeTree(misnamed, { "index.html": "x" });
    const traversal = join(root, "..", key("traversal"));
    mkdirSync(traversal);
    writeTree(traversal, { "index.html": "x" });

    fixture.store.createConversation({ id: "unsafe", kind: "group", coordinatorEmployeeId: "a", tenantId: "tenant-1", memberId: "member-1" });
    for (const [employeeId, path] of [["a", escaped], ["b", linked], ["c", misnamed], ["d", traversal]] as const) participant(fixture, "unsafe", employeeId, employeeId === "a" ? "coordinator" : "member", path);

    const { body } = await list(fixture);
    assert(!body.data.some((item: any) => item.conversation_id === "unsafe"));
    assert.equal(managedWorkspaceKey("", root), null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await fixture.close();
  }
});

test("has_files ignores empty, hidden, dependency and symlinked entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiteam-has-files-"));
  const outside = mkdtempSync(join(tmpdir(), "aiteam-has-files-outside-"));
  try {
    assert.equal(hasProjectFile(directory), false);
    writeTree(directory, {
      "empty.html": "",
      ".env": "TOKEN=1",
      ".git/config": "[core]",
      "node_modules/pkg/index.js": "module.exports = 1",
      "__pycache__/main.cpython-312.pyc": "x",
      "venv/bin/python": "x",
    });
    writeFileSync(join(outside, "real.txt"), "outside");
    symlinkSync(join(outside, "real.txt"), join(directory, "link.txt"));
    assert.equal(hasProjectFile(directory), false);
    writeTree(directory, { "src/main.py": "print(1)" });
    assert.equal(hasProjectFile(directory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
