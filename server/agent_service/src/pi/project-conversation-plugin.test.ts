import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HINDSIGHT_CLIENT_PROTOCOL, type HindsightRuntimeConfig } from "../manager-client.js";
import { projectMemoryScope } from "./project-conversation.js";
import { createControlledResourceLoader, groupMemberStateScope, hindsightConfigPath, hindsightStateDir, pinMemberProject } from "./resources.js";
import type { SessionAuthorization } from "./session-host.js";

// Executes the pinned Hindsight extension; only the network transport is a fixture.
const PROJECT_FOLDER = "secret-project-name";
const FACADE = "https://manager.test/api/manager/hindsight/employees/employee";

function lease(memoryScope: string): HindsightRuntimeConfig {
  return {
    base_url: `${FACADE}/scopes/${memoryScope}`, bank_id: `aiteam-${"a".repeat(32)}`, token: "fixture-jwt", lease_id: `lease-${memoryScope.slice(0, 8)}`,
    version: 1, policy_revision: 1, allowed_operations: ["recall", "retain"], client_protocol: HINDSIGHT_CLIENT_PROTOCOL, explicit_auto_retain: true,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
  };
}

function authorization(memoryScope: string): SessionAuthorization {
  return {
    caller: { callerId: "member", userId: "member", tenantId: "tenant", accessToken: "fixture-jwt" }, employeeId: "employee", memoryScope,
    snapshot: {
      employee_id: "employee", version: "1", snapshot_version: "snapshot-1", display_name: "Fixture",
      memory_policy: { enabled: true, allowed_operations: ["recall", "retain"], explicit_auto_retain: true },
      tool_policy: { allowed_tools: ["hindsight_recall", "hindsight_retain"] },
    },
  };
}

test("the real Hindsight plugin uses the scoped adapter and leaves the project folder alone", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiteam-project-plugin-")));
  const workspace = join(root, PROJECT_FOLDER);
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "keep.txt"), "user file");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? "" : await request.text();
    const path = new URL(request.url).pathname;
    requests.push({ path, body });
    if (request.method === "GET") return Response.json({ bank_id: `aiteam-${"a".repeat(32)}`, name: "Fixture", mission: "", disposition: { skepticism: 3, empathy: 3, literalism: 3 } });
    if (path.endsWith("/recall")) return Response.json({ results: [{ id: "fact", text: "SCOPED_RECALL", type: "world" }] });
    return Response.json({ success: true, bank_id: `aiteam-${"a".repeat(32)}`, async: true, operation_id: "55555555-5555-4555-8555-555555555555" });
  };
  const ctx = {
    cwd: workspace, ui: { notify: () => undefined, setStatus: () => undefined },
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  const scopeA = projectMemoryScope("project-a");
  const scopeB = projectMemoryScope("project-b");
  const loaders: ReturnType<typeof createControlledResourceLoader>[] = [];
  const open = async (scope: string) => {
    const config = lease(scope);
    const loader = createControlledResourceLoader("Fixture", undefined, authorization(scope), workspace, agentDir, "https://manager.test", config);
    loaders.push(loader);
    const path = hindsightConfigPath(agentDir, workspace, config, scope);
    const generated = JSON.parse(readFileSync(path, "utf8"));
    generated.retain.flushIntervalMs = 0;
    writeFileSync(path, JSON.stringify(generated));
    await loader.reload();
    const extension = loader.getExtensions().extensions[0]!;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
    return {
      call: (name: string, params: Record<string, unknown>) => extension.tools.get(name)!.definition.execute("fixture-call", params, undefined, undefined, ctx),
      generated,
    };
  };
  try {
    const a = await open(scopeA);
    const recalled = await a.call("hindsight_recall", { query: "fixture" });
    assert.match(JSON.stringify(recalled), /SCOPED_RECALL/);
    await a.call("hindsight_retain", { content: "A_ONLY", context: "explicit fixture" });

    const b = await open(scopeB);
    await b.call("hindsight_retain", { content: "B_ONLY", context: "explicit fixture" });

    const inScope = (scope: string) => requests.filter((item) => item.path.startsWith(`${new URL(FACADE).pathname}/scopes/${scope}/`));
    assert.ok(requests.length > 0);
    assert.equal(inScope(scopeA).length + inScope(scopeB).length, requests.length, "every request stays on a scoped adapter, never the shared one");
    assert.match(inScope(scopeA).map((item) => item.body).join("\n"), /A_ONLY/);
    assert.doesNotMatch(inScope(scopeA).map((item) => item.body).join("\n"), /B_ONLY/);
    assert.match(inScope(scopeB).map((item) => item.body).join("\n"), /B_ONLY/);
    assert.doesNotMatch(inScope(scopeB).map((item) => item.body).join("\n"), /A_ONLY/);

    const sent = requests.map((item) => `${item.path}\n${item.body}`).join("\n");
    assert.equal(sent.includes(PROJECT_FOLDER), false, "the project folder name never reaches Manager");
    assert.equal(sent.includes(workspace), false, "the project path never reaches Manager");
    assert.equal(existsSync(join(workspace, ".pi")), false, "no plugin state is written into the project");
    assert.notEqual(hindsightStateDir(agentDir, workspace, scopeA), hindsightStateDir(agentDir, workspace, scopeB));
    assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "user file");
  } finally {
    for (const loader of loaders) await loader.shutdown();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("group members keep their own plugin state outside the shared folder, and a pinned member recalls under its old folder name", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiteam-group-plugin-")));
  const workspace = join(root, "shared-group-folder");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? "" : await request.text();
    const path = new URL(request.url).pathname;
    requests.push({ path, body });
    if (request.method === "GET") return Response.json({ bank_id: `aiteam-${"a".repeat(32)}`, name: "Fixture", mission: "", disposition: { skepticism: 3, empathy: 3, literalism: 3 } });
    if (path.endsWith("/recall")) return Response.json({ results: [] });
    return Response.json({ success: true, bank_id: `aiteam-${"a".repeat(32)}`, async: true, operation_id: "55555555-5555-4555-8555-555555555555" });
  };
  const ctx = { cwd: workspace, ui: { notify: () => undefined, setStatus: () => undefined }, sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const loaders: ReturnType<typeof createControlledResourceLoader>[] = [];
  const recallBody = async (employee: string) => {
    const scope = groupMemberStateScope("group", employee);
    const config = { ...lease("unused"), base_url: FACADE, lease_id: `lease-${employee}` };
    const { memoryScope: _unused, ...base } = authorization("unused");
    const loader = createControlledResourceLoader("Fixture", undefined, { ...base, employeeId: employee, hindsightStateScope: scope }, workspace, agentDir, "https://manager.test", config);
    loaders.push(loader);
    await loader.reload();
    const extension = loader.getExtensions().extensions[0]!;
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
    requests.length = 0;
    await extension.tools.get("hindsight_recall")!.definition.execute("fixture-call", { query: "fixture" }, undefined, undefined, ctx);
    return requests.find((item) => item.path.endsWith("/recall"))!.body;
  };
  try {
    pinMemberProject(agentDir, groupMemberStateScope("group", "veteran"), "design-team");
    assert.match(await recallBody("veteran"), /project:design-team/, "what the member retained in its old folder stays recallable");
    const newcomer = await recallBody("newcomer");
    assert.doesNotMatch(newcomer, /project:design-team/);
    assert.doesNotMatch(newcomer, /shared-group-folder/, "the shared folder is not the member's identity");
    assert.equal(existsSync(join(workspace, ".pi")), false, "no plugin state is written into the shared folder");
    assert.notEqual(hindsightStateDir(agentDir, workspace, groupMemberStateScope("group", "veteran")), hindsightStateDir(agentDir, workspace, groupMemberStateScope("group", "newcomer")));
  } finally {
    for (const loader of loaders) await loader.shutdown();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
