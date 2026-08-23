import { createPublicKey } from "node:crypto";
import { accessSync, chmodSync, constants, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentHttpServer, HttpProblem } from "./http/server.js";
import { createJwtAuthenticator, type JwtJwk } from "./http/auth.js";
import { createControlledResourceLoader } from "./pi/resources.js";
import { createConfiguredModelRuntime } from "./pi/model-runtime.js";
import { SessionHost, type SessionAuthorization } from "./pi/session-host.js";
import { LocalSandbox } from "./pi/sandbox.js";
import { AgentSqliteStore } from "./storage/sqlite.js";
import { HttpManagerClient } from "./manager-client.js";
import { aggregateUsage } from "./usage.js";
import { UsageFlushService } from "./usage-flush.js";
import { ScheduleService } from "./schedule.js";
import { SkillCache, skillSigningVerificationFromEnv } from "./skills.js";
import { assertAgentLaunchConfiguration } from "./launch-guards.js";

const launchConfiguration = assertAgentLaunchConfiguration();
const dataRoot = resolve(process.env.AITEAM_AGENT_DATA_DIR ?? join(process.cwd(), ".data"));
const port = Number(process.env.PORT ?? 8000);
const hostAddress = process.env.HOST ?? "127.0.0.1";
const environment = launchConfiguration.environment;
const useFauxModel = launchConfiguration.useFauxModel;
const useDevAuth = launchConfiguration.useDevAuth;

if (process.env.AITEAM_SKILL_SIGNING_PRIVATE_KEY || process.env.AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY || process.env.AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY) throw new Error("Agent must not receive Skill signing private key material");
const skillVerification = skillSigningVerificationFromEnv();
if (environment === "production" && !((skillVerification.publicKeys?.length ?? 0) > 0 || (skillVerification.publicKey && skillVerification.keyId))) throw new Error("Production Agent Skill signing public key metadata is required");

mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
chmodSync(dataRoot, 0o700);
const agentDir = join(dataRoot, "pi");
const cwdRoot = join(dataRoot, "workspaces");
const sessionDir = join(dataRoot, "sessions");
const managerUrl = process.env.AITEAM_MANAGER_URL?.trim();
const sandbox = new LocalSandbox();
mkdirSync(cwdRoot, { recursive: true, mode: 0o700 });
if (environment === "production") await sandbox.assertAvailable(cwdRoot);
const skillCache = new SkillCache(join(dataRoot, "capabilities", "skills"), { offlineTtlSeconds: skillVerification.offlineTtlSeconds });
const store = new AgentSqliteStore(join(dataRoot, "agent.sqlite"));
const configured = await createConfiguredModelRuntime({ useFaux: useFauxModel, modelId: process.env.AITEAM_PI_MODEL });

const managerClient = managerUrl ? new HttpManagerClient(managerUrl) : undefined;
const sessionHost = new SessionHost({
  cwdRoot,
  agentDir,
  sessionDir,
  store,
  modelRuntime: configured.runtime,
  model: configured.model,
  useFauxModel,
  managerClient,
  sandbox,
  usageRecorder: (capture) => store.upsertUsageSummary(aggregateUsage(capture)),
  resourceLoaderFactory: (_conversationId, authorization?: SessionAuthorization, workspace?: string, _agentDir?: string, hindsightRuntimeConfig?) => createControlledResourceLoader(snapshotSystemPrompt(authorization), skillCache, authorization, workspace, agentDir, managerUrl, hindsightRuntimeConfig),
});

const authenticate = useDevAuth
  ? (request: import("node:http").IncomingMessage) => authenticateDevelopment(request)
  : createJwtAuthenticator(loadJwtOptions());

const usageFlush = new UsageFlushService(store, managerClient);
const schedule = new ScheduleService(store, sessionHost);
const http = new AgentHttpServer({
  logger: console,
  host: sessionHost,
  store,
  authenticate,
  managerClient,
  usageFlush,
  skillCache,
  localReady: async () => {
    for (const path of [dataRoot, agentDir, cwdRoot, sessionDir]) accessSync(path, constants.R_OK | constants.W_OK);
    return sandbox.isAvailable(cwdRoot);
  },
  runtimeReady: () => configured.runtime.getAvailableSnapshot().length > 0,
  spaRoot: process.env.AITEAM_AGENT_SPA_ROOT ?? join(process.cwd(), "web/agent/dist"),
});

await http.listen(port, hostAddress);
 schedule.start();
console.log(`AI Team Node Agent listening on http://${hostAddress}:${port}`);

const shutdown = async () => {
  await schedule.stop();
  await http.close().catch(() => undefined);
  await usageFlush.close();
  await sessionHost.dispose();
  store.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function authenticateDevelopment(request: import("node:http").IncomingMessage) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpProblem(401, "unauthenticated", "Development bearer token is required");
  const token = header.slice("Bearer ".length);
  if (token === "local-development") {
    return {
      callerId: "local-development",
      userId: process.env.AITEAM_AGENT_DEV_MEMBER ?? "local-development",
      tenantId: process.env.AITEAM_AGENT_DEV_TENANT ?? "local-development",
      roles: ["member"],
    };
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const userId = typeof payload.user_id === "string" ? payload.user_id : typeof payload.sub === "string" ? payload.sub : undefined;
    const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : undefined;
    if (!userId || !tenantId) throw new Error("identity claims missing");
    return {
      callerId: userId,
      userId,
      tenantId,
      roles: Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === "string") : [],
      claims: payload as import("./http/auth.js").JwtClaims,
      accessToken: token,
    };
  } catch {
    throw new HttpProblem(401, "unauthenticated", "Invalid development bearer token");
  }
}

function snapshotSystemPrompt(authorization?: SessionAuthorization): string {
  if (!authorization) return "You are an AI Team digital employee. Be concise.";
  const snapshot = authorization.snapshot;
  const persona = typeof snapshot.persona === "string" ? snapshot.persona : "You are an AI Team digital employee.";
  const skills = Array.isArray(snapshot.skill_refs) ? snapshot.skill_refs.filter((value): value is string => typeof value === "string") : [];
  const policy = snapshot.tool_policy && typeof snapshot.tool_policy === "object" ? snapshot.tool_policy as Record<string, unknown> : undefined;
  const allowedTools = Array.isArray(policy?.allowed_tools) ? policy.allowed_tools : snapshot.tools;
  const todoHint = Array.isArray(allowedTools) && allowedTools.includes("todo_update")
    ? "For multi-step work, keep the user-visible checklist current with todo_update."
    : "";
  return [persona, "Use only the tools authorized by the current employee snapshot.", todoHint, skills.length ? `Authorized skill references: ${skills.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

function loadJwtOptions() {
  const inline = process.env.AITEAM_AGENT_JWKS_JSON?.trim();
  const raw = inline || (process.env.AITEAM_AGENT_JWKS_PATH ? readFileSync(process.env.AITEAM_AGENT_JWKS_PATH, "utf8") : undefined);
  if (!raw) throw new Error("Agent JWT auth is not configured; set AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH");
  let jwks: { keys: JwtJwk[] };
  try {
    jwks = JSON.parse(raw) as { keys: JwtJwk[] };
  } catch {
    throw new Error("AITEAM_AGENT_JWKS_JSON must be valid JSON");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error("Agent JWKS must contain at least one key");
  const usableKeys = jwks.keys.filter((key) => key.kty === "RSA" && key.alg === "RS256" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string");
  if (!usableKeys.length || !usableKeys.every((key) => {
    try {
      createPublicKey({ key: key as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
      return true;
    } catch {
      return false;
    }
  })) throw new Error("Agent JWKS must contain a valid RSA RS256 key with kid, n, and e");
  const issuer = process.env.AITEAM_AGENT_JWT_ISSUER?.trim();
  const audience = process.env.AITEAM_AGENT_JWT_AUDIENCE?.trim();
  if (!issuer || !audience) throw new Error("Agent JWT issuer and audience are required");
  return { jwks, issuer, audience };
}
