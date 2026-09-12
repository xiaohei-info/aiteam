import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createControlledResourceLoader } from "./resources.js";
import { SessionHost } from "./session-host.js";
import { ExecutionAuthorizationRegistry } from "../execution-authorization.js";
import { createFixture } from "../test-fixture.js";
import type { ManagerClient } from "../manager-client.js";


test("production SessionHost denial clears the shared execution identity used by scheduler", async () => {
  const fixture = await createFixture();
  const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt", claims: { exp: Math.floor((Date.now() + 60_000) / 1_000) } };
  const registry = new ExecutionAuthorizationRegistry();
  registry.register(caller);
  const manager: ManagerClient = {
    pullAuthorizedConfig: async () => ({ experts: [], solutions: [] }),
    getOrgTree: async () => ({}),
    pullRuntimeConfig: async () => { throw Object.assign(new Error("Manager denied runtime"), { status: 403 }); },
  };
  fixture.store.replaceProjections([
    { employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString(), model_policy: { model: "model-1", provider_ref: "provider-1", pricing: { pricing_version: 1 } } },
  ], [], [{ employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "1", snapshot_version: "snapshot-1", display_name: "Helper", model_policy: { model: "model-1", provider_ref: "provider-1", pricing: { pricing_version: 1 } }, tool_policy: { allowed_tools: [] } }]);
  fixture.store.updateConversation("conversation-1", { entryEmployeeId: "employee-1" });
  const host = new SessionHost({
    cwdRoot: join(fixture.dataRoot, "workspaces"), agentDir: join(fixture.dataRoot, "pi"), sessionDir: join(fixture.dataRoot, "sessions"),
    store: fixture.store, modelRuntime: fixture.modelRuntime, model: fixture.faux.getModel(), managerClient: manager,
    executionAuthorization: registry, resourceLoaderFactory: () => createControlledResourceLoader("test"),
  });
  try {
    await assert.rejects(host.prompt("conversation-1", "denied", undefined, caller), /denied|authorization/i);
    assert.equal(registry.resolve("tenant-1", "member-1", { requireAccessToken: true }), undefined);
  } finally {
    await host.dispose();
    await fixture.close();
  }
});
