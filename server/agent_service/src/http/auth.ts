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

export interface AuthenticatedCaller {
  callerId: string;
  tenantId?: string;
  userId?: string;
  roles?: string[];
  claims?: JwtClaims;
}

export interface JwtAuthenticatorOptions {
  jwks: { keys: JwtJwk[] };
  issuer?: string;
  audience?: string;
  clockSkewSeconds?: number;
}

export type AuthenticateRequest = (request: IncomingMessage) => AuthenticatedCaller | Promise<AuthenticatedCaller>;

export function createJwtAuthenticator(options: JwtAuthenticatorOptions): AuthenticateRequest {
  const keys = new Map(options.jwks.keys.filter((key) => key.kty === "RSA" && key.alg !== "HS256").map((key) => [key.kid, key]));
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
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new Error("JWT is not active");
  if (options.issuer !== undefined && claims.iss !== options.issuer) throw new Error("JWT issuer mismatch");
  if (options.audience !== undefined && !audienceContains(claims.aud, options.audience)) throw new Error("JWT audience mismatch");

  const userId = typeof claims.user_id === "string" ? claims.user_id : typeof claims.sub === "string" ? claims.sub : "";
  if (!userId || typeof claims.tenant_id !== "string") throw new Error("JWT identity claims are missing");
  return {
    callerId: userId,
    userId,
    tenantId: claims.tenant_id,
    roles: Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string") : [],
    claims,
  };
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
