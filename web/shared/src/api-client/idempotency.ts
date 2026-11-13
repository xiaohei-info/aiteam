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
  const hex = Array.from(c.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0"));
  hex[6] = `4${hex[6]?.[1] ?? "0"}`; // version 4
  hex[8] = `${"89ab"[Number.parseInt(hex[8]?.[0] ?? "0", 16) & 3]}${hex[8]?.[1] ?? "0"}`; // variant 10xx
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
