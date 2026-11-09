import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { HINDSIGHT_CLIENT_PROTOCOL, ManagerValidationError, type HindsightRuntimeConfig, type ManagerClient } from "../manager-client.js";
import { createFixture } from "../test-fixture.js";
import { assertProjectWorkspace, isAllowedProjectFolder, projectMemoryScope, ProjectWorkspaceUnavailableError } from "./project-conversation.js";
import { hindsightStateDir } from "./resources.js";
import { conversationFoldersHint } from "./session-host.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1" };
const owner = { tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "employee-1" };

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function seedEmployee(fixture: Fixture, memoryEnabled = false): void {
  const now = new Date().toISOString();
  fixture.store.replaceProjections([
    { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: now },
  ], [], [{
    employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper",
    ...(memoryEnabled ? { memory_policy: { enabled: true, allowed_operations: ["recall", "retain"] } } : {}),
    tool_policy: { allowed_tools: [] },
  }]);
}

function projectFolder(fixture: Fixture, name = "user-project"): string {
  const folder = join(fixture.root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "keep.txt"), "user file");
  return realpathSync(folder);
}

function createProject(fixture: Fixture, id: string, workspace: string): void {
  fixture.store.createConversation({ id, sessionFile: "", workspace, ...owner, projectSource: "codex", projectName: "项目", projectId: "0123456789abcdef" });
}

function memoryConfig(employeeId: string, memoryScope?: string): HindsightRuntimeConfig {
  return {
    base_url: `https://manager.test/api/manager/hindsight/employees/${employeeId}${memoryScope ? `/scopes/${memoryScope}` : ""}`,
    bank_id: `aiteam-${"a".repeat(32)}`,
    token: "jwt",
    lease_id: "manager-jwt-context",
    version: 1,
    policy_revision: 1,
    allowed_operations: ["recall", "retain"],
    client_protocol: HINDSIGHT_CLIENT_PROTOCOL,
    explicit_auto_retain: false,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
}

function managerStub(overrides: Partial<ManagerClient>): ManagerClient {
  return { pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }), getOrgTree: async () => ({}), ...overrides };
}

test("projectMemoryScope is opaque, stable and separate per conversation", () => {
  const scope = projectMemoryScope("conversation-a");
  assert.match(scope, /^[0-9a-f]{32}$/);
  assert.equal(projectMemoryScope("conversation-a"), scope);
  assert.notEqual(projectMemoryScope("conversation-b"), scope);
  assert.equal(scope.includes("conversation"), false);
});

test("assertProjectWorkspace accepts only a real folder at the stored canonical path", async () => {
  const fixture = await createFixture();
  try {
    const folder = projectFolder(fixture);
    assert.doesNotThrow(() => assertProjectWorkspace(folder));
    assert.throws(() => assertProjectWorkspace(join(folder, "missing")), ProjectWorkspaceUnavailableError);
    assert.throws(() => assertProjectWorkspace(join(folder, "keep.txt")), ProjectWorkspaceUnavailableError);
    assert.throws(() => assertProjectWorkspace("relative/path"), ProjectWorkspaceUnavailableError);
    const link = join(fixture.root, "linked-project");
    symlinkSync(folder, link);
    assert.throws(() => assertProjectWorkspace(link), ProjectWorkspaceUnavailableError);
  } finally {
    await fixture.close();
  }
});

test("isAllowedProjectFolder rejects root, home, sensitive trees and Agent data", () => {
  const roots = ["/data/agent/workspaces", "/data/agent/pi"];
  assert.equal(isAllowedProjectFolder("/work/app", roots, "/home/u", "darwin"), true);
  assert.equal(isAllowedProjectFolder("/data/agent-other", roots, "/home/u", "darwin"), true, "a sibling sharing a name prefix is unrelated");
  assert.equal(isAllowedProjectFolder("/home/u/Documents/app", roots, "/home/u", "darwin"), true);
  for (const path of ["/home/u/.ssh", "/home/u/.ssh/id_ed25519", "/home/u/Library", "/home/u/Library/Keychains", "/home/u/.aws", "/home/u/.gnupg", "/home/u/.kube", "/home/u/.docker"]) {
    assert.equal(isAllowedProjectFolder(path, roots, "/home/u", "darwin"), false, path);
  }
  assert.equal(isAllowedProjectFolder("/", roots, "/home/u", "darwin"), false);
  assert.equal(isAllowedProjectFolder("/home/u", roots, "/home/u", "darwin"), false);
  assert.equal(isAllowedProjectFolder("/home", roots, "/home/u", "darwin"), false, "an ancestor containing the home sensitive trees");
  assert.equal(isAllowedProjectFolder("/data/agent/workspaces/x", roots, "/home/u", "darwin"), false, "inside runtime data");
  assert.equal(isAllowedProjectFolder("/data/agent", roots, "/home/u", "darwin"), false, "contains runtime data");

  const windowsHome = "C:/Users/Alice";
  assert.equal(isAllowedProjectFolder("C:/Users/Alice/Projects/app", [], windowsHome, "win32"), true);
  for (const path of [
    "C:/Users/Alice/.ssh",
    "C:/Users/Alice/AppData/Local",
    "C:/Users/Alice/APPDAT~1/Local",
    "C:/Users/Alice/.aws",
    "C:/Users/Alice/.gnupg",
    "C:/Users/Alice/.kube",
    "C:/Users/Alice/.docker",
    "C:/Windows/System32",
    "C:/Program Files/AIFred",
    "C:/Program Files (x86)/AIFred",
    "C:/",
  ]) {
    assert.equal(isAllowedProjectFolder(path, [], windowsHome, "win32"), false, path);
  }
  assert.equal(isAllowedProjectFolder("//server/share/Projects/app", [], windowsHome, "win32"), true);
  assert.equal(isAllowedProjectFolder("//server/share/.ssh", [], windowsHome, "win32"), false);
});

test("project columns and the borrowed folder cannot be changed after creation", async () => {
  const fixture = await createFixture();
  try {
    const folder = projectFolder(fixture);
    createProject(fixture, "project-a", folder);
    fixture.store.createConversation({ id: "project-a", sessionFile: "", workspace: join(fixture.root, "other"), ...owner, projectSource: "claude", projectName: "改名", projectId: "fedcba9876543210" });
    fixture.store.updateConversation("project-a", { title: "新名字" });
    assert.equal(fixture.store.getConversation("project-a")?.workspace, folder);
    const metadata = fixture.store.getConversationMetadata("project-a");
    // The folder is shown to the local UI so the user can see and change it; only a host ticket can change it.
    assert.deepEqual(metadata?.project, { source: "codex", name: "项目", id: "0123456789abcdef", path: folder });
    assert.equal(metadata?.title, "新名字");
  } finally {
    await fixture.close();
  }
});

test("project conversations stay out of workspace listings and migration", async () => {
  const fixture = await createFixture();
  try {
    const folder = projectFolder(fixture);
    createProject(fixture, "project-a", folder);
    assert.equal(fixture.store.listOwnedConversationWorkspaces("tenant-1", "member-1").some((item) => item.id === "project-a"), false);
    assert.equal(fixture.store.listAllConversationWorkspaces().some((item) => item.id === "project-a"), false);
  } finally {
    await fixture.close();
  }
});

test("deleting a project conversation keeps the project and other conversations on it", async () => {
  const fixture = await createFixture();
  try {
    seedEmployee(fixture);
    const folder = projectFolder(fixture);
    createProject(fixture, "project-a", folder);
    createProject(fixture, "project-b", folder);
    fixture.faux.setResponses([fauxAssistantMessage("first")]);
    await fixture.host.prompt("project-a", "hello", undefined, caller);
    const sessionFile = fixture.store.getConversation("project-a")?.sessionFile;
    assert.ok(sessionFile && existsSync(sessionFile));

    assert.equal(await fixture.host.delete("project-a", "tenant-1", "member-1"), true);
    assert.equal(existsSync(join(folder, "keep.txt")), true, "the user's project is never deleted");
    assert.equal(existsSync(sessionFile), false, "the conversation's own session is removed");
    assert.ok(fixture.store.getConversation("project-b"), "other conversations are untouched");
  } finally {
    await fixture.close();
  }
});

test("a project conversation runs in the project without touching it and fails once it is gone", async () => {
  const fixture = await createFixture();
  try {
    seedEmployee(fixture);
    const folder = projectFolder(fixture);
    createProject(fixture, "project-a", folder);
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    await fixture.host.prompt("project-a", "hello", undefined, caller);
    assert.equal(existsSync(join(folder, ".pi")), false, "no runtime state is written into the project");
    assert.equal(fixture.store.getConversation("project-a")?.workspace, folder);

    await fixture.host.dispose();
    rmSync(folder, { recursive: true });
    const restarted = fixture.createHost();
    try {
      await assert.rejects(restarted.prompt("project-a", "again", undefined, caller), ProjectWorkspaceUnavailableError);
      assert.equal(existsSync(folder), false, "a missing project folder is not recreated");
    } finally {
      await restarted.dispose();
    }
  } finally {
    await fixture.close();
  }
});

test("each project conversation asks Manager for its own memory; normal chats keep the shared one", async () => {
  const fixture = await createFixture();
  const scopes: Array<string | undefined> = [];
  const manager = managerStub({
    pullMemoryRuntimeConfig: async (_caller, employeeId, memoryScope) => {
      scopes.push(memoryScope);
      return memoryConfig(employeeId, memoryScope);
    },
  });
  const host = fixture.createHost(undefined, manager);
  try {
    seedEmployee(fixture, true);
    const folder = projectFolder(fixture);
    createProject(fixture, "project-a", folder);
    createProject(fixture, "project-b", folder);
    fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
    fixture.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
    await host.prompt("project-a", "hi", undefined, caller);
    await host.prompt("project-b", "hi", undefined, caller);
    await host.prompt("conversation-1", "hi", undefined, caller);
    assert.deepEqual(scopes, [projectMemoryScope("project-a"), projectMemoryScope("project-b"), undefined]);
    assert.notEqual(
      hindsightStateDir(fixture.dataRoot, folder, projectMemoryScope("project-a")),
      hindsightStateDir(fixture.dataRoot, folder, projectMemoryScope("project-b")),
      "two conversations on one folder keep separate plugin state",
    );
  } finally {
    await host.dispose();
    await fixture.close();
  }
});

test("a Manager without scope support leaves the session without memory, never on the shared bank", async () => {
  const fixture = await createFixture();
  const legacy: string[] = [];
  const manager = managerStub({
    pullMemoryRuntimeConfig: async () => { throw new ManagerValidationError("extra field", "validation_error"); },
    pullHindsightRuntimeConfig: async (_caller, employeeId) => { legacy.push(employeeId); return memoryConfig(employeeId); },
  });
  const host = fixture.createHost(undefined, manager);
  try {
    seedEmployee(fixture, true);
    createProject(fixture, "project-a", projectFolder(fixture));
    fixture.faux.setResponses([fauxAssistantMessage("still works")]);
    assert.ok(await host.prompt("project-a", "hi", undefined, caller));
    assert.deepEqual(legacy, []);
  } finally {
    await host.dispose();
    await fixture.close();
  }
});

test("a scoped session has no legacy lease fallback when the protocol call is absent", async () => {
  const fixture = await createFixture();
  const legacy: string[] = [];
  const host = fixture.createHost(undefined, managerStub({
    pullHindsightRuntimeConfig: async (_caller, employeeId) => { legacy.push(employeeId); return memoryConfig(employeeId); },
  }));
  try {
    seedEmployee(fixture, true);
    createProject(fixture, "project-a", projectFolder(fixture));
    fixture.faux.setResponses([fauxAssistantMessage("still works")]);
    assert.ok(await host.prompt("project-a", "hi", undefined, caller));
    assert.deepEqual(legacy, []);
  } finally {
    await host.dispose();
    await fixture.close();
  }
});

test("a context reset saves to the conversation's own memory and does not send its id", async () => {
  const fixture = await createFixture();
  const retained: Array<{ metadata?: Record<string, unknown>; memoryScope?: string }> = [];
  const host = fixture.createHost(undefined, managerStub({
    memoryRetain: async (_caller, _employeeId, _content, metadata, _key, memoryScope) => {
      retained.push({ metadata, memoryScope });
      return { operationId: "op-1" };
    },
  }));
  try {
    seedEmployee(fixture, true);
    createProject(fixture, "project-a", projectFolder(fixture));
    fixture.faux.setResponses([fauxAssistantMessage("记住了")]);
    await host.prompt("project-a", "请记住", undefined, caller);
    const result = await host.resetContext("project-a", caller);
    assert.equal(result.memory_saved, true);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.memoryScope, projectMemoryScope("project-a"));
    assert.equal(JSON.stringify(retained[0]!.metadata).includes("project-a"), false);
    assert.equal(retained[0]!.metadata?.conversation_id, undefined);
  } finally {
    await host.dispose();
    await fixture.close();
  }
});

test("conversationFoldersHint lists added folders with the access the permission allows", () => {
  assert.equal(conversationFoldersHint([], "workspace-write"), "");
  const writable = conversationFoldersHint(["/Users/a/docs", "/Users/a/specs"], "workspace-write");
  assert.ok(writable.includes("- /Users/a/docs\n- /Users/a/specs"));
  assert.ok(writable.includes("read and modify"));
  assert.ok(conversationFoldersHint(["/Users/a/docs"], "read-only").includes("do not modify"));
});

