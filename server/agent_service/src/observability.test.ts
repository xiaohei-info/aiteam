import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationLogger, makeRequestContext, observedFetch, requestContext, RotatingLog, safeRequestId } from "./observability.js";

test("logs discard payloads, credentials and exception text, retaining correlation metadata", () => {
  const lines: string[] = [];
  const logger = new ApplicationLogger(line => lines.push(line));
  const context = makeRequestContext("attacker-password", "secret-parent");
  requestContext.run(context, () => logger.log("info", "http.completed", {
    body: "private chat", authorization: "Bearer secret", message: "secret", status: 200,
    route: "/api/agent/conversations/:conversation_id/entries", employee_id: "password-secret", duration_ms: 12,
  }));
  const record = JSON.parse(lines[0]!);
  assert.equal(record.request_id, context.request_id);
  assert.equal(record.status, 200);
  assert.doesNotMatch(lines.join(""), /attacker|secret|private chat|authorization|body/);
  assert.equal(safeRequestId(context.request_id), context.request_id);
});

test("trace propagation preserves valid trace but replaces malformed/zero values", async () => {
  const parent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  const context = makeRequestContext(undefined, parent);
  assert.equal(context.trace_id, "a".repeat(32));
  assert.notEqual(context.traceparent, parent);
  assert.notEqual(makeRequestContext(undefined, `00-${"0".repeat(32)}-${"b".repeat(16)}-01`).trace_id, "0".repeat(32));
  await requestContext.run(context, () => observedFetch(async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-request-id"), context.request_id);
    assert.equal(headers.get("traceparent"), context.traceparent);
    assert.equal(headers.get("authorization"), "Bearer runtime-only");
    return new Response("ok");
  })("https://manager.test", { headers: { authorization: "Bearer runtime-only" } }));
});

test("file rotation is private, bounded, and log failures do not throw", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-log-"));
  try {
    const log = new RotatingLog(directory, 100, 2);
    for (let i = 0; i < 15; i++) log.write(JSON.stringify({ count: i, event: "test.event" }) + "\n");
    assert.ok(readdirSync(directory).length <= 3);
    assert.match(readFileSync(log.path, "utf8"), /14/);
    if (process.platform !== "win32") assert.equal(statSync(log.path).mode & 0o777, 0o600);
    rmSync(directory, { recursive: true });
    log.write("{}\n");
    assert.equal(log.failures, 1);
    assert.doesNotThrow(() => new ApplicationLogger(() => { throw new Error("disk full"); }).log("error", "test.event"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
