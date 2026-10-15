import type { IncomingMessage } from "node:http";
import { parsePublicJwks, verifyJwt, type AuthenticatedCaller, type JwtJwk } from "./auth.js";

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 60_000;
const COOLDOWN_MS = 5_000;
type Entry = { keys: Map<string, JwtJwk>; expires: number; attempted: number; pending?: Promise<void> };

/** Fixed trusted Manager only. Bearers cannot discover tenants (JWKS GET can create keys).
 * Admission is called only after successful Manager credential authentication.
 * Expired material is never used on refresh failure; Manager owns current + retired 24h.
 */
export class ManagerJwksAuthenticator {
  private readonly origin: string;
  private readonly entries = new Map<string, Entry>();
  private active = 0;
  private window = 0;
  private requests = 0;

  constructor(managerUrl: string, private readonly issuer: string, private readonly audience: string) {
    const url = new URL(managerUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Manager JWKS requires a fixed http(s) origin without credentials, path, query or fragment");
    if (!issuer || !audience) throw new Error("JWT issuer and audience are required");
    this.origin = url.origin;
  }

  readonly authenticate = async (request: IncomingMessage): Promise<AuthenticatedCaller> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new Error("Missing bearer token");
    const token = authorization.slice(7);
    const { tenant, kid } = this.selector(token);
    const entry = this.entries.get(tenant);
    if (!entry) throw new Error("Tenant requires Manager login");
    if (entry.expires <= Date.now() || !entry.keys.has(kid)) await this.refresh(tenant, entry);
    if (entry.expires <= Date.now()) throw new Error("Manager public keys expired");
    return verifyJwt(token, entry.keys, { issuer: this.issuer, audience: this.audience, clockSkewSeconds: 0 });
  };

  async verifyLoginToken(token: string, expectedTenant: string): Promise<AuthenticatedCaller> {
    const { tenant } = this.selector(token);
    if (tenant !== expectedTenant) throw new Error("Manager token tenant mismatch");
    let entry = this.entries.get(tenant);
    if (!entry) {
      // Reserve bounded slots before awaiting network IO; concurrent logins share one fetch.
      if (this.entries.size >= 256) {
        const idle = [...this.entries].find(([, value]) => !value.pending);
        if (!idle) throw new Error("Manager public key cache busy");
        this.entries.delete(idle[0]);
      }
      entry = { keys: new Map(), expires: 0, attempted: 0 };
      this.entries.set(tenant, entry);
    }
    return this.authenticate({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
  }

  private selector(token: string): { tenant: string; kid: string } {
    if (typeof token !== "string" || token.length > 16_384) throw new Error("Invalid JWT");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed JWT");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const tenant = claims?.tenant_id;
    const kid = header?.kid;
    if (header?.alg !== "RS256" || typeof tenant !== "string" || !TENANT.test(tenant) || typeof kid !== "string" || !this.scopedKid(kid, tenant)) throw new Error("Invalid JWT tenant/key scope");
    // These unverified values select only a previously admitted cache entry, never a URL.
    return { tenant, kid };
  }

  private scopedKid(kid: string, tenant: string): boolean {
    return kid.startsWith(`${tenant}:`) && /^[1-9][0-9]{0,9}$/.test(kid.slice(tenant.length + 1));
  }

  private async refresh(tenant: string, entry: Entry): Promise<void> {
    if (entry.pending) return entry.pending;
    const now = Date.now();
    if (now - entry.attempted < COOLDOWN_MS) throw new Error("Manager public key refresh cooling down");
    const window = Math.floor(now / 1000);
    if (this.window !== window) { this.window = window; this.requests = 0; }
    if (this.active >= 4 || this.requests >= 16) throw new Error("Manager public key refresh busy");
    entry.attempted = now;
    this.active += 1;
    this.requests += 1;
    entry.pending = this.download(tenant).then((keys) => {
      entry.keys = keys; // Replace, never merge revoked/retired keys back into the cache.
      entry.expires = Date.now() + TTL_MS;
    }).finally(() => { this.active -= 1; entry.pending = undefined; });
    return entry.pending;
  }

  private async download(tenant: string): Promise<Map<string, JwtJwk>> {
    const response = await fetch(`${this.origin}/api/auth/${tenant}/jwks.json`, {
      redirect: "error", signal: AbortSignal.timeout(3000), headers: { accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !response.body) {
      await response.body?.cancel();
      throw new Error("Manager public key response invalid");
    }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65_536) throw new Error("Manager public key response too large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const jwks = parsePublicJwks(Buffer.concat(chunks).toString("utf8"));
    if (jwks.keys.length > 32 || jwks.keys.some((key) => !this.scopedKid(key.kid, tenant))) throw new Error("Manager public key tenant scope invalid");
    return new Map(jwks.keys.map((key) => [key.kid, key]));
  }
}
