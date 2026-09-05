import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, parseAgentEnvFile } from "./config.js";
import { createJwtAuthenticator, type JwtJwk } from "./http/auth.js";
import { ragMcpUrl } from "./pi/rag-mcp.js";

test("Agent config parses comments, export syntax, and quoted JSON", () => {
  const values = parseAgentEnvFile(`\n# comment\nexport AITEAM_ENV=production\nAITEAM_MANAGER_URL="https://manager.example.test/api"\nAITEAM_AGENT_JWKS_JSON='{"keys": [{"kty":"RSA"}]}'\n`);
  assert.deepEqual(values, {
    AITEAM_ENV: "production",
    AITEAM_MANAGER_URL: "https://manager.example.test/api",
    AITEAM_AGENT_JWKS_JSON: '{"keys": [{"kty":"RSA"}]}',
  });
});

test("Agent config does not override values supplied by the host process", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-agent-config-"));
  const filename = join(root, "agent.env");
  writeFileSync(filename, "AITEAM_ENV=production\nPORT=8180\nAITEAM_AGENT_JWKS_PATH=keys/jwks.json\n");
  const env: NodeJS.ProcessEnv = { AITEAM_CONFIG_FILE: filename, AITEAM_ENV: "test" };
  loadAgentConfig(env);
  assert.equal(env.AITEAM_ENV, "test");
  assert.equal(env.PORT, "8180");
  assert.equal(env.AITEAM_AGENT_JWKS_PATH, join(root, "keys", "jwks.json"));
});

test("installed config resolves its copied public JWKS and rotation requires authenticator restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-public-config-"));
  const packaged = join(root, "package-config");
  const installed = join(root, "client-data");
  mkdirSync(packaged); mkdirSync(installed);
  const current = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = (pair: typeof current, kid: string) => ({ ...pair.publicKey.export({ format: "jwk" }), kty: "RSA", kid, alg: "RS256", use: "sig" });
  const issuer = "https://manager.example.test/issuer/";
  const audience = "aiteam-agent";
  writeFileSync(join(packaged, "agent.env"), `AITEAM_MANAGER_URL=https://manager.example.test\nAITEAM_AGENT_JWT_ISSUER=${issuer}\nAITEAM_AGENT_JWT_AUDIENCE=${audience}\nAITEAM_AGENT_JWKS_PATH=manager-jwks.json\nAITEAM_RAG_MCP_URL=https://manager.example.test/api/manager/rag/mcp\n`);
  writeFileSync(join(packaged, "manager-jwks.json"), JSON.stringify({ keys: [jwk(current, "current")] }));
  try {
    for (const file of ["agent.env", "manager-jwks.json"]) cpSync(join(packaged, file), join(installed, file));
    const env: NodeJS.ProcessEnv = { AITEAM_CONFIG_FILE: join(installed, "agent.env") };
    loadAgentConfig(env);
    assert.equal(env.AITEAM_AGENT_JWKS_PATH, join(installed, "manager-jwks.json"));
    const load = () => createJwtAuthenticator({ jwks: JSON.parse(readFileSync(env.AITEAM_AGENT_JWKS_PATH!, "utf8")) as { keys: JwtJwk[] }, issuer: env.AITEAM_AGENT_JWT_ISSUER!, audience: env.AITEAM_AGENT_JWT_AUDIENCE! });
    const request = (pair: typeof current, kid: string, iss = issuer, aud = audience) => {
      const now = Math.floor(Date.now() / 1000);
      const signed = [ { alg: "RS256", kid }, { iss, aud, enterprise_id: "e1", tenant_id: "t1", user_id: "m1", roles: ["member"], iat: now, exp: now + 60 } ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      return { headers: { authorization: `Bearer ${signed}.${sign("RSA-SHA256", Buffer.from(signed), pair.privateKey).toString("base64url")}` } } as never;
    };
    const running = load();
    assert.equal((await running(request(current, "current"))).tenantId, "t1");
    await assert.rejects(async () => running(request(current, "current", issuer.slice(0, -1))), /issuer mismatch/);
    await assert.rejects(async () => running(request(current, "current", issuer, "other")), /audience mismatch/);
    writeFileSync(env.AITEAM_AGENT_JWKS_PATH!, JSON.stringify({ keys: [jwk(current, "current"), jwk(next, "next")] }));
    await assert.rejects(async () => running(request(next, "next")), /Unknown JWT key/);
    const restarted = load();
    assert.equal((await restarted(request(next, "next"))).tenantId, "t1");
    assert.equal((await restarted(request(current, "current"))).tenantId, "t1");
    assert.doesNotMatch(readFileSync(env.AITEAM_AGENT_JWKS_PATH!, "utf8"), /"d"|PRIVATE KEY/);
    const previous = process.env.AITEAM_RAG_MCP_URL;
    try {
      process.env.AITEAM_RAG_MCP_URL = env.AITEAM_RAG_MCP_URL;
      assert.equal(ragMcpUrl(env.AITEAM_MANAGER_URL), env.AITEAM_RAG_MCP_URL);
      assert.equal(ragMcpUrl("https://untrusted.example.test"), undefined);
    } finally { if (previous === undefined) delete process.env.AITEAM_RAG_MCP_URL; else process.env.AITEAM_RAG_MCP_URL = previous; }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Agent config rejects malformed and duplicate assignments", () => {
  assert.throws(() => parseAgentEnvFile("AITEAM_ENV"), /KEY=VALUE/);
  assert.throws(() => parseAgentEnvFile("AITEAM_ENV=dev\nAITEAM_ENV=test"), /more than once/);
  assert.throws(() => parseAgentEnvFile('AITEAM_ENV="dev'), /unterminated/);
});
