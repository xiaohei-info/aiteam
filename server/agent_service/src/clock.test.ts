import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagerClock } from "./clock.js";

const headers = (date: Date, extra: Record<string, string> = {}) => new Headers({ date: date.toUTCString(), ...extra });

test("offset is Manager time minus the local round-trip midpoint", () => {
  const clock = new ManagerClock();
  const sentAt = 1_000_000_000_000;
  // Local clock is 10 minutes slow: Manager says T+600s at local midpoint.
  clock.observe(headers(new Date(sentAt + 600_000 + 500)), sentAt, sentAt + 1_000);
  assert.ok(Math.abs(clock.offsetMs - 600_000) <= 1_000, `offset ${clock.offsetMs}`);
});

test("missing, cached, implausible or slow observations are ignored", () => {
  const clock = new ManagerClock();
  const sentAt = Date.now();
  clock.observe(new Headers(), sentAt, sentAt + 10);
  clock.observe(headers(new Date(sentAt + 600_000), { age: "30" }), sentAt, sentAt + 10);
  clock.observe(headers(new Date(sentAt + 30 * 86_400_000)), sentAt, sentAt + 10);
  clock.observe(headers(new Date(sentAt + 600_000)), sentAt, sentAt + 60_000);
  clock.observe(new Headers({ date: "not a date" }), sentAt, sentAt + 10);
  assert.equal(clock.offsetMs, 0);
});

test("observingFetch calibrates from the response Date header", async () => {
  const clock = new ManagerClock();
  const skewed = (async () => new Response("ok", { headers: { date: new Date(Date.now() - 300_000).toUTCString() } })) as typeof fetch;
  await clock.observingFetch(skewed)("http://manager.invalid/");
  assert.ok(Math.abs(clock.offsetMs + 300_000) < 2_000, `offset ${clock.offsetMs}`);
  assert.ok(Math.abs(clock.now() - (Date.now() - 300_000)) < 2_000);
});
