import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore } from "../storage/sqlite.js";
import { backfillArtifactPaths } from "./artifact-paths.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-artifact-paths-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  const workspaces = join(root, "workspaces");
  mkdirSync(workspaces);
  const write = (workspace: string, path: string, text: string) => {
    const target = join(workspaces, workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const artifact = (conversationId: string, filename: string, text: string) => store.createLocalFile({ conversationId, tenantId: "t", memberId: "m", kind: "artifact", filename, mimeType: "text/markdown", data: Buffer.from(text) });
  const paths = (conversationId: string) => Object.fromEntries(store.listOwnedLocalFiles(conversationId, "t", "m", "artifact").map((item) => [item.id, item.path]));
  return { root, store, workspaces, write, artifact, paths, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("backfill finds each old artifact's folder by content; anything unmatched goes to the top level", () => {
  const f = fixture();
  try {
    f.store.createConversation({ id: "chat", sessionFile: "", workspace: join(f.workspaces, "one"), tenantId: "t", memberId: "m" });
    f.write("one", "game/README.md", "game readme");
    f.write("one", "tool/README.md", "tool readme");
    f.write("one", "a/same.md", "same");
    f.write("one", "b/same.md", "same");
    f.write("one", "edited.md", "edited afterwards");
    const game = f.artifact("chat", "README.md", "game readme");
    const tool = f.artifact("chat", "README.md", "tool readme");
    const first = f.artifact("chat", "same.md", "same");
    const second = f.artifact("chat", "same.md", "same");
    const stale = f.artifact("chat", "edited.md", "original");
    const gone = f.artifact("chat", "deleted.md", "no longer there");

    assert.equal(backfillArtifactPaths(f.store, f.workspaces), 6);
    assert.deepEqual(f.paths("chat"), {
      [game.id]: "game/README.md",
      [tool.id]: "tool/README.md",
      [first.id]: "a/same.md",
      [second.id]: "b/same.md",
      [stale.id]: "edited.md",
      [gone.id]: "deleted.md",
    });
    assert.equal(f.store.readOwnedLocalFile(game.id, "chat", "t", "m")?.data.toString(), "game readme");
    assert.equal(backfillArtifactPaths(f.store, f.workspaces), 0, "a second start has nothing to do");
  } finally {
    f.close();
  }
});

test("backfill puts group chat artifacts under the employee's name, including removed members", () => {
  const f = fixture();
  try {
    f.store.createConversation({ id: "group", kind: "group", coordinatorEmployeeId: "lead", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
    f.store.replaceProjections([
      { employee_id: "lead", tenant_id: "t", member_id: "m", version: "1", handle: "lead", display_name: "产品经理", revoked: false, synced_at: new Date().toISOString() },
    ], [], []);
    for (const [employee, workspace] of [["lead", "lead-dir"], ["gone", "gone-dir"]] as const) {
      f.store.upsertConversationParticipant({ conversation_id: "group", employee_id: employee, role: employee === "lead" ? "coordinator" : "member", session_file: "", workspace: join(f.workspaces, workspace), pi_session_id: null, employee_version: "1" });
    }
    f.write("lead-dir", "docs/plan.md", "lead plan");
    f.write("gone-dir", "plan.md", "gone plan");
    const lead = f.artifact("group", "plan.md", "lead plan");
    const gone = f.artifact("group", "plan.md", "gone plan");

    backfillArtifactPaths(f.store, f.workspaces);
    assert.deepEqual(f.paths("group"), { [lead.id]: "产品经理/docs/plan.md", [gone.id]: "gone/plan.md" });
  } finally {
    f.close();
  }
});

test("backfill never reads a workspace recorded outside the managed root", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "aiteam-artifact-paths-outside-"));
  try {
    mkdirSync(join(outside, "secret"));
    writeFileSync(join(outside, "secret", "note.md"), "note");
    f.store.createConversation({ id: "chat", sessionFile: "", workspace: outside, tenantId: "t", memberId: "m" });
    const note = f.artifact("chat", "note.md", "note");
    backfillArtifactPaths(f.store, f.workspaces);
    assert.deepEqual(f.paths("chat"), { [note.id]: "note.md" });
  } finally {
    rmSync(outside, { recursive: true, force: true });
    f.close();
  }
});

test("uploaded attachments stay out of the backfill", () => {
  const f = fixture();
  try {
    f.store.createConversation({ id: "chat", sessionFile: "", workspace: "", tenantId: "t", memberId: "m" });
    const upload = f.store.createLocalFile({ conversationId: "chat", tenantId: "t", memberId: "m", kind: "attachment", filename: "a.md", mimeType: "text/markdown", data: Buffer.from("a") });
    assert.equal(backfillArtifactPaths(f.store, f.workspaces), 0);
    assert.equal(f.store.getOwnedLocalFile(upload.id, "chat", "t", "m")?.path, null);
  } finally {
    f.close();
  }
});
