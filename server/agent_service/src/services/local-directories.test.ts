import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionAuthorizationRegistry } from "../execution-authorization.js";
import type { AuthenticatedCaller } from "../http/auth.js";
import type { DirectoryHost, HostDirectory } from "../local-directory-host.js";
import { LocalDirectoryError, type DirectoryOwner, type DirectoryResource } from "../storage/local-directories.js";
import { AgentSqliteStore, type FrozenSnapshot } from "../storage/sqlite.js";
import { LocalDirectoryService, localDirectoryTools, type DirectoryExecution } from "./local-directories.js";

function makeCaller(tenantId = "tenant-1", userId = "member-1", exp = Math.floor(Date.now() / 1000) + 3600): AuthenticatedCaller {
  return {
    callerId: userId,
    userId,
    tenantId,
    roles: ["member"],
    accessToken: `jwt-${tenantId}-${userId}`,
    claims: { tenant_id: tenantId, user_id: userId, exp },
  };
}

class FakeDirectoryHost implements DirectoryHost {
  authority = "ep-1:1";
  files = new Map<string, { text: string; version: string }>();
  directories = new Map<string, { name: string; directory: boolean }[]>();
  partialDirs = new Set<string>();
  onRead?: (relative: string) => void | Promise<void>;
  private nextTicket = 0;
  private pending = new Map<string, { owner: DirectoryOwner; receipt: HostDirectory }>();

  async status(): Promise<void> {}
  async challenge(owner: DirectoryOwner): Promise<string> {
    const id = `ticket-${++this.nextTicket}`;
    this.pending.set(id, {
      owner,
      receipt: { canonical_path: "/private/test/kb", display_name: "产品资料库", root_identity: "1:99" },
    });
    return id;
  }
  async consume(owner: DirectoryOwner, ticket: string): Promise<HostDirectory> {
    const item = this.pending.get(ticket);
    this.pending.delete(ticket);
    if (!item || item.owner.tenantId !== owner.tenantId || item.owner.memberId !== owner.memberId) {
      throw new LocalDirectoryError("unauthorized");
    }
    return item.receipt;
  }
  async check(_resource: DirectoryResource): Promise<string> {
    return this.authority;
  }
  async list(_resource: DirectoryResource, relative: string) {
    return {
      authority: this.authority,
      entries: this.directories.get(relative) ?? [],
      partial: this.partialDirs.has(relative),
    };
  }
  async read(_resource: DirectoryResource, relative: string) {
    await this.onRead?.(relative);
    const file = this.files.get(relative);
    if (!file) throw new LocalDirectoryError("file_unavailable");
    return { authority: this.authority, text: file.text, content_version: file.version };
  }
}

test("localDirectoryTools enforces strict policy mapping and rejects empty or malformed policies", () => {
  const base: FrozenSnapshot = {
    employee_id: "emp-1",
    version: "v1",
    snapshot_version: "snap-1",
    display_name: "专家一",
  };
  assert.deepEqual(localDirectoryTools(base), []);
  assert.deepEqual(localDirectoryTools({ ...base, tool_policy: { allowed_tools: [] } }), []);
  assert.deepEqual(localDirectoryTools({ ...base, tool_policy: { allowed_tools: ["bash", 123] } }), []);
  assert.deepEqual(
    localDirectoryTools({ ...base, tool_policy: { allowed_tools: ["local_dir_search", "local_dir_read"] } }),
    ["local_dir_search", "local_dir_read"],
  );
  assert.deepEqual(
    localDirectoryTools({ ...base, tool_policy: { allowed_tools: ["knowledge_search", "knowledge_get"] } }),
    ["local_dir_search", "local_dir_read"],
  );
  assert.deepEqual(
    localDirectoryTools({
      ...base,
      tool_policy: { allowed_tools: ["knowledge_search", "knowledge_get"], denied_tools: ["local_dir_read"] },
    }),
    ["local_dir_search"],
  );
  assert.deepEqual(
    localDirectoryTools({
      ...base,
      knowledge_policy: { enabled: false },
      tool_policy: { allowed_tools: ["local_dir_search", "local_dir_read"] },
    }),
    [],
  );
  assert.deepEqual(
    localDirectoryTools({
      ...base,
      knowledge_policy: { enabled: true, local_directory: false },
      tool_policy: { allowed_tools: ["local_dir_search", "local_dir_read"] },
    }),
    [],
  );
});

test("LocalDirectoryService enforces member/employee/turn isolation, Chinese keyword ranking, code-point offsets, and mid-flight revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aifred-local-dir-svc-"));
  const store = new AgentSqliteStore(join(dir, "agent.sqlite"));
  try {
    const identities = new ExecutionAuthorizationRegistry();
    const host = new FakeDirectoryHost();
    host.directories.set("", [
      { name: "产品", directory: true },
      { name: "跳过.pdf", directory: false },
    ]);
    host.directories.set("产品", [
      { name: "发布计划.md", directory: false },
      { name: "路线图.txt", directory: false },
    ]);
    host.files.set("产品/发布计划.md", {
      text: "前缀🙂🙂🙂 产品发布计划：内部唯一代号【玄鸟-742】将在十月上线。",
      version: "ver-1",
    });
    host.files.set("产品/路线图.txt", {
      text: "季度工作安排：包含产品与发布计划讨论，无标题加权。",
      version: "ver-1",
    });

    const callerA = makeCaller("tenant-1", "member-1");
    const callerB = makeCaller("tenant-1", "member-2");
    const identityA = identities.register(callerA)!;
    identities.register(callerB);

    store.replaceProjections(
      [
        {
          employee_id: "emp-1",
          tenant_id: "tenant-1",
          member_id: "member-1",
          version: "v1",
          handle: "emp1",
          display_name: "产品顾问",
          revoked: false,
          synced_at: "2026-10-12T00:00:00.000Z",
        },
        {
          employee_id: "emp-2",
          tenant_id: "tenant-1",
          member_id: "member-1",
          version: "v1",
          handle: "emp2",
          display_name: "助理顾问",
          revoked: false,
          synced_at: "2026-10-12T00:00:00.000Z",
        },
      ],
      [],
      [
        {
          employee_id: "emp-1",
          tenant_id: "tenant-1",
          member_id: "member-1",
          version: "v1",
          snapshot_version: "snap-1",
          display_name: "产品顾问",
          tool_policy: { allowed_tools: ["local_dir_search", "local_dir_read"] },
        },
        {
          employee_id: "emp-2",
          tenant_id: "tenant-1",
          member_id: "member-1",
          version: "v1",
          snapshot_version: "snap-2",
          display_name: "助理顾问",
          tool_policy: { allowed_tools: ["local_dir_search", "local_dir_read"] },
        },
      ],
      [],
      { tenantId: "tenant-1", memberId: "member-1" },
    );

    store.createConversation({
      id: "conv-1",
      tenantId: "tenant-1",
      memberId: "member-1",
      entryEmployeeId: "emp-1",
      permissionMode: "read-only",
    });

    const service = new LocalDirectoryService(store, host, identities, () => true);
    const challenge = await service.challenge(callerA);
    const registered = await service.register(callerA, challenge);
    await service.bind(callerA, registered.directory_id, "emp-1", true, 0);

    const exec: DirectoryExecution = {
      caller: callerA,
      employeeId: "emp-1",
      conversationId: "conv-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      snapshotVersion: "snap-1",
      generation: identityA.generation,
      permissionMode: "read-only",
    };

    // Full-access mode and background tasks are denied.
    await assert.rejects(() => service.search({ ...exec, permissionMode: "full-access" }, "发布计划"), /unauthorized/);
    await assert.rejects(() => service.search({ ...exec, background: true }, "发布计划"), /unauthorized/);

    const searchResult = await service.search(exec, "产品 发布计划", 10);
    assert.equal(searchResult.partial, false);
    assert.equal(searchResult.coverage.files_examined, 2);
    assert.equal(searchResult.coverage.files_skipped, 1);
    assert.equal(searchResult.items.length, 2);
    // Filename match ranks ahead of body-only match.
    assert.equal(searchResult.items[0]!.title, "发布计划.md");
    assert.ok(searchResult.items[0]!.snippet.includes("玄鸟-742"));

    const citationId = searchResult.items[0]!.citation_id;
    // Code-point offset 2 skips "前缀", landing on the first emoji rather than splitting a surrogate pair.
    const readSlice = await service.read(exec, citationId, 2);
    assert.ok(readSlice.text.startsWith("🙂🙂🙂 产品发布计划"));

    const verified = await service.verifyCitation(callerA, citationId, 0);
    assert.equal(verified.title, "发布计划.md");
    assert.equal(verified.directory_display_name, "产品资料库");

    // Cross-member, cross-employee, and cross-turn dereference must fail.
    await assert.rejects(() => service.verifyCitation(callerB, citationId), /unauthorized/);
    await assert.rejects(() => service.read({ ...exec, employeeId: "emp-2", snapshotVersion: "snap-2" }, citationId), /unauthorized/);
    await assert.rejects(() => service.read({ ...exec, turnId: "turn-2" }, citationId), /unauthorized/);

    // File version change rejects stale citation reads.
    host.files.set("产品/发布计划.md", { text: "已修改内容", version: "ver-2" });
    await assert.rejects(() => service.read(exec, citationId, 0), /source_changed/);
    await assert.rejects(() => service.verifyCitation(callerA, citationId, 0), /source_changed/);

    // Mid-flight revocation cancels an in-progress search and invalidates citations.
    host.onRead = async () => {
      service.revoke(callerA, registered.directory_id);
    };
    await assert.rejects(() => service.search(exec, "玄鸟", 5), /cancelled|unauthorized/);
    await assert.rejects(() => service.verifyCitation(callerA, citationId, 0), /citation_expired|unauthorized/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
