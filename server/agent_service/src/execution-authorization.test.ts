import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionAuthorizationRegistry } from "./execution-authorization.js";

test("registry owner keys are collision-safe for delimiter-containing tenant/member IDs", () => {
  const registry = new ExecutionAuthorizationRegistry();
  const first = { callerId: "member", userId: "member", tenantId: "tenant:a", accessToken: "jwt-a" };
  const second = { callerId: "a:member", userId: "a:member", tenantId: "tenant", accessToken: "jwt-b" };
  registry.register(first);
  registry.register(second);
  assert.equal(registry.resolve("tenant:a", "member")?.accessToken, "jwt-a");
  assert.equal(registry.resolve("tenant", "a:member")?.accessToken, "jwt-b");
  registry.invalidate("tenant:a", "member");
  assert.equal(registry.resolve("tenant:a", "member"), undefined);
  assert.equal(registry.resolve("tenant", "a:member")?.accessToken, "jwt-b");
});

test("development-style identity without a bearer token cannot authorize background schedules", () => {
  const registry = new ExecutionAuthorizationRegistry();
  registry.register({ callerId: "local-development", userId: "local-development", tenantId: "local-development", roles: ["member"] });
  assert(registry.resolve("local-development", "local-development"));
  assert.equal(registry.resolve("local-development", "local-development", { requireAccessToken: true }), undefined);
});
