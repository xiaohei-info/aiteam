import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, parseAgentEnvFile } from "./config.js";

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

test("Agent config rejects malformed and duplicate assignments", () => {
  assert.throws(() => parseAgentEnvFile("AITEAM_ENV"), /KEY=VALUE/);
  assert.throws(() => parseAgentEnvFile("AITEAM_ENV=dev\nAITEAM_ENV=test"), /more than once/);
  assert.throws(() => parseAgentEnvFile('AITEAM_ENV="dev'), /unterminated/);
});
