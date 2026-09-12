import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeLeaseCache, RuntimeLeaseInvalidatedError, boundedLeaseTtl, encodeScope } from "./runtime-lease-cache.js";

test("runtime lease TTL is bounded by JWT, upstream, and the five-minute ceiling", () => {
  assert.equal(boundedLeaseTtl(1_000, 600_000, 201_000), 200_000);
  assert.equal(boundedLeaseTtl(1_000, 600_000, 600_000), 300_000);
  assert.equal(boundedLeaseTtl(1_000, undefined, 600_000), undefined);
  let now = 1_000;
  let monotonic = 10_000;
  const cache = new RuntimeLeaseCache({ now: () => now, monotonicNow: () => monotonic });
  const entry = cache.put("owner:runtime", "secret", { now, userJwtExpiresAt: 600_000, upstreamExpiresAt: 201_000 });
  assert.equal(entry?.expiresAt, 201_000);
  now = 200_999;
  assert.equal(cache.get("owner:runtime")?.value, "secret");
  monotonic += 200_000;
  assert.equal(cache.get("owner:runtime"), undefined);
});

test("generation invalidation rejects an in-flight response and prevents cache refill", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = new RuntimeLeaseCache<{ secret: string }>();
  const pending = cache.getOrLoad(
    "owner:runtime",
    async () => { await gate; return { secret: "stale" }; },
    () => ({ userJwtExpiresAt: Date.now() + 60_000, upstreamExpiresAt: Date.now() + 60_000 }),
  );
  cache.clear("owner:runtime");
  release();
  await assert.rejects(pending, RuntimeLeaseInvalidatedError);
  assert.equal(cache.get("owner:runtime"), undefined);
});

test("retryable refresh failures reuse only the still-valid cached value while denial clears it", async () => {
  let now = 1_000;
  const cache = new RuntimeLeaseCache({ now: () => now });
  const expiry = now + 60_000;
  cache.put("owner:runtime", "old", { now, userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  const reused = await cache.getOrLoad("owner:runtime", async () => { throw new Error("network timeout"); }, () => ({ userJwtExpiresAt: expiry, upstreamExpiresAt: expiry }), { forceRefresh: true, allowReuseOnFailure: true, isRetryableFailure: () => true, isDenial: (error) => (error as { status?: number }).status === 403 });
  assert.equal(reused, "old");
  await assert.rejects(cache.getOrLoad("owner:runtime", async () => { throw Object.assign(new Error("denied"), { status: 403 }); }, () => ({ userJwtExpiresAt: expiry, upstreamExpiresAt: expiry }), { forceRefresh: true, allowReuseOnFailure: true, isRetryableFailure: () => true, isDenial: (error) => (error as { status?: number }).status === 403 }), /denied/);
  assert.equal(cache.get("owner:runtime"), undefined);
  now += 1;
});

test("encoded cache owner prefixes remain isolated when IDs contain delimiters", () => {
  const cache = new RuntimeLeaseCache();
  const expiry = Date.now() + 60_000;
  const firstKey = encodeScope(["runtime", "tenant:a", "member"]);
  const secondKey = encodeScope(["runtime", "tenant", "a:member"]);
  cache.put(firstKey, "first", { userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  cache.put(secondKey, "second", { userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  cache.clearOwner(encodeScope(["runtime", "tenant:a", "member"]));
  assert.equal(cache.get(firstKey), undefined);
  assert.equal(cache.get(secondKey)?.value, "second");
});

test("runtime lease cache evicts least-recently-used entries and does not cache missing expiry", () => {
  const cache = new RuntimeLeaseCache({ maxEntries: 2 });
  const expiry = Date.now() + 60_000;
  cache.put("one", "one", { userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  cache.put("two", "two", { userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  assert.equal(cache.get("one")?.value, "one");
  cache.put("three", "three", { userJwtExpiresAt: expiry, upstreamExpiresAt: expiry });
  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.put("online-only", "secret", { userJwtExpiresAt: undefined, upstreamExpiresAt: expiry }), undefined);
});
