/**
 * 生成幂等键（`Idempotency-Key`）。
 *
 * `crypto.randomUUID` 只在安全上下文（HTTPS / localhost）存在；测试环境常通过
 * `http://<ip>:<port>` 访问，此时它是 undefined。`getRandomValues` 不受此限制，
 * 作为兜底生成 RFC 4122 v4 UUID。
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40); // version 4
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80); // variant 10xx
  const h = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
