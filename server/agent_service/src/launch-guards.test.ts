import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAgentLaunchConfiguration } from "./launch-guards.js";

const production = {
  AITEAM_ENV: "production",
  AITEAM_AGENT_SANDBOX_READY: "true",
  AITEAM_MANAGER_URL: "https://manager.example.test",
  AITEAM_AGENT_JWT_ISSUER: "https://manager.example.test",
  AITEAM_AGENT_JWT_AUDIENCE: "aiteam-agent",
  AITEAM_AGENT_JWKS_JSON: JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", kid: "manager:1", n: "n", e: "AQAB" }] }),
} as NodeJS.ProcessEnv;

test("production launch configuration requires native sandbox readiness and identity settings", () => {
  const result = assertAgentLaunchConfiguration(production);
  assert.equal(result.environment, "production");
  assert.equal(result.useFauxModel, false);
  assert.equal(result.useDevAuth, false);

  for (const [name, message] of [
    ["AITEAM_ENV", /AITEAM_ENV is required/],
    ["AITEAM_AGENT_SANDBOX_READY", /SANDBOX_READY=true/],
    ["AITEAM_MANAGER_URL", /MANAGER_URL is required/],
    ["AITEAM_AGENT_JWT_ISSUER", /JWT_ISSUER is required/],
    ["AITEAM_AGENT_JWT_AUDIENCE", /JWT_AUDIENCE is required/],
    ["AITEAM_AGENT_JWKS_JSON", /JWT JWKS is required/],
  ] as const) {
    const invalid = { ...production };
    delete invalid[name];
    assert.throws(() => assertAgentLaunchConfiguration(invalid), message);
  }
});

test("production rejects faux runtime, development auth, and malformed Manager URL", () => {
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_PI_FAKE: "TRUE" }), /PI_FAKE=true/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_DEV_AUTH: "true" }), /DEV_AUTH=true/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_MANAGER_URL: "manager.internal" }), /absolute http\(s\) URL/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_MANAGER_URL: "https://user:password@manager.example.test" }), /embedded credentials/);
});

test("Agent rejects ambient Manager-only credentials instead of inheriting them", () => {
  for (const name of ["LIGHTRAG_API_KEY", "HINDSIGHT_SERVICE_TOKEN", "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY"] as const) {
    assert.throws(() => assertAgentLaunchConfiguration({ ...production, [name]: "secret" }), new RegExp(`must not receive ${name}`));
  }
});

test("desktop local-only mode rejects a non-loopback bind address", () => {
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_LOCAL_ONLY: "true", HOST: "0.0.0.0" }), /loopback/);
  assert.equal(assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_LOCAL_ONLY: "true", HOST: "127.0.0.1" }).environment, "production");
});

test("unsupported or unset environment does not silently become development", () => {
  assert.throws(() => assertAgentLaunchConfiguration({}), /AITEAM_ENV is required/);
  assert.throws(() => assertAgentLaunchConfiguration({ AITEAM_ENV: "staging" }), /AITEAM_ENV must be one of/);
  assert.equal(assertAgentLaunchConfiguration({ AITEAM_ENV: "dev", AITEAM_PI_FAKE: "true", AITEAM_AGENT_DEV_AUTH: "true" }).environment, "dev");
});
