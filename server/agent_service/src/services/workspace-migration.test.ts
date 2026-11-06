import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hindsightStateDir } from "../pi/resources.js";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { conversationFolderBase } from "../workspace-layout.js";
import { migrateWorkspaceLayout } from "./workspace-migration.js";

const legacy = (seed: string) => `conversation-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
const short = (id: string, length = 6) => createHash("sha256").update(id).digest("hex").slice(0, length);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-workspace-migration-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  const workspaces = join(root, "workspaces");
  const agentDir = join(root, "pi");
  mkdirSync(workspaces);
  const folder = (name: string, files: Record<string, string> = {}) => {
    const path = join(workspaces, name);
    mkdirSync(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), text);
    }
    return path;
  };
  const member = (conversationId: string, employeeId: string, role: "coordinator" | "member", workspace: string) =>
    store.upsertConversationParticipant({ conversation_id: conversationId, employee_id: employeeId, role, session_file: "", workspace, pi_session_id: null, employee_version: "1" });
  const workspacesOf = (conversationId: string) => store.listConversationParticipants(conversationId, { includeRemoved: true }).map((item) => [item.employee_id, item.workspace]);
  const migrate = () => migrateWorkspaceLayout(store, workspaces, agentDir);
  const now = new Date().toISOString();
  store.replaceProjections([
    { employee_id: "lead", tenant_id: "t", member_id: "m", version: "1", handle: "lead", display_name: "产品经理", revoked: false, synced_at: now },
    { employee_id: "dev-a", tenant_id: "t", member_id: "m", version: "1", handle: "dev-a", display_name: "工程师", revoked: false, synced_at: now },
    { employee_id: "dev-b", tenant_id: "t", member_id: "m", version: "1", handle: "dev-b", display_name: "工程师", revoked: false, synced_at: now },
  ], [], []);
  return { root, store, workspaces, agentDir, folder, member, workspacesOf, migrate, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("legacy folders move to conversation-named folders with their files, memory state and stored paths", () => {
  const f = fixture();
  try {
    const titled = f.folder(legacy("titled"), { "vite-demo/package.json": "{}", "report.md": "报告" });
    f.store.createConversation({ id: "titled", title: "热门AI项目总结", entryEmployeeId: "lead", sessionFile: "", workspace: titled, tenantId: "t", memberId: "m" });
    f.member("titled", "lead", "member", titled);
    mkdirSync(join(hindsightStateDir(f.agentDir, titled), "config"), { recursive: true });

    const untitled = f.folder(legacy("untitled"), { "a.md": "a" });
    f.store.createConversation({ id: "untitled", entryEmployeeId: "lead", sessionFile: "", workspace: untitled, tenantId: "t", memberId: "m" });
    f.member("untitled", "lead", "member", untitled);

    f.store.createConversation({ id: "group", kind: "group", title: "前端招聘组", coordinatorEmployeeId: "lead", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
    const lead = f.folder(legacy("group:lead"), { "plan.md": "plan" });
    const devA = f.folder(legacy("group:dev-a"), { "index.html": "a" });
    const devB = f.folder(legacy("group:dev-b"), { "index.html": "b" });
    const gone = f.folder(legacy("group:gone"), { "old.md": "old" });
    f.member("group", "lead", "coordinator", lead);
    f.member("group", "dev-a", "member", devA);
    f.member("group", "dev-b", "member", devB);
    f.member("group", "gone", "member", gone);

    assert.deepEqual(f.migrate(), { moved: 6, pending: 0 }, "a private chat stores one folder in two tables");

    const titledDir = join(f.workspaces, `热门AI项目总结-${short("titled")}`);
    assert.equal(readFileSync(join(titledDir, "report.md"), "utf8"), "报告");
    assert.ok(existsSync(join(titledDir, "vite-demo", "package.json")));
    assert.equal(f.store.getConversation("titled")?.workspace, titledDir);
    assert.deepEqual(f.workspacesOf("titled"), [["lead", titledDir]]);
    assert.ok(existsSync(join(hindsightStateDir(f.agentDir, titledDir), "config")), "memory state follows the folder");
    assert.ok(!existsSync(hindsightStateDir(f.agentDir, titled)));

    const untitledBase = conversationFolderBase({ employeeName: "产品经理", createdAt: f.store.getConversation("untitled")?.createdAt });
    assert.match(untitledBase, /^产品经理-\d{8}$/u);
    assert.equal(f.store.getConversation("untitled")?.workspace, join(f.workspaces, `${untitledBase}-${short("untitled")}`));

    const groupDir = join(f.workspaces, `前端招聘组-${short("group")}`);
    assert.deepEqual(f.workspacesOf("group"), [
      ["lead", join(groupDir, "产品经理")],
      ["dev-a", join(groupDir, "工程师")],
      ["dev-b", join(groupDir, `工程师-${short("dev-b")}`)],
      ["gone", join(groupDir, "gone")],
    ]);
    assert.equal(readFileSync(join(groupDir, `工程师-${short("dev-b")}`, "index.html"), "utf8"), "b");
    for (const path of [titled, untitled, lead, devA, devB, gone]) assert.ok(!existsSync(path), path);

    assert.deepEqual(f.migrate(), { moved: 0, pending: 0 }, "a second start has nothing to do");
    assert.deepEqual(f.store.listWorkspaceMoves(), []);
  } finally {
    f.close();
  }
});

test("a start interrupted after the rename or before it finishes the recorded move", () => {
  const f = fixture();
  try {
    const renamed = f.folder(legacy("renamed"), { "a.md": "a" });
    const pending = f.folder(legacy("pending"), { "b.md": "b" });
    f.store.createConversation({ id: "renamed", title: "已改名", sessionFile: "", workspace: renamed, tenantId: "t", memberId: "m" });
    f.store.createConversation({ id: "pending", title: "未改名", sessionFile: "", workspace: pending, tenantId: "t", memberId: "m" });
    const renamedTarget = join(f.workspaces, "已改名-x");
    const pendingTarget = join(f.workspaces, "未改名-y");
    f.store.planWorkspaceMoves([{ oldPath: renamed, newPath: renamedTarget }, { oldPath: pending, newPath: pendingTarget }]);
    renameSync(renamed, renamedTarget);
    // The title changed before the next start; the recorded target still wins.
    f.store.updateConversation("pending", { title: "新标题" });

    assert.deepEqual(f.migrate(), { moved: 2, pending: 0 });
    assert.equal(f.store.getConversation("renamed")?.workspace, renamedTarget);
    assert.equal(f.store.getConversation("pending")?.workspace, pendingTarget);
    assert.equal(readFileSync(join(pendingTarget, "b.md"), "utf8"), "b");
    assert.deepEqual(f.store.listWorkspaceMoves(), []);
  } finally {
    f.close();
  }
});

test("a taken target, a link in place of the folder and folders already in the new layout are left alone", () => {
  const f = fixture();
  try {
    const blocked = f.folder(legacy("blocked"), { "keep.md": "keep" });
    f.store.createConversation({ id: "blocked", title: "被占用", sessionFile: "", workspace: blocked, tenantId: "t", memberId: "m" });
    // Empty, so only the check, not the file system, keeps the rename from replacing it.
    const taken = f.folder("被占用-z");
    f.store.planWorkspaceMoves([{ oldPath: blocked, newPath: taken }]);

    const outside = mkdtempSync(join(tmpdir(), "aiteam-workspace-outside-"));
    const linked = join(f.workspaces, legacy("linked"));
    symlinkSync(outside, linked);
    f.store.createConversation({ id: "linked", title: "链接", sessionFile: "", workspace: linked, tenantId: "t", memberId: "m" });

    const current = f.folder("已是新结构-abcdef", { "c.md": "c" });
    f.store.createConversation({ id: "current", title: "已是新结构", sessionFile: "", workspace: current, tenantId: "t", memberId: "m" });

    try {
      const result = f.migrate();
      assert.deepEqual(result, { moved: 0, pending: 2 });
      assert.equal(f.store.getConversation("blocked")?.workspace, blocked);
      assert.equal(readFileSync(join(blocked, "keep.md"), "utf8"), "keep");
      assert.equal(f.store.getConversation("linked")?.workspace, linked);
      assert.ok(existsSync(linked));
      assert.equal(f.store.getConversation("current")?.workspace, current);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    f.close();
  }
});

test("a new member of a group whose folders were moved lands in the same conversation folder", () => {
  const f = fixture();
  try {
    f.store.createConversation({ id: "group", kind: "group", title: "招聘组", coordinatorEmployeeId: "lead", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
    const groupDir = join(f.workspaces, "招聘组-123456");
    f.member("group", "lead", "coordinator", f.folder("招聘组-123456/产品经理"));
    f.member("group", "dev-a", "member", f.folder(legacy("group:dev-a"), { "x.md": "x" }));

    assert.deepEqual(f.migrate(), { moved: 1, pending: 0 });
    assert.deepEqual(f.workspacesOf("group"), [["lead", join(groupDir, "产品经理")], ["dev-a", join(groupDir, "工程师")]]);
  } finally {
    f.close();
  }
});
