import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface JwtClaims {
  tenant_id?: string;
  user_id?: string;
  sub?: string;
  roles?: string[];
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  enterprise_id?: string;
  [key: string]: unknown;
}

export interface JwtJwk {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  alg?: string;
  use?: string;
}

const PUBLIC_JWK_MEMBERS = new Set(["kty", "alg", "kid", "n", "e", "use"]);
const PRIVATE_JWK_MEMBERS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth"]);

/** Parse and canonicalize a public RSA JWKS document; reject unknown fields. */
export function parsePublicJwks(raw: string, context = "JWT JWKS"): { keys: JwtJwk[] } {
  let document: unknown;
  try { document = JSON.parse(raw); } catch { throw new Error(`${context} must be valid JSON`); }
  if (!document || typeof document !== "object" || Array.isArray(document) || Object.keys(document).some((key) => key !== "keys")) throw new Error(`${context} must contain only the keys member`);
  const keys = (document as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`${context} must contain at least one key`);
  const seen = new Set<string>();
  const canonical = keys.map((rawKey) => {
    if (!rawKey || typeof rawKey !== "object" || Array.isArray(rawKey)) throw new Error(`${context} must contain only RSA RS256 public keys`);
    const key = rawKey as Record<string, unknown>;
    if ([...Object.keys(key)].some((member) => !PUBLIC_JWK_MEMBERS.has(member)) || [...PRIVATE_JWK_MEMBERS].some((member) => Object.prototype.hasOwnProperty.call(key, member))) throw new Error(`${context} must contain only RSA RS256 public keys`);
    if (key.kty !== "RSA" || key.alg !== "RS256" || (key.use !== undefined && key.use !== "sig") || typeof key.n !== "string" || !key.n || typeof key.e !== "string" || !key.e) throw new Error(`${context} must contain only RSA RS256 public keys`);
    if (typeof key.kid !== "string" || !key.kid.trim() || seen.has(key.kid)) throw new Error(`${context} must not contain duplicate or empty kid values`);
    const result = { kty: "RSA" as const, alg: "RS256" as const, kid: key.kid, n: key.n, e: key.e, ...(key.use === undefined ? {} : { use: "sig" as const }) };
    try { createPublicKey({ key: result as unknown as JsonWebKey, format: "jwk" }); } catch { throw new Error(`${context} contains an invalid RSA public key`); }
    seen.add(key.kid);
    return result;
  });
  return { keys: canonical };
}

export interface AuthenticatedCaller {
  callerId: string;
  /** Optional bearer forwarding token for the narrow Agent→Manager pull seam. */
  accessToken?: string;
  tenantId?: string;
  userId?: string;
  roles?: string[];
  claims?: JwtClaims;
}

export interface JwtAuthenticatorOptions {
  jwks: { keys: JwtJwk[] };
  issuer: string;
  audience: string;
  clockSkewSeconds?: number;
}

export type AuthenticateRequest = (request: IncomingMessage) => AuthenticatedCaller | Promise<AuthenticatedCaller>;

export function createJwtAuthenticator(options: JwtAuthenticatorOptions): AuthenticateRequest {
  if (!options.issuer || !options.audience) throw new Error("JWT issuer and audience are required");
  const jwks = parsePublicJwks(JSON.stringify(options.jwks));
  const keys = new Map(jwks.keys.map((key) => [key.kid, key]));
  return (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new Error("Missing bearer token");
    return verifyJwt(header.slice("Bearer ".length), keys, options);
  };
}

export function verifyJwt(token: string, keys: Map<string, JwtJwk>, options: Omit<JwtAuthenticatorOptions, "jwks">): AuthenticatedCaller {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(decodeBase64Url(parts[0])) as { alg?: string; kid?: string };
    claims = JSON.parse(decodeBase64Url(parts[1])) as JwtClaims;
  } catch {
    throw new Error("Malformed JWT payload");
  }
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported JWT signing algorithm");
  const jwk = keys.get(header.kid);
  if (!jwk) throw new Error("Unknown JWT key");
  const signed = `${parts[0]}.${parts[1]}`;
  const signature = decodeBase64UrlBytes(parts[2]);
  const valid = verify("RSA-SHA256", Buffer.from(signed), createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" }), signature);
  if (!valid) throw new Error("Invalid JWT signature");

  const now = Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new Error("JWT is expired");
  if (typeof claims.iat !== "number" || claims.iat - skew > now) throw new Error("JWT issued-at claim is missing or invalid");
  if (claims.iss !== options.issuer) throw new Error("JWT issuer mismatch");
  if (!audienceContains(claims.aud, options.audience)) throw new Error("JWT audience mismatch");
  if (typeof claims.enterprise_id !== "string" || !Array.isArray(claims.roles)) throw new Error("JWT required claims are missing");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new Error("JWT is not active");
  const userId = typeof claims.user_id === "string" ? claims.user_id : typeof claims.sub === "string" ? claims.sub : "";
  if (!userId || typeof claims.tenant_id !== "string" || !claims.tenant_id.trim()) throw new Error("JWT identity claims are missing");
  const caller: AuthenticatedCaller = {
    callerId: userId,
    userId,
    tenantId: claims.tenant_id,
    roles: Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string") : [],
    claims,
  };
  Object.defineProperty(caller, "accessToken", { value: token, enumerable: false });
  return caller;
}

function audienceContains(audience: JwtClaims["aud"], expected: string): boolean {
  return audience === expected || (Array.isArray(audience) && audience.includes(expected));
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function decodeBase64UrlBytes(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
