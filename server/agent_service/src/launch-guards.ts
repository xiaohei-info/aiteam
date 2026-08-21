export interface AgentLaunchConfiguration {
  environment: "development" | "dev" | "test" | "production";
  useFauxModel: boolean;
  useDevAuth: boolean;
}

const ENVIRONMENTS = new Set<AgentLaunchConfiguration["environment"]>(["development", "dev", "test", "production"]);
const FORBIDDEN_AGENT_CREDENTIALS = [
  "LIGHTRAG_API_KEY", "LIGHTRAG_DB_PASSWORD", "LIGHTRAG_DB_ADMIN_PASSWORD",
  "HINDSIGHT_SERVICE_TOKEN", "HINDSIGHT_API_TOKEN", "HINDSIGHT_API_KEY", "HINDSIGHT_API_KEY_REF",
  "AITEAM_SKILL_SIGNING_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY",
] as const;

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireAbsoluteHttpUrl(env: NodeJS.ProcessEnv, name: string): void {
  const value = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an absolute http(s) URL`);
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
  for (const name of FORBIDDEN_AGENT_CREDENTIALS) {
    if (env[name]?.trim()) throw new Error(`Agent must not receive ${name}`);
  }

  if (environment !== "production") return { environment, useFauxModel, useDevAuth };

  if (useFauxModel) throw new Error("AITEAM_PI_FAKE=true is forbidden in production");
  if (useDevAuth) throw new Error("AITEAM_AGENT_DEV_AUTH=true is forbidden in production");
  if (!isTrue(env.AITEAM_AGENT_SANDBOX_READY)) throw new Error("AITEAM_AGENT_SANDBOX_READY=true is required in production");
  requireAbsoluteHttpUrl(env, "AITEAM_MANAGER_URL");
  required(env, "AITEAM_AGENT_JWT_ISSUER");
  required(env, "AITEAM_AGENT_JWT_AUDIENCE");
  const rawJwks = env.AITEAM_AGENT_JWKS_JSON?.trim();
  const jwksPath = env.AITEAM_AGENT_JWKS_PATH?.trim();
  if (!rawJwks && !jwksPath) throw new Error("Production Agent JWT JWKS is required (set AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH)");

  return { environment, useFauxModel, useDevAuth };
}
