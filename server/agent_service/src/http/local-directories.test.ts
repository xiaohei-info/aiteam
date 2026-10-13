import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalDirectoryError, type DirectoryBinding, type DirectoryResource } from "../storage/local-directories.js";
import { mapLocalDirectoryError, registerLocalDirectoryRoutes, type Router } from "./local-directories.js";

interface CapturedRoute {
  method: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
  schema: Record<string, unknown>;
}

function makeRouter(overrides: { read?: Router["read"] } = {}): { router: Router; routes: Map<string, CapturedRoute>; sent: Array<{ status: number; body: unknown }> } {
  const routes = new Map<string, CapturedRoute>();
  const sent: Array<{ status: number; body: unknown }> = [];
  const router: Router = {
    register(method: string, path: string, handler: Parameters<Router["register"]>[2]) {
      routes.set(`${method} ${path}`, { method, path, handler: handler as CapturedRoute["handler"], schema: {} });
    },
    read: overrides.read ?? (async () => ({})),
    send: (_response: unknown, status: number, body: unknown) => {
      sent.push({ status, body });
    },
  };
  return { router, routes, sent };
}

const resource: DirectoryResource = {
  directory_id: "dir-1",
  tenant_id: "tenant-1",
  member_id: "member-1",
  canonical_path: "/Users/example/Documents/Specs",
  display_name: "产品设计规范",
  root_identity: "1:99",
  revision: 3,
  created_at: "2026-10-12T00:00:00.000Z",
  revoked_at: null,
};

test("mapLocalDirectoryError gives conflict semantics for stale revisions", () => {
  assert.deepEqual(mapLocalDirectoryError(new LocalDirectoryError("revision_conflict")), { status: 409, code: "local_directory_revision_conflict", detail: mapLocalDirectoryError(new LocalDirectoryError("revision_conflict")).detail });
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("conflict")).status, 409);
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("unauthorized")).status, 403);
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("citation_expired")).status, 404);
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("source_changed")).status, 409);
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("authorization_unavailable")).status, 503);
  assert.equal(mapLocalDirectoryError(new LocalDirectoryError("invalid_offset")).status, 422);
});

test("route handlers project exactly the documented external response fields", async () => {
  const { router, routes, sent } = makeRouter({
    read: (async (request: unknown) => (request === "bind" ? { enabled: true, expected_revision: 0 } : { ticket: "tkt-1" })) as Router["read"],
  });
  const projections = {
    register: async () => resource,
    bind: async (): Promise<DirectoryBinding> => ({ employee_id: "emp-1", directory_id: "dir-1", enabled: true, revision: 4 }),
    list: async () => ({
      available: true,
      formats: [".txt", ".md"],
      directories: [{ directory_id: resource.directory_id, display_name: resource.display_name, path: resource.canonical_path, revision: resource.revision, status: "ready", bindings: [{ employee_id: "emp-1", directory_id: "dir-1", enabled: true, revision: 2 }] }],
    }),
  };
  registerLocalDirectoryRoutes(router, {
    list: projections.list,
    challenge: async () => "chg-1",
    register: projections.register,
    bind: projections.bind,
    revoke: () => undefined,
    verifyCitation: async () => ({}),
    capabilityState: async () => ({ revision: "x", tools: [] }),
  } as never);

  // POST /register: 201 with exactly the documented projection (no device/inode, no storage extras).
  const registerRoute = routes.get("POST /api/agent/local-directories")!;
  await registerRoute.handler(undefined, undefined, undefined, undefined);
  const registered = sent.at(-1)!;
  assert.equal(registered.status, 201);
  assert.deepEqual(Object.keys((registered.body as { data: Record<string, unknown> }).data).sort(), ["canonical_path", "created_at", "directory_id", "display_name", "revision"]);

  // PUT /bind: 200 with the full binding projection.
  await routes.get("PUT /api/agent/local-directories/:directory_id/bindings/:employee_id")!.handler("bind", undefined, undefined, { params: { directory_id: "dir-1", employee_id: "emp-1" } });
  const bound = sent.at(-1)!;
  assert.equal(bound.status, 200);
  assert.deepEqual((bound.body as { data: Record<string, unknown> }).data, { employee_id: "emp-1", directory_id: "dir-1", enabled: true, revision: 4 });

  // GET /list: binding rows are projected to the documented shape.
  await routes.get("GET /api/agent/local-directories")!.handler(undefined, undefined, undefined, undefined);
  const listed = sent.at(-1)!;
  assert.equal(listed.status, 200);
  const directory = (listed.body as { data: { directories: Array<{ bindings: Array<Record<string, unknown>> }> } }).data.directories[0]!;
  assert.deepEqual(Object.keys(directory.bindings[0]!).sort(), ["employee_id", "enabled", "revision"]);

  // POST /register rejects direct path fields before touching the service.
  const rejectingRouter = makeRouter();
  const seen: string[] = [];
  registerLocalDirectoryRoutes({ ...rejectingRouter.router, read: async () => ({ path: "/Users/example/secret" }) }, {
    register: async () => {
      seen.push("called");
      return resource;
    },
  } as never);
  await assert.rejects(
    async () => {
      await rejectingRouter.routes.get("POST /api/agent/local-directories")!.handler(undefined, undefined, undefined, undefined);
    },
    (error: unknown) => error instanceof LocalDirectoryError && error.code === "invalid_request",
  );
  assert.deepEqual(seen, []);
});
