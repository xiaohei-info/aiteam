import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HINDSIGHT_CLIENT_PROTOCOL, normalizeHindsightRuntimeConfig, type HindsightRuntimeConfig } from "../manager-client.js";
import { createControlledResourceLoader, hindsightConfigPath, hindsightStateDir } from "./resources.js";
import type { SessionAuthorization } from "./session-host.js";

function runtime(id: string, auto: boolean, revision = 1): HindsightRuntimeConfig {
  return { base_url: "https://manager.test/api/manager/hindsight", bank_id: `aiteam-${"a".repeat(32)}`,
    token: `fixture-token-${id}`, lease_id: id, version: revision, policy_revision: revision, allowed_operations: ["recall", "retain"],
    client_protocol: HINDSIGHT_CLIENT_PROTOCOL, explicit_auto_retain: auto,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() };
}

function authorization(auto = true): SessionAuthorization {
  return { caller: { callerId: "member", userId: "member", tenantId: "tenant", accessToken: "fixture-jwt" }, employeeId: "employee",
    snapshot: { employee_id: "employee", version: "1", snapshot_version: "snapshot-1", display_name: "Fixture",
      memory_policy: { enabled: true, allowed_operations: ["recall", "retain"], explicit_auto_retain: auto },
      tool_policy: { allowed_tools: ["hindsight_recall", "hindsight_retain"] } } };
}

type Sent = { method: string; path: string; token: string | null; body: Record<string, any> | undefined };

async function fixture(action: (f: Awaited<ReturnType<typeof fixtureState>>) => Promise<void>) {
  const f = await fixtureState();
  try { await action(f); }
  finally { await f.close(); }
}

async function fixtureState() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-consent-sdk-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(workspace);
  const originalFetch = globalThis.fetch;
  const requests: Sent[] = [];
  const denied = new Map<string, number>();
  const loaders: ReturnType<typeof createControlledResourceLoader>[] = [];
  let afterPost: (() => void) | undefined;
  let recallResponse: ((sent: Sent) => Response) | undefined;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const text = req.method === "GET" ? "" : await req.text();
    const sent = { method: req.method, path: new URL(req.url).pathname, token: req.headers.get("Authorization"), body: text ? JSON.parse(text) : undefined };
    requests.push(sent);
    if (req.method === "GET") {
      assert.match(sent.path, /\/profile$/);
      return Response.json({ bank_id: `aiteam-${"a".repeat(32)}`, name: "Fixture", mission: "", disposition: { skepticism: 3, empathy: 3, literalism: 3 } });
    }
    assert.equal(req.method, "POST"); // Real ensureProjectBank must never try PUT.
    if (sent.path.endsWith("/recall")) return recallResponse?.(sent) ?? Response.json({ results: [{ id: "fixture-fact", text: "FRESH_RECALL", type: "world" }] });
    assert.match(sent.path, /\/memories$/);
    const status = denied.get(sent.token ?? "") ?? 200;
    const response = status === 200
      ? Response.json({ success: true, bank_id: `aiteam-${"a".repeat(32)}`, async: true, operation_id: "55555555-5555-4555-8555-555555555555" })
      : Response.json({ detail: "fixture authorization/unavailable response" }, { status });
    afterPost?.();
    return response;
  };
  const ctx = { cwd: workspace, ui: { notify: () => undefined, setStatus: () => undefined },
    sessionManager: { getSessionFile: () => undefined } } as unknown as ExtensionContext;
  async function load(lease: HindsightRuntimeConfig, options: { auto?: boolean; interval?: number } = {}) {
    const loader = createControlledResourceLoader("Fixture", undefined, authorization(options.auto ?? true), workspace, agentDir, "https://manager.test", lease);
    loaders.push(loader);
    const configPath = hindsightConfigPath(agentDir, workspace, lease);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.retain.flushIntervalMs = options.interval ?? 0; // owned fixture: exercise actual timer deterministically
    writeFileSync(configPath, JSON.stringify(config));
    await loader.reload();
    const extension = loader.getExtensions().extensions[0]!;
    const emit = async (type: string, event: Record<string, unknown> = {}) => {
      let result: unknown;
      for (const handler of extension.handlers.get(type) ?? []) result = await handler({ type, ...event }, ctx);
      return result as { messages: unknown[] } | undefined;
    };
    const tool = async (name: string, params: Record<string, unknown>) => {
      const definition = extension.tools.get(name)!.definition;
      return definition.execute("fixture-call", params, undefined, undefined, ctx);
    };
    await emit("session_start");
    return { loader, config, configPath, extension, emit, tool };
  }
  return { root, workspace, agentDir, requests, denied, load,
    setAfterPost: (handler: () => void) => { afterPost = handler; },
    setRecallResponse: (handler: (sent: Sent) => Response) => { recallResponse = handler; },
    posts: () => requests.filter((req) => req.path.endsWith("/memories")),
    close: async () => { for (const loader of loaders) await loader.shutdown(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); } };
}

const autoMessages = [{ role: "user", content: "AUTO_OLD", timestamp: 1 }];

// These execute the pinned extension/SDK; only the final network transport is a fixture.
test("snapshot auto=true and current runtime=false suppress auto but fresh manual and recall really execute", async () => {
  await fixture(async (f) => {
    const current = await f.load(runtime("manual-only", false));
    assert.equal(current.extension.handlers.has("agent_end"), false);
    assert.equal(current.config.retain.enabled, true);
    await current.emit("agent_end", { messages: autoMessages });
    assert.equal(f.posts().length, 0);
    const recalled = await current.tool("hindsight_recall", { query: "fixture" });
    assert.match(JSON.stringify(recalled), /FRESH_RECALL/);
    await current.tool("hindsight_retain", { content: "MANUAL_FRESH", context: "explicit fixture" });
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0]!.body!.items[0].content, "MANUAL_FRESH");
    assert.equal(f.posts()[0]!.token, "Bearer fixture-token-manual-only");
    await current.loader.shutdown();
    assert.equal(f.posts().length, 1);
  });
});

test("legacy/unconfirmed or missing runtime consent never falls back to stale snapshot true", async () => {
  await fixture(async (f) => {
    const legacy = runtime("legacy-response", true);
    delete legacy.client_protocol;
    const old = await f.load(legacy);
    assert.equal(old.extension.tools.has("hindsight_retain"), false);
    assert.equal(old.extension.handlers.has("agent_end"), false);
    const missing = runtime("missing-consent", true);
    delete missing.explicit_auto_retain;
    const current = await f.load(missing);
    assert.equal(current.extension.handlers.has("agent_end"), false);
    assert.equal(current.extension.tools.has("hindsight_retain"), true);
    await current.emit("agent_end", { messages: autoMessages });
    await current.loader.shutdown(); await old.loader.shutdown();
    assert.equal(f.posts().length, 0);
    for (const invalid of ["true", 1, null, {}]) {
      assert.throws(() => normalizeHindsightRuntimeConfig({ ...runtime("invalid", true), explicit_auto_retain: invalid }, "https://manager.test"), /consent/);
    }
  });
});

test("pending automatic and manual jobs from an old lease cannot borrow new consent or be relabelled", async () => {
  await fixture(async (f) => {
    const first = runtime("before-cancel", true);
    const old = await f.load(first);
    await old.emit("agent_end", { messages: autoMessages });
    await old.tool("hindsight_retain", { content: "MANUAL_OLD_PENDING", context: "explicit old fixture" });
    const queued = readFileSync(old.config.retain.queuePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(queued.length, 2);
    assert.match(queued[0].item.content, /AUTO_OLD/);
    assert.equal(f.posts().length, 0);
    f.denied.set(`Bearer ${first.token}`, 403);
    const current = await f.load(runtime("after-cancel", false, 2));
    assert.notEqual(old.configPath, current.configPath);
    assert.notEqual(old.config.retain.queuePath, current.config.retain.queuePath);
    assert.equal(current.extension.handlers.has("agent_end"), false);
    // Reload the OLD pinned tool after a replacement config exists. It must stay
    // attached to its own queue and must not consume the replacement token.
    await old.tool("hindsight_retain", { content: "OLD_CALL_AFTER_CANCEL", context: "old fixture" });
    await old.loader.shutdown();
    assert.equal(f.posts().length, 1);
    assert.equal(f.posts()[0]!.token, `Bearer ${first.token}`);
    assert.equal(f.posts()[0]!.body!.operation_id, queued[0].id);
    const pausedBytes = readFileSync(old.config.retain.queuePath, "utf8");
    assert.match(pausedBytes, /MANUAL_OLD_PENDING/);
    assert.match(pausedBytes, /AUTO_OLD/);
    assert.ok(existsSync(current.configPath));
    await current.tool("hindsight_retain", { content: "MANUAL_FRESH", context: "new fixture" });
    await current.loader.shutdown();
    const newPosts = f.posts().filter((req) => req.token === "Bearer fixture-token-after-cancel");
    assert.equal(newPosts.length, 1);
    assert.equal(newPosts[0]!.body!.items[0].content, "MANUAL_FRESH");
    assert.equal(readFileSync(old.config.retain.queuePath, "utf8"), pausedBytes);
  });
});

for (const rejection of [401, 403]) {
  test(`SDK ${rejection} retry queue remains paused even when a fresh same-policy lease allows auto`, async () => {
    await fixture(async (f) => {
      const lease = runtime(`denied-${rejection}`, true);
      const old = await f.load(lease);
      await old.emit("agent_end", { messages: autoMessages });
      f.denied.set(`Bearer ${lease.token}`, rejection);
      await old.loader.shutdown();
      const paused = readFileSync(old.config.retain.queuePath, "utf8");
      const current = await f.load(runtime(`renewed-${rejection}`, true)); // same policy revision, different lease
      await current.loader.shutdown();
      assert.notEqual(current.config.retain.queuePath, old.config.retain.queuePath);
      assert.equal(f.posts().length, 1);
      assert.equal(readFileSync(old.config.retain.queuePath, "utf8"), paused);
    });
  });
}

test("same authorized lease uses pinned periodic retry without changing operation identity", async () => {
  await fixture(async (f) => {
    const lease = runtime("periodic", true);
    const loaded = await f.load(lease, { interval: 25 });
    f.denied.set(`Bearer ${lease.token}`, 503);
    let delivered!: () => void;
    const delivery = new Promise<void>((resolve) => { delivered = resolve; });
    f.setAfterPost(() => {
      if (f.posts().length === 1) f.denied.delete(`Bearer ${lease.token}`);
      else delivered();
    });
    await loaded.emit("agent_end", { messages: autoMessages });
    const queue = JSON.parse(readFileSync(loaded.config.retain.queuePath, "utf8").trim());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([delivery, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SDK periodic retry did not run")), 3000); })]);
    } finally { if (timer) clearTimeout(timer); }
    await loaded.loader.shutdown();
    assert.equal(f.posts().length, 2);
    assert.equal(f.posts()[0]!.body!.operation_id, queue.id);
    assert.deepEqual(f.posts()[0]!.body, f.posts()[1]!.body);
    assert.equal(readFileSync(loaded.config.retain.queuePath, "utf8").trim(), "");
  });
});

test("unknown legacy queue is neither replayed nor deleted by current manual-only startup/shutdown", async () => {
  await fixture(async (f) => {
    const current = await f.load(runtime("unknown-queue", false));
    const legacyPath = join(hindsightStateDir(f.agentDir, f.workspace), "retain-queue.jsonl");
    const bytes = '{"unknown_source":"AUTO_OR_MANUAL_CONTENT_NOT_ADOPTED"}\n';
    writeFileSync(legacyPath, bytes);
    await current.loader.shutdown();
    assert.equal(f.posts().length, 0);
    assert.equal(readFileSync(legacyPath, "utf8"), bytes);
  });
});

test("snapshot denial and runtime readonly/empty scopes cannot enable automatic or manual writes", async () => {
  await fixture(async (f) => {
    const snapshotDenied = await f.load(runtime("snapshot-auto-denied", true), { auto: false });
    assert.equal(snapshotDenied.extension.handlers.has("agent_end"), false);
    const readonly = { ...runtime("readonly", true), allowed_operations: ["recall"] as ("recall" | "retain")[] };
    const reader = await f.load(readonly);
    assert.equal(reader.config.retain.enabled, false);
    assert.equal(reader.extension.tools.has("hindsight_retain"), false);
    await reader.emit("agent_end", { messages: autoMessages });
    await reader.loader.shutdown();
    assert.equal(f.posts().length, 0);
    const deniedLease = { ...runtime("deny-all", false), allowed_operations: [] };
    const disabled = createControlledResourceLoader("Fixture", undefined, authorization(), f.workspace, f.agentDir, undefined, deniedLease);
    await disabled.reload();
    assert.deepEqual(disabled.getExtensions().extensions, []);
    await disabled.shutdown();
  });
});

test("a loader without memory material cannot remove another lease's generated configuration", async () => {
  await fixture(async (f) => {
    const active = await f.load(runtime("active-config", false));
    const noLease = createControlledResourceLoader("Fixture", undefined, authorization(), f.workspace, f.agentDir);
    await noLease.shutdown();
    assert.equal(existsSync(active.configPath), true);
    await active.tool("hindsight_retain", { content: "MANUAL_STILL_AUTHORIZED", context: "fixture" });
    assert.equal(f.posts()[0]!.body!.items[0].content, "MANUAL_STILL_AUTHORIZED");
  });
});

for (const failure of ["expired", "forbidden", "unavailable", "guarded"] as const) {
  test(`actual pinned context immediately revalidates identical counts and never reinjects ${failure} memory`, async () => {
    await fixture(async (f) => {
      const lease = runtime(`context-${failure}`, false);
      if (failure !== "guarded") lease.retention_mode = "fact_only";
      const loaded = await f.load(lease);
      let clock = 0;
      f.setRecallResponse((sent) => {
        if (failure !== "guarded") {
          assert.deepEqual(sent.body!.types, ["world", "experience"]);
          assert.equal(sent.body!.prefer_observations, false);
        }
        if (clock === 0) return Response.json({ results: [{ id: "old", text: "OLD_EXPIRING_MARKER", type: "world" }] });
        if (failure === "expired") return Response.json({ results: [] });
        return Response.json({ code: failure === "guarded" ? "memory_retention_option_unsupported" : "forbidden",
          detail: "Current Manager memory unavailable" }, { status: failure === "unavailable" ? 503 : 403 });
      });
      const user = { role: "user", content: "USER_CONTENT_PRESERVED", timestamp: 1 };
      const first = await loaded.emit("context", { messages: [user] });
      assert.match(JSON.stringify(first), /OLD_EXPIRING_MARKER/);
      assert.equal(f.requests.filter((req) => req.path.endsWith("/recall")).length, 1);
      clock = 1; // deterministic Manager clock/permission boundary, no TTL sleeps
      const second = await loaded.emit("context", { messages: [user] }); // same count/bank, immediate cache regression
      assert.equal(f.requests.filter((req) => req.path.endsWith("/recall")).length, 2);
      assert.deepEqual(second, { messages: [user] });
      // Even when a caller reuses the earlier context array, discard only our
      // own injected object; never strip legitimate user text based on tags.
      const cleaned = await loaded.emit("context", { messages: first!.messages });
      assert.deepEqual(cleaned, { messages: [user] });
      const literalUser = { role: "user", content: "<hindsight-memory>USER_LITERAL_NOT_AN_INJECTION", timestamp: 2 };
      const literal = await loaded.emit("context", { messages: [literalUser] });
      assert.deepEqual(literal, { messages: [literalUser] });
      assert.equal(f.posts().length, 0);
    });
  });
}

test("fact-only SDK manual/context consumers accept safe fact fields and reject unsupported derived requests", async () => {
  await fixture(async (f) => {
    const lease = { ...runtime("fact-only-sdk", false), retention_mode: "fact_only" as const };
    const loaded = await f.load(lease);
    f.setRecallResponse((sent) => {
      if (sent.body!.include?.chunks != null) return Response.json({ code: "memory_retention_option_unsupported", detail: "Fact-only retention does not support chunks" }, { status: 403 });
      return Response.json({ results: [{ id: "fresh", text: "FRESH_ONLY_MARKER", type: "world" }] });
    });
    const manual = await loaded.tool("hindsight_recall", { query: "fixture query" });
    assert.match(JSON.stringify(manual), /FRESH_ONLY_MARKER/);
    const context = await loaded.emit("context", { messages: [{ role: "user", content: "fixture query", timestamp: 1 }] });
    assert.match(JSON.stringify(context), /FRESH_ONLY_MARKER/);
    const repeated = await loaded.emit("context", { messages: context!.messages });
    assert.equal(JSON.stringify(repeated).split("FRESH_ONLY_MARKER").length - 1, 1);
    await assert.rejects(loaded.tool("hindsight_recall", { query: "fixture query", includeChunks: true }),
      /Fact-only retention does not support chunks/);
    if (process.env.AITEAM_S04_SDK_CONTRACT_OUT) {
      writeFileSync(process.env.AITEAM_S04_SDK_CONTRACT_OUT, JSON.stringify(f.requests.filter((req) => req.path.endsWith("/recall")).map((req) => req.body)));
    }
  });
});
