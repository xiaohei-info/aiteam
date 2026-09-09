export interface AgentLaunchConfiguration {
  environment: "development" | "dev" | "test" | "production";
  useFauxModel: boolean;
  useDevAuth: boolean;
}

const ENVIRONMENTS = new Set<AgentLaunchConfiguration["environment"]>(["development", "dev", "test", "production"]);
const FORBIDDEN_AGENT_CREDENTIALS = [
  "AITEAM_CONSOLE_CREDENTIALS_FILE", "MANAGER_CREDENTIAL_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_KEYFILE_JSON", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AZURE_CONFIG_DIR", "CLOUDSDK_CONFIG", "BOTO_CONFIG", "KUBECONFIG", "DOCKER_AUTH_CONFIG", "GIT_ASKPASS", "SSH_AUTH_SOCK", "NPM_CONFIG_USERCONFIG",
  "DB_URL", "ADMIN_DB_URL", "DATABASE_URL", "DATABASE_URI", "DATABASE_DSN", "DATABASE_CONNECTION_STRING", "TEST_DATABASE_URL", "DSN", "SQL_DSN", "CONNECTION_STRING", "DB_URI", "DB_DSN", "DB_CONNECTION_STRING", "REDIS_URL", "REDIS_URI", "REDIS_DSN", "REDIS_CONNECTION_STRING", "MYSQL_URL", "MYSQL_URI", "MYSQL_DSN", "MYSQL_CONNECTION_STRING", "MONGO_URL", "MONGO_URI", "MONGO_DSN", "MONGO_CONNECTION_STRING", "POSTGRES_URL", "POSTGRES_URI", "POSTGRES_DSN", "POSTGRES_CONNECTION_STRING", "REDIS_CONN_STRING", "PROVIDER_URL", "PROVIDER_URI", "PROVIDER_API_KEY", "PROVIDER_TOKEN", "PROVIDER_SECRET", "MODEL_PRICING_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "PERPLEXITY_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "NEWAPI_BASE_URL", "NEWAPI_PUBLIC_BASE_URL", "NEWAPI_API_KEY", "NEWAPI_TOKEN", "OPERATION_URL", "OPERATION_API_KEY", "OPERATOR_URL", "AITEAM_OPERATOR_URL", "MANAGER_BASE_URL", "MANAGER_API_KEY", "API_KEY", "PASSWORD", "PASSWD", "DB_PASSWORD", "DATABASE_PASSWORD", "REDIS_PASSWORD", "MYSQL_PASSWORD", "MONGO_PASSWORD", "NEWAPI_PASSWORD", "SERVICE_PASSWORD", "PROVIDER_PASSWORD", "HINDSIGHT_PASSWORD", "LIGHTRAG_PASSWORD", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GITHUB_CLIENT_SECRET", "LOGIN_AUDIT_PEPPER", "SESSION_SECRET", "CRYPTO_SECRET", "APP_RW_PASSWORD", "POSTGRES_PASSWORD", "POSTGRES_SUPER_PASSWORD", "SERVICE_TOKEN", "SERVICE_SECRET", "SERVICE_API_KEY", "SERVICE_APIKEY",
  "NEWAPI_ADMIN_USERNAME", "NEWAPI_ADMIN_PASSWORD", "NEWAPI_ADMIN_USER_ID", "NEWAPI_ADMIN_TOKEN", "NEWAPI_DB_PASSWORD", "NEWAPI_REDIS_PASSWORD", "NEWAPI_SESSION_SECRET", "NEWAPI_CRYPTO_SECRET",
  "OPERATION_SYSTEM_USERNAME", "OPERATION_SYSTEM_PASSWORD", "OPERATION_SIGNING_PRIVATE_KEY", "OPERATION_PROVIDER_CREDENTIAL_KEY",
  "LIGHTRAG_INSTANCES", "LIGHTRAG_AUTH_ACCOUNTS", "LIGHTRAG_TOKEN_SECRET", "LIGHTRAG_API_KEY",
  "LIGHTRAG_URL", "LIGHTRAG_WORKSPACE", "LIGHTRAG_DB_HOST", "LIGHTRAG_DB_PORT", "LIGHTRAG_DB_NAME", "LIGHTRAG_DB_USER", "LIGHTRAG_DB_PASSWORD", "LIGHTRAG_DB_ADMIN_USER", "LIGHTRAG_DB_ADMIN_PASSWORD",
  "AITEAM_HINDSIGHT_URL", "HINDSIGHT_URL", "HINDSIGHT_BASE_URL", "HINDSIGHT_FACADE_URL", "HINDSIGHT_RECALL_PATH", "HINDSIGHT_RETAIN_PATH", "HINDSIGHT_DELETE_PATH", "HINDSIGHT_UPDATE_PATH", "HINDSIGHT_LIST_PATH", "HINDSIGHT_STATS_PATH", "HINDSIGHT_LEASE_TTL_SECONDS", "HINDSIGHT_SERVICE_TOKEN", "HINDSIGHT_API_TOKEN", "HINDSIGHT_API_KEY", "HINDSIGHT_API_KEY_REF", "HINDSIGHT_CP_ACCESS_KEY",
  "AUTH_ACCOUNTS", "TOKEN_SECRET", "LIGHTRAG_ADMIN_USERNAME", "LIGHTRAG_ADMIN_PASSWORD",
  "AITEAM_SKILL_SIGNING_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY",
] as const;

const FORBIDDEN_AGENT_CREDENTIAL_SET = new Set<string>(FORBIDDEN_AGENT_CREDENTIALS);
const SAFE_AGENT_URLS = new Set(["AITEAM_MANAGER_URL", "AITEAM_RAG_MCP_URL", "AITEAM_AGENT_JWKS_PATH", "AITEAM_CONFIG_FILE"]);

/** Shared case-insensitive credential-name policy for every Agent launch path. */
export function isForbiddenAgentEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SAFE_AGENT_URLS.has(upper)) return false;
  if (FORBIDDEN_AGENT_CREDENTIAL_SET.has(upper)) return true;
  if (/(?:^|_)(?:API_KEY|APIKEY|PASSWORD|PASSWD|TOKEN|SECRET|SECRET_KEY|ENCRYPTION_KEY|MASTER_KEY|PEPPER|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|CREDENTIAL|CREDENTIALS|CREDENTIAL_PATH|CREDENTIALS_FILE|CREDENTIAL_FILE|KEY_FILE|KEYFILE)$/u.test(upper)) return true;
  if (/(?:^|_)(?:URL|URI|DSN|CONNECTION_STRING|KEY_PATH|PATH)$/u.test(upper)) return true;
  return false;
}

/** Remove inherited/configured control-plane credentials before Agent startup. */
export function scrubAgentEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (isForbiddenAgentEnvironmentName(key)) delete env[key];
  }
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireAbsoluteHttpUrl(env: NodeJS.ProcessEnv, name: string, httpsOnly = false): URL {
  const value = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an absolute http(s) URL`);
  if (httpsOnly && parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain embedded credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${name} must not contain query or fragment`);
  return parsed;
}

/** Validate settings that must be true before the Agent can bind a production port. */
export function assertAgentLaunchConfiguration(env: NodeJS.ProcessEnv = process.env): AgentLaunchConfiguration {
  const rawEnvironment = required(env, "AITEAM_ENV");
  if (!ENVIRONMENTS.has(rawEnvironment as AgentLaunchConfiguration["environment"])) {
    throw new Error(`AITEAM_ENV must be one of development, dev, test, production (got ${rawEnvironment})`);
  }
  const environment = rawEnvironment as AgentLaunchConfiguration["environment"];
  const useFauxModel = isTrue(env.AITEAM_PI_FAKE);
  const useDevAuth = isTrue(env.AITEAM_AGENT_DEV_AUTH);
  for (const [name, value] of Object.entries(env)) {
    if (value?.trim() && isForbiddenAgentEnvironmentName(name)) {
      throw new Error(`Agent must not receive ${name}`);
    }
  }

  if (environment !== "production") return { environment, useFauxModel, useDevAuth };

  if (useFauxModel) throw new Error("AITEAM_PI_FAKE=true is forbidden in production");
  if (useDevAuth) throw new Error("AITEAM_AGENT_DEV_AUTH=true is forbidden in production");
  if (!isTrue(env.AITEAM_AGENT_SANDBOX_READY)) throw new Error("AITEAM_AGENT_SANDBOX_READY=true is required in production");
  if (!isTrue(env.AITEAM_AGENT_LOCAL_ONLY)) throw new Error("AITEAM_AGENT_LOCAL_ONLY=true is required in production");
  const host = (env.HOST ?? "127.0.0.1").trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("AITEAM_AGENT_LOCAL_ONLY=true requires HOST to be a loopback address");
  const managerValue = required(env, "AITEAM_MANAGER_URL");
  const issuerValue = required(env, "AITEAM_AGENT_JWT_ISSUER");
  requireAbsoluteHttpUrl(env, "AITEAM_MANAGER_URL", true);
  requireAbsoluteHttpUrl(env, "AITEAM_AGENT_JWT_ISSUER", true);
  if (managerValue !== issuerValue) throw new Error("AITEAM_AGENT_JWT_ISSUER must exactly match AITEAM_MANAGER_URL in production");
  required(env, "AITEAM_AGENT_JWT_AUDIENCE");
  const rawJwks = env.AITEAM_AGENT_JWKS_JSON?.trim();
  const jwksPath = env.AITEAM_AGENT_JWKS_PATH?.trim();
  if (!rawJwks && !jwksPath) throw new Error("Production Agent JWT JWKS is required (set AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH)");
  if (rawJwks && jwksPath) throw new Error("Production Agent JWT config must set exactly one of AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH");

  return { environment, useFauxModel, useDevAuth };
}
