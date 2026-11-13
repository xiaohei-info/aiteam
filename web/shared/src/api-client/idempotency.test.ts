import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdempotencyKey } from "./idempotency.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newIdempotencyKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("无 randomUUID（非安全上下文）时回退到 getRandomValues，仍是合法 v4 UUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => crypto_fill(a) });
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(UUID_V4);
  });

  it("回退路径固定版本位与变体位", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(0x00) });
    expect(newIdempotencyKey()).toBe("00000000-0000-4000-8000-000000000000");
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(0xff) });
    expect(newIdempotencyKey()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("有 randomUUID 时直接使用", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "fixed" });
    expect(newIdempotencyKey()).toBe("fixed");
  });
});

function crypto_fill(a: Uint8Array): Uint8Array {
  for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}
