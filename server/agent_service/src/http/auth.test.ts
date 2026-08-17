import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createJwtAuthenticator } from "./auth.js";

function token(exp = Math.floor(Date.now() / 1000) + 60): { token: string; jwks: { keys: [{ kty: "RSA"; n: string; e: string; kid: string; alg: "RS256" }] } } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "tenant-a:1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "manager", aud: "agent", enterprise_id: "enterprise-a", tenant_id: "tenant-a", user_id: "member-a", roles: ["member"], iat: Math.floor(Date.now() / 1000), exp })).toString("base64url");
  const signed = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
  return { token: `${signed}.${signature}`, jwks: { keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, kid: "tenant-a:1", alg: "RS256" }] } };
}

test("JWT authenticator verifies tenant identity and rejects expiry", async () => {
  const valid = token();
  const authenticate = createJwtAuthenticator({ jwks: valid.jwks, issuer: "manager", audience: "agent" });
  const caller = await authenticate({ headers: { authorization: `Bearer ${valid.token}` } } as never);
  assert.deepEqual(caller, { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"], claims: caller.claims });

  const expired = token(Math.floor(Date.now() / 1000) - 60);
  await assert.rejects(async () => createJwtAuthenticator({ jwks: expired.jwks, issuer: "manager", audience: "agent" })({ headers: { authorization: `Bearer ${expired.token}` } } as never), /expired/);
  assert.throws(() => createJwtAuthenticator({ jwks: valid.jwks } as never), /issuer and audience are required/);
  const wrongAudience = token();
  await assert.rejects(async () => createJwtAuthenticator({ jwks: wrongAudience.jwks, issuer: "manager", audience: "other" })({ headers: { authorization: `Bearer ${wrongAudience.token}` } } as never), /audience mismatch/);
});
