import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAgentLaunchConfiguration, scrubAgentEnvironment } from "./launch-guards.js";

const production = {
  AITEAM_ENV: "production",
  AITEAM_AGENT_SANDBOX_READY: "true",
  AITEAM_MANAGER_URL: "https://manager.example.test",
  AITEAM_AGENT_JWT_ISSUER: "https://manager.example.test",
  AITEAM_AGENT_JWT_AUDIENCE: "aiteam-agent",
  AITEAM_AGENT_JWKS_JSON: JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", kid: "manager:1", n: "n", e: "AQAB" }] }),
  AITEAM_AGENT_LOCAL_ONLY: "true",
  HOST: "127.0.0.1",
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
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_MANAGER_URL: "https://manager.example.test/?legacy=1" }), /query or fragment/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_JWT_ISSUER: "https://manager.example.test/#legacy" }), /query or fragment/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_JWKS_PATH: "manager-jwks.json" }), /exactly one/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_MANAGER_URL: "http://manager.example.test" }), /must use HTTPS/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_LOCAL_ONLY: undefined }), /LOCAL_ONLY=true is required/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_LOCAL_ONLY: "false" }), /LOCAL_ONLY=true is required/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_JWT_ISSUER: "http://manager.example.test" }), /must use HTTPS/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_MANAGER_URL: "https://other.example.test" }), /must exactly match AITEAM_MANAGER_URL/);
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, AITEAM_AGENT_JWT_ISSUER: "https://manager.example.test/issuer" }), /must exactly match AITEAM_MANAGER_URL/);
});

test("Agent rejects ambient Manager-only credentials instead of inheriting them", () => {
  for (const name of [
    "AITEAM_CONSOLE_CREDENTIALS_FILE", "MANAGER_CREDENTIAL_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG", "DB_URL", "ADMIN_DB_URL", "DATABASE_URL", "DATABASE_URI", "DATABASE_DSN", "DATABASE_CONNECTION_STRING", "TEST_DATABASE_URL", "DSN", "SQL_DSN", "CONNECTION_STRING", "DB_URI", "DB_DSN", "DB_CONNECTION_STRING", "REDIS_URL", "REDIS_URI", "REDIS_DSN", "REDIS_CONNECTION_STRING", "MYSQL_URL", "MYSQL_URI", "MYSQL_DSN", "MYSQL_CONNECTION_STRING", "MONGO_URL", "MONGO_URI", "MONGO_DSN", "MONGO_CONNECTION_STRING", "POSTGRES_URL", "POSTGRES_URI", "POSTGRES_DSN", "POSTGRES_CONNECTION_STRING", "PROVIDER_URL", "PROVIDER_URI", "PROVIDER_API_KEY", "PROVIDER_TOKEN", "PROVIDER_SECRET", "MODEL_PRICING_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "PERPLEXITY_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "NEWAPI_BASE_URL", "NEWAPI_PUBLIC_BASE_URL", "NEWAPI_API_KEY", "NEWAPI_TOKEN", "OPERATION_URL", "OPERATION_API_KEY", "OPERATOR_URL", "AITEAM_OPERATOR_URL", "MANAGER_BASE_URL", "MANAGER_API_KEY", "OPERATION_SYSTEM_USERNAME", "OPERATION_SYSTEM_PASSWORD", "APP_RW_PASSWORD", "API_KEY", "PASSWORD", "PASSWD", "DB_PASSWORD", "DATABASE_PASSWORD", "REDIS_PASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "NEWAPI_PASSWORD", "SERVICE_PASSWORD", "PROVIDER_PASSWORD", "HINDSIGHT_PASSWORD", "LIGHTRAG_PASSWORD", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GITHUB_CLIENT_SECRET", "LOGIN_AUDIT_PEPPER", "POSTGRES_PASSWORD", "POSTGRES_SUPER_PASSWORD", "SERVICE_TOKEN", "SERVICE_SECRET", "SERVICE_API_KEY", "SERVICE_APIKEY",
    "AITEAM_HINDSIGHT_URL", "HINDSIGHT_URL", "HINDSIGHT_RECALL_PATH", "NEWAPI_ADMIN_PASSWORD", "NEWAPI_ADMIN_TOKEN", "OPERATION_PROVIDER_CREDENTIAL_KEY",
    "LIGHTRAG_API_KEY", "LIGHTRAG_INSTANCES", "LIGHTRAG_AUTH_ACCOUNTS", "LIGHTRAG_URL", "LIGHTRAG_WORKSPACE",
    "LIGHTRAG_DB_ADMIN_PASSWORD", "LIGHTRAG_ADMIN_PASSWORD", "HINDSIGHT_SERVICE_TOKEN", "HINDSIGHT_CP_ACCESS_KEY",
    "AUTH_ACCOUNTS", "TOKEN_SECRET", "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY", "VENDOR_TOKEN", "PRIVATE_KEY", "SECRET_KEY", "FOO_SECRET_KEY", "ENCRYPTION_KEY", "FOO_API_KEY", "VENDOR_DSN", "CLOUDINARY_URL", "PRIVATE_KEY_PATH", "VENDOR_CREDENTIALS_FILE", "FOO_CREDENTIAL_PATH", "AWS_PROFILE", "vendor_token",
  ] as const) {
    assert.throws(() => assertAgentLaunchConfiguration({ ...production, [name]: "secret" }), new RegExp(`must not receive ${name}`));
  }
});

test("Agent credential policy is case-insensitive and preserves allowed local endpoints", () => {
  const env = { AITEAM_MANAGER_URL: "https://manager.example.test", AITEAM_RAG_MCP_URL: "https://manager.example.test/api/manager/rag/mcp", AITEAM_AGENT_JWKS_PATH: "manager-jwks.json", OPERATOR_URL: "https://user:password@operator.example", vendor_token: "secret", FOO_API_KEY: "secret", PRIVATE_KEY: "secret" } as NodeJS.ProcessEnv;
  assert.throws(() => assertAgentLaunchConfiguration({ ...production, ...env }), /must not receive (OPERATOR_URL|vendor_token)/);
  scrubAgentEnvironment(env);
  assert.equal(env.OPERATOR_URL, undefined);
  assert.equal(env.vendor_token, undefined);
  assert.equal(env.FOO_API_KEY, undefined);
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.AITEAM_MANAGER_URL, "https://manager.example.test");
  assert.equal(env.AITEAM_RAG_MCP_URL, "https://manager.example.test/api/manager/rag/mcp");
  assert.equal(env.AITEAM_AGENT_JWKS_PATH, "manager-jwks.json");
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
