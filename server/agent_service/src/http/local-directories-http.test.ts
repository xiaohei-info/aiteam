import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";
import { ExecutionAuthorizationRegistry } from "../execution-authorization.js";
import type { DirectoryHost } from "../local-directory-host.js";
import { normalizeAuthorizedConfig } from "../manager-client.js";
import { SessionHost } from "../pi/session-host.js";
import { createControlledResourceLoader } from "../pi/resources.js";
import { LocalDirectoryService } from "../services/local-directories.js";
import { createFixture } from "../test-fixture.js";
import { createJwtAuthenticator, type JwtJwk } from "./auth.js";
import { AgentHttpServer } from "./server.js";

async function setup() {
  const fixture = await createFixture();
  const identities = new ExecutionAuthorizationRegistry();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" } as JwtJwk;
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encoded({ alg: "RS256", kid: "test" })}.${encoded({ tenant_id: "tenant-1", enterprise_id: "enterprise-1", user_id: "member-1", roles: ["member"], iss: "test", aud: "agent", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const authenticate = createJwtAuthenticator({ jwks: { keys: [jwk] }, issuer: "test", audience: "agent" });
  let onRead: (() => Promise<void>) | undefined;
  const native: DirectoryHost = {
    status: async () => undefined,
    challenge: async () => "challenge-1",
    consume: async () => ({ canonical_path: "/private/test/kb", display_name: "资料", root_identity: "1:99" }),
    check: async () => "epoch:1",
    list: async () => ({ authority: "epoch:1", entries: [{ name: "spec.txt", directory: false }], partial: false }),
    read: async () => { await onRead?.(); return { authority: "epoch:1", content_version: "version-1", text: "sensitive-http-citation-evidence" }; },
  };
  const service = new LocalDirectoryService(fixture.store, native, identities);
  const host = new SessionHost({
    cwdRoot: join(fixture.root, "http-workspaces"), agentDir: join(fixture.root, "http-pi"), sessionDir: join(fixture.root, "http-sessions"),
    store: fixture.store, modelRuntime: fixture.modelRuntime, model: fixture.faux.getModel(), executionAuthorization: identities, localDirectoryService: service,
    resourceLoaderFactory: () => createControlledResourceLoader("test"),
  });
  const server = new AgentHttpServer({ host, store: fixture.store, authenticate, executionAuthorization: identities });
  const seed = (allow: boolean) => {
    const config = normalizeAuthorizedConfig({
      experts: [{ employee_id: "emp-1", version: "1", display_name: "员工" }],
      snapshots: [{ employee_id: "emp-1", version: "1", snapshot_version: "snap-1", display_name: "员工", tools: ["knowledge_search", "knowledge_get"], knowledge_policy: { state: allow ? "allow" : "deny", allowed_operations: allow ? ["knowledge_search", "knowledge_get"] : [], revision: allow ? "1" : "2" } }],
    }, "tenant-1", "member-1");
    fixture.store.replaceProjections(config.experts, [], config.snapshots!, [], { tenantId: "tenant-1", memberId: "member-1" });
  };
  seed(true);
  fixture.store.createConversation({ id: "directory-http", tenantId: "tenant-1", memberId: "member-1", entryEmployeeId: "emp-1", permissionMode: "read-only" });
  await server.listen(0);
  const address = server.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const document = await (await fetch(`${base}/openapi.json`)).json() as { paths: Record<string, Record<string, any>> };
  const data = async (response: Response, path: string, method: string, status: number) => {
    const body = await response.json() as { data: any };
    assert.equal(response.status, status, JSON.stringify(body));
    const schema = document.paths[path]![method]!.responses[String(status)].content["application/json"].schema;
    assert.ok(Check(schema, body), `actual HTTP response violates ${method} ${path}: ${JSON.stringify(body)}`);
    return body.data;
  };
  const prefix = "/api/agent/local-directories";
  return {
    ...fixture, host, service, request, data, prefix, seed,
    blockRead() {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      onRead = async () => { enter(); await released; };
      return { entered, release: () => { onRead = undefined; release(); } };
    },
    async citation() {
      const identity = identities.get("tenant-1", "member-1")!;
      const found = await service.search({ caller: identity.caller, employeeId: "emp-1", conversationId: "directory-http", sessionId: "http-session", turnId: "http-turn", snapshotVersion: "snap-1", generation: identity.generation, permissionMode: "read-only" }, "evidence");
      return found.items[0]!.citation_id;
    },
    async close() { await server.close(); await host.dispose(); await fixture.close(); },
  };
}

test("six real JWT-authenticated local-directory HTTP responses match OpenAPI and stale bindings return 409", async () => {
  const f = await setup();
  try {
    const challenge = await f.data(await f.request(`${f.prefix}/challenges`, "POST"), `${f.prefix}/challenges`, "post", 201);
    const registered = await f.data(await f.request(f.prefix, "POST", { ticket: challenge.challenge }), f.prefix, "post", 201);
    const bindingPath = `${f.prefix}/${registered.directory_id}/bindings/emp-1`;
    await f.data(await f.request(bindingPath, "PUT", { enabled: true, expected_revision: 0 }), `${f.prefix}/{directory_id}/bindings/{employee_id}`, "put", 200);
    await f.data(await f.request(f.prefix), f.prefix, "get", 200);
    const stale = await f.request(bindingPath, "PUT", { enabled: false, expected_revision: 0 });
    assert.equal(stale.status, 409);
    assert.match(stale.headers.get("content-type")!, /application\/problem\+json/);
    assert.equal((await stale.json() as { code: string }).code, "local_directory_revision_conflict");
    const id = await f.citation();
    await f.data(await f.request(`/api/agent/local-directory-citations/${id}/verify`, "POST", { offset: 0 }), "/api/agent/local-directory-citations/{citation_id}/verify", "post", 200);
    await f.data(await f.request(`${f.prefix}/${registered.directory_id}`, "DELETE"), `${f.prefix}/{directory_id}`, "delete", 200);
    const expired = await f.request(`/api/agent/local-directory-citations/${id}/verify`, "POST", {});
    assert.notEqual(expired.status, 200);
    assert.doesNotMatch(await expired.text(), /sensitive-http-citation-evidence/);
  } finally { await f.close(); }
});

test("real HTTP checks current policy again after the controlled read resolves and before responding", async () => {
  const f = await setup();
  try {
    const directory = await f.data(await f.request(f.prefix, "POST", { ticket: "ticket" }), f.prefix, "post", 201);
    assert.equal((await f.request(`${f.prefix}/${directory.directory_id}/bindings/emp-1`, "PUT", { enabled: true, expected_revision: 0 })).status, 200);
    const id = await f.citation();
    const verify = f.service.verifyCitation.bind(f.service);
    f.service.verifyCitation = async (...args) => {
      const result = await verify(...args);
      f.seed(false);
      return result;
    };
    const response = await f.request(`/api/agent/local-directory-citations/${id}/verify`, "POST", {});
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /sensitive-http-citation-evidence/);
  } finally { await f.close(); }
});

for (const action of ["unbind", "logout", "policy", "revoke"] as const) {
  test(`real HTTP verify with IPC in flight rejects concurrent ${action} without returning source text`, { timeout: 10_000 }, async () => {
    const f = await setup();
    try {
      const directory = await f.data(await f.request(f.prefix, "POST", { ticket: "ticket" }), f.prefix, "post", 201);
      const bind = `${f.prefix}/${directory.directory_id}/bindings/emp-1`;
      assert.equal((await f.request(bind, "PUT", { enabled: true, expected_revision: 0 })).status, 200);
      const id = await f.citation();
      const blocked = f.blockRead();
      try {
        const pending = f.request(`/api/agent/local-directory-citations/${id}/verify`, "POST", { offset: 0 });
        await blocked.entered;
        if (action === "unbind") assert.equal((await f.request(bind, "PUT", { enabled: false, expected_revision: 1 })).status, 200);
        if (action === "logout") assert.equal((await f.request("/api/agent/logout", "POST")).status, 200);
        if (action === "revoke") assert.equal((await f.request(`${f.prefix}/${directory.directory_id}`, "DELETE")).status, 200);
        if (action === "policy") f.seed(false); // Same version: ensure CURRENT policy is checked, not just version equality.
        blocked.release();
        const response = await pending;
        assert.notEqual(response.status, 200);
        assert.match(response.headers.get("content-type")!, /application\/problem\+json/);
        assert.doesNotMatch(await response.text(), /sensitive-http-citation-evidence/);
      } finally { blocked.release(); }
    } finally { await f.close(); }
  });
}
