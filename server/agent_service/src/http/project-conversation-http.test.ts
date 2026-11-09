import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExecutionAuthorizationRegistry } from "../execution-authorization.js";
import type { DirectoryHost, HostProject } from "../local-directory-host.js";
import { normalizeAuthorizedConfig } from "../manager-client.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { SessionHost } from "../pi/session-host.js";
import { LocalDirectoryService } from "../services/local-directories.js";
import { LocalDirectoryError } from "../storage/local-directories.js";
import { createFixture } from "../test-fixture.js";
import { createJwtAuthenticator, type JwtJwk } from "./auth.js";
import { AgentHttpServer } from "./server.js";

const CONVERSATIONS = "/api/agent/conversations";

async function setup() {
  const fixture = await createFixture();
  const identities = new ExecutionAuthorizationRegistry();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" } as JwtJwk;
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encoded({ alg: "RS256", kid: "test" })}.${encoded({ tenant_id: "tenant-1", enterprise_id: "enterprise-1", user_id: "member-1", roles: ["member"], iss: "test", aud: "agent", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const authenticate = createJwtAuthenticator({ jwks: { keys: [jwk] }, issuer: "test", audience: "agent" });

  const tickets: Array<{ owner: unknown; ticket: string }> = [];
  let ticketResult: () => HostProject = () => { throw new LocalDirectoryError("unauthorized"); };
  const native: DirectoryHost = {
    status: async () => undefined,
    challenge: async () => "challenge-1",
    consume: async () => { throw new LocalDirectoryError("unauthorized"); },
    consumeProject: async (owner, ticket) => { tickets.push({ owner, ticket }); return ticketResult(); },
    check: async () => "epoch:1",
    list: async () => ({ authority: "epoch:1", entries: [], partial: false }),
    read: async () => ({ authority: "epoch:1", content_version: "version-1", text: "" }),
  };
  const service = new LocalDirectoryService(fixture.store, native, identities);
  const workspaceRoot = join(fixture.root, "http-workspaces");
  mkdirSync(workspaceRoot, { recursive: true });
  const host = new SessionHost({
    cwdRoot: workspaceRoot, agentDir: join(fixture.root, "http-pi"), sessionDir: join(fixture.root, "http-sessions"),
    store: fixture.store, modelRuntime: fixture.modelRuntime, model: fixture.faux.getModel(), executionAuthorization: identities, localDirectoryService: service,
    resourceLoaderFactory: () => createControlledResourceLoader("test"),
  });
  const server = new AgentHttpServer({ host, store: fixture.store, authenticate, executionAuthorization: identities });
  const config = normalizeAuthorizedConfig({
    experts: [{ employee_id: "emp-1", version: "1", display_name: "员工" }],
    snapshots: [{ employee_id: "emp-1", version: "1", snapshot_version: "snap-1", display_name: "员工", tools: [] }],
  }, "tenant-1", "member-1");
  fixture.store.replaceProjections(config.experts, [], config.snapshots!, [], { tenantId: "tenant-1", memberId: "member-1" });
  await server.listen(0);
  const address = server.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = (project: unknown, extra: Record<string, unknown> = {}) => request(CONVERSATIONS, "POST", { kind: "chat", entry_employee_id: "emp-1", title: "我的改名", project, ...extra });
  const folder = (name: string) => {
    const path = join(fixture.root, name);
    mkdirSync(path, { recursive: true });
    return realpathSync(path);
  };
  /** A Fred conversation with a managed folder, as the workbench lists them. */
  const managedFolder = (id: string, name: string, memberId = "member-1") => {
    const path = join(workspaceRoot, name);
    mkdirSync(path, { recursive: true });
    const canonical = realpathSync(path);
    fixture.store.createConversation({ id, sessionFile: "", workspace: canonical, tenantId: "tenant-1", memberId, entryEmployeeId: "emp-1" });
    return canonical;
  };
  return {
    fixture, request, create, folder, managedFolder, tickets, workspaceRoot, runtimeRoots: host.runtimeRoots,
    setTicket: (result: () => HostProject) => { ticketResult = result; },
    close: async () => { await server.close(); await host.dispose(); await fixture.close(); },
  };
}

const failure = async (response: Response, status: number, code: string) => {
  const body = await response.json() as { code?: string };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.code, code);
  return body;
};

const created = async (response: Response) => {
  const body = await response.json() as { data: Record<string, any> };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
};

test("an explicit permission mode wins over the project default", async () => {
  const s = await setup();
  try {
    const path = s.folder("external-app");
    s.setTicket(() => ({ canonical_path: path, source: "codex", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "external-app", ticket: "ticket-1" }, { permission_mode: "read-only" }));
    assert.equal(data.permission_mode, "read-only");
  } finally {
    await s.close();
  }
});

test("project input needs a host ticket and a private chat", async () => {
  const s = await setup();
  try {
    s.managedFolder("fred-1", "原会话-abc");
    await failure(await s.create({ name: "x" }), 422, "invalid_project");
    await failure(await s.create({ name: "   ", ticket: "t" }), 422, "invalid_project");
    // Fred projects continue in their own conversation; a folder name or path is never accepted.
    await failure(await s.create({ name: "x", source: "fred", workspace_key: "原会话-abc" }), 422, "invalid_project");
    await failure(await s.create({ name: "x", ticket: "t", path: "/etc" }), 422, "invalid_project");
    await failure(await s.create({ name: "x", ticket: "t" }, { kind: "group" }), 422, "invalid_project");
    await failure(await s.create({ name: "x", ticket: "t" }, { entry_employee_id: null }), 422, "invalid_project");
    assert.equal(s.tickets.length, 0, "a rejected request does not use up the ticket");
  } finally {
    await s.close();
  }
});

test("an unauthorized employee is refused before the one-time ticket is used", async () => {
  const s = await setup();
  try {
    const response = await s.create({ name: "x", ticket: "t" }, { entry_employee_id: "emp-unknown" });
    assert.ok(response.status >= 400 && response.status < 500, String(response.status));
    assert.equal(s.tickets.length, 0);
  } finally {
    await s.close();
  }
});

test("an external project is opened through a host ticket and keeps the host's path", async () => {
  const s = await setup();
  try {
    const path = s.folder("external-app");
    s.setTicket(() => ({ canonical_path: path, source: "codex", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "external-app", ticket: "ticket-1" }));
    assert.equal(data.title, "我的改名");
    assert.equal(data.permission_mode, "workspace-write");
    assert.deepEqual(data.project, { source: "codex", name: "external-app", id: "0123456789abcdef", path });
    assert.equal(s.fixture.store.getConversation(data.id)?.workspace, path);
    assert.deepEqual(s.tickets, [{ owner: { tenantId: "tenant-1", memberId: "member-1" }, ticket: "ticket-1" }]);
  } finally {
    await s.close();
  }
});

test("external projects are checked after the host answers", async () => {
  const s = await setup();
  try {
    s.setTicket(() => { throw new LocalDirectoryError("unauthorized"); });
    await failure(await s.create({ name: "x", ticket: "expired" }), 409, "project_ticket_invalid");

    s.setTicket(() => ({ canonical_path: s.folder("external-app"), source: "fred", project_id: "0123456789abcdef" }));
    await failure(await s.create({ name: "x", ticket: "wrong-source" }), 422, "project_folder_not_allowed");

    s.setTicket(() => ({ canonical_path: s.folder("external-app"), source: "folder", project_id: "0123456789abcdef" }));
    await failure(await s.create({ name: "x", ticket: "picked-folder" }), 422, "project_folder_not_allowed");

    s.setTicket(() => ({ canonical_path: join(s.runtimeRoots[0]!, "inside"), source: "codex", project_id: "0123456789abcdef" }));
    await failure(await s.create({ name: "x", ticket: "runtime-data" }), 422, "project_folder_not_allowed");

    s.setTicket(() => ({ canonical_path: join(s.fixture.root, "missing"), source: "codex", project_id: "0123456789abcdef" }));
    await failure(await s.create({ name: "x", ticket: "gone" }), 409, "project_workspace_unavailable");
  } finally {
    await s.close();
  }
});

test("the workbench list leaves project conversations out and renaming keeps the project", async () => {
  const s = await setup();
  try {
    s.managedFolder("fred-1", "原会话-abc");
    const path = s.folder("external-app");
    s.setTicket(() => ({ canonical_path: path, source: "claude", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "external-app", ticket: "ticket-1" }));
    const listed = await (await s.request("/api/agent/workspaces")).json() as { data: Array<{ conversation_id: string }> };
    assert.deepEqual(listed.data.map((item) => item.conversation_id), ["fred-1"]);

    const renamed = await s.request(`${CONVERSATIONS}/${data.id}`, "PATCH", { title: "再次改名" });
    const body = await renamed.json() as { data: Record<string, any> };
    assert.equal(renamed.status, 200);
    assert.equal(body.data.title, "再次改名");
    assert.deepEqual(body.data.project, { source: "claude", name: "external-app", id: "0123456789abcdef", path });

    await failure(await s.request(`${CONVERSATIONS}/${data.id}`, "PATCH", { kind: "group" }), 422, "invalid_project");
  } finally {
    await s.close();
  }
});

test("sending into a project whose folder is gone answers 409; history stays readable", async () => {
  const s = await setup();
  try {
    const path = s.folder("external-app");
    s.setTicket(() => ({ canonical_path: path, source: "codex", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "external-app", ticket: "ticket-1" }));
    rmSync(path, { recursive: true });
    await failure(await s.request(`${CONVERSATIONS}/${data.id}/prompt`, "POST", { text: "继续" }, { "Idempotency-Key": "k-1" }), 409, "project_workspace_unavailable");
    assert.equal(existsSync(path), false, "the folder is not recreated");
    assert.equal((await s.request(`${CONVERSATIONS}/${data.id}`)).status, 200);
  } finally {
    await s.close();
  }
});

test("a moved project is followed to the folder picked in the host; history, memory scope and permission stay", async () => {
  const s = await setup();
  try {
    const before = s.folder("old-place");
    s.setTicket(() => ({ canonical_path: before, source: "workbuddy", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "app", ticket: "ticket-1" }));
    const sessionFile = s.fixture.store.getConversation(data.id)?.sessionFile;

    const after = s.folder("new-place");
    s.setTicket(() => ({ canonical_path: after, source: "folder", project_id: "fedcba9876543210" }));
    const moved = await s.request(`${CONVERSATIONS}/${data.id}/project-folder`, "PUT", { ticket: "ticket-2" });
    const body = await moved.json() as { data: Record<string, any> };
    assert.equal(moved.status, 200, JSON.stringify(body));
    // Source and name record where the project came from; the folder and its workbench id follow the move.
    assert.deepEqual(body.data.project, { source: "workbuddy", name: "app", id: "fedcba9876543210", path: after });
    assert.equal(body.data.permission_mode, "workspace-write");
    const stored = s.fixture.store.getConversation(data.id);
    assert.equal(stored?.workspace, after);
    assert.equal(stored?.sessionFile, sessionFile, "the same Pi session continues");
    assert.ok(existsSync(before), "the old folder is left alone");
  } finally {
    await s.close();
  }
});

test("only a picked-folder ticket can move a project, and only a project conversation can be moved", async () => {
  const s = await setup();
  try {
    const path = s.folder("old-place");
    s.setTicket(() => ({ canonical_path: path, source: "codex", project_id: "0123456789abcdef" }));
    const data = await created(await s.create({ name: "app", ticket: "ticket-1" }));
    const move = (id: string, body: unknown) => s.request(`${CONVERSATIONS}/${id}/project-folder`, "PUT", body);

    await failure(await move(data.id, { ticket: "t", path: "/etc" }), 422, "invalid_project");
    await failure(await move(data.id, {}), 422, "invalid_project");

    // A workbench ticket is for creating a conversation, not for moving one.
    s.setTicket(() => ({ canonical_path: s.folder("other"), source: "codex", project_id: "0123456789abcdef" }));
    await failure(await move(data.id, { ticket: "workbench" }), 422, "project_folder_not_allowed");

    s.setTicket(() => ({ canonical_path: join(s.runtimeRoots[0]!, "inside"), source: "folder", project_id: "0123456789abcdef" }));
    await failure(await move(data.id, { ticket: "runtime" }), 422, "project_folder_not_allowed");

    s.setTicket(() => ({ canonical_path: join(s.fixture.root, "missing"), source: "folder", project_id: "0123456789abcdef" }));
    await failure(await move(data.id, { ticket: "gone" }), 409, "project_workspace_unavailable");

    s.setTicket(() => { throw new LocalDirectoryError("citation_expired"); });
    await failure(await move(data.id, { ticket: "expired" }), 409, "project_ticket_invalid");
    assert.equal(s.fixture.store.getConversation(data.id)?.workspace, path, "a refused move changes nothing");

    const used = s.tickets.length;
    s.managedFolder("fred-1", "原会话-abc");
    await failure(await move("fred-1", { ticket: "t" }), 422, "invalid_project");
    await failure(await move("missing-conversation", { ticket: "t" }), 404, "conversation_not_found");
    assert.equal(s.tickets.length, used, "refused before the one-time ticket is used");
  } finally {
    await s.close();
  }
});
