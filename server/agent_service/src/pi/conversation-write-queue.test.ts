import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationWriteQueue } from "./conversation-write-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("calls of one conversation run one at a time, in order; other conversations do not wait", async () => {
  const queue = new ConversationWriteQueue();
  const log: string[] = [];
  const gate = deferred();
  const first = queue.run("group", undefined, async () => { log.push("first start"); await gate.promise; log.push("first end"); });
  const second = queue.run("group", undefined, async () => { log.push("second"); });
  await queue.run("other", undefined, async () => { log.push("other"); });
  await tick();
  assert.deepEqual(log, ["first start", "other"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ["first start", "other", "first end", "second"]);
});

test("a failed call releases the queue", async () => {
  const queue = new ConversationWriteQueue();
  await assert.rejects(queue.run("group", undefined, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await queue.run("group", undefined, async () => "next"), "next");
});

test("an aborted waiter leaves the queue without running and without letting later calls overtake", async () => {
  const queue = new ConversationWriteQueue();
  const log: string[] = [];
  const gate = deferred();
  const running = queue.run("group", undefined, async () => { log.push("running"); await gate.promise; log.push("done"); });
  const controller = new AbortController();
  const waiting = queue.run("group", controller.signal, async () => { log.push("aborted call ran"); });
  const later = queue.run("group", undefined, async () => { log.push("later"); });
  await tick();
  controller.abort(new Error("stopped"));
  await assert.rejects(waiting, /stopped/);
  await tick();
  assert.deepEqual(log, ["running"], "the later call still waits for the running one");
  gate.resolve();
  await Promise.all([running, later]);
  assert.deepEqual(log, ["running", "done", "later"]);
});

test("a call already aborted never runs", async () => {
  const queue = new ConversationWriteQueue();
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  let ran = false;
  await assert.rejects(queue.run("group", controller.signal, async () => { ran = true; }), /stopped/);
  assert.equal(ran, false);
  assert.equal(await queue.run("group", undefined, async () => "next"), "next");
});
