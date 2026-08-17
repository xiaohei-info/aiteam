import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentHttpServer, HttpProblem } from "./http/server.js";
import { createJwtAuthenticator, type JwtJwk } from "./http/auth.js";
import { createControlledResourceLoader } from "./pi/resources.js";
import { createConfiguredModelRuntime } from "./pi/model-runtime.js";
import { SessionHost, type SessionAuthorization } from "./pi/session-host.js";
import { AgentSqliteStore } from "./storage/sqlite.js";
import { HttpManagerClient } from "./manager-client.js";

const dataRoot = process.env.AITEAM_AGENT_DATA_DIR ?? join(process.cwd(), ".data");
const port = Number(process.env.PORT ?? 8000);
const hostAddress = process.env.HOST ?? "127.0.0.1";
const environment = process.env.AITEAM_ENV ?? "development";
const useFauxModel = process.env.AITEAM_PI_FAKE === "true";
const useDevAuth = process.env.AITEAM_AGENT_DEV_AUTH === "true";

if (environment === "production" && useFauxModel) throw new Error("AITEAM_PI_FAKE=true is forbidden in production");
if (environment === "production" && useDevAuth) throw new Error("AITEAM_AGENT_DEV_AUTH=true is forbidden in production");

mkdirSync(dataRoot, { recursive: true });
const agentDir = join(dataRoot, "pi");
const cwdRoot = join(dataRoot, "workspaces");
const sessionDir = join(dataRoot, "sessions");
const store = new AgentSqliteStore(join(dataRoot, "agent.sqlite"));
const configured = await createConfiguredModelRuntime({ agentDir, useFaux: useFauxModel, modelId: process.env.AITEAM_PI_MODEL });

const managerClient = process.env.AITEAM_MANAGER_URL ? new HttpManagerClient(process.env.AITEAM_MANAGER_URL) : undefined;
const sessionHost = new SessionHost({
  cwdRoot,
  agentDir,
  sessionDir,
  store,
  modelRuntime: configured.runtime,
  model: configured.model,
  managerClient,
  resourceLoaderFactory: (_conversationId, authorization?: SessionAuthorization) => createControlledResourceLoader(snapshotSystemPrompt(authorization)),
});

const authenticate = useDevAuth
  ? (request: import("node:http").IncomingMessage) => {
      if (request.headers.authorization !== "Bearer local-development") throw new HttpProblem(401, "unauthenticated", "Invalid development bearer token");
      return { callerId: "local-development", userId: "local-development", roles: ["member"] };
    }
  : createJwtAuthenticator(loadJwtOptions());

const http = new AgentHttpServer({
  host: sessionHost,
  store,
  authenticate,
  managerClient,
  runtimeReady: () => configured.runtime.getAvailableSnapshot().length > 0,
});

await http.listen(port, hostAddress);
console.log(`AI Team Node Agent listening on http://${hostAddress}:${port}`);

const shutdown = async () => {
  await http.close().catch(() => undefined);
  await sessionHost.dispose();
  store.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function snapshotSystemPrompt(authorization?: SessionAuthorization): string {
  if (!authorization) return "You are an AI Team digital employee. Be concise.";
  const snapshot = authorization.snapshot;
  const persona = typeof snapshot.persona === "string" ? snapshot.persona : "You are an AI Team digital employee.";
  const skills = Array.isArray(snapshot.skill_refs) ? snapshot.skill_refs.filter((value): value is string => typeof value === "string") : [];
  return [persona, "Use only the tools authorized by the current employee snapshot.", skills.length ? `Authorized skill references: ${skills.join(", ")}` : ""].filter(Boolean).join("\n\n");
}

function loadJwtOptions() {
  const raw = process.env.AITEAM_AGENT_JWKS_JSON ?? (process.env.AITEAM_AGENT_JWKS_PATH ? readFileSync(process.env.AITEAM_AGENT_JWKS_PATH, "utf8") : undefined);
  if (!raw) throw new Error("Agent JWT auth is not configured; set AITEAM_AGENT_JWKS_JSON or AITEAM_AGENT_JWKS_PATH");
  let jwks: { keys: JwtJwk[] };
  try {
    jwks = JSON.parse(raw) as { keys: JwtJwk[] };
  } catch {
    throw new Error("AITEAM_AGENT_JWKS_JSON must be valid JSON");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error("Agent JWKS must contain at least one key");
  return { jwks, issuer: process.env.AITEAM_AGENT_JWT_ISSUER, audience: process.env.AITEAM_AGENT_JWT_AUDIENCE };
}
