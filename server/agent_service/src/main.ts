import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentHttpServer, HttpProblem } from "./http/server.js";
import { createControlledResourceLoader } from "./pi/resources.js";
import { SessionHost } from "./pi/session-host.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

const dataRoot = process.env.AITEAM_AGENT_DATA_DIR ?? join(process.cwd(), ".data");
const port = Number(process.env.PORT ?? 8000);
const hostAddress = process.env.HOST ?? "127.0.0.1";
const useFakeModel = process.env.AITEAM_PI_FAKE === "true";
const useDevAuth = process.env.AITEAM_AGENT_DEV_AUTH === "true";

if (!useDevAuth) {
  throw new Error("Agent HTTP auth is not configured; set AITEAM_AGENT_DEV_AUTH=true only for local development");
}
if (process.env.AITEAM_ENV === "production" && useFakeModel) {
  throw new Error("AITEAM_PI_FAKE=true is forbidden in production");
}

mkdirSync(dataRoot, { recursive: true });
const agentDir = join(dataRoot, "pi");
const cwdRoot = join(dataRoot, "workspaces");
const sessionDir = join(dataRoot, "sessions");
const store = new AgentSqliteStore(join(dataRoot, "agent.sqlite"));
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  refreshOnCreate: false,
});

let model;
if (useFakeModel) {
  const faux = fauxProvider({
    api: "aiteam-dev-faux-api",
    provider: "aiteam-dev-faux",
    models: [{ id: "aiteam-dev-faux-1", name: "AI Team Development Faux" }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("AI Team Pi Agent development response")]);
  model = faux.getModel();
} else {
  const available = await modelRuntime.getAvailable();
  model = available[0];
  if (!model) throw new Error("No authenticated Pi model is configured");
}

const sessionHost = new SessionHost({
  cwdRoot,
  agentDir,
  sessionDir,
  store,
  modelRuntime,
  model,
  resourceLoaderFactory: () => createControlledResourceLoader("You are an AI Team digital employee. Be concise."),
});
const http = new AgentHttpServer({
  host: sessionHost,
  store,
  authenticate: (request) => {
    const authorization = request.headers.authorization;
    if (authorization !== "Bearer local-development") {
      throw new HttpProblem(401, "unauthenticated", "Use the local development bearer token");
    }
    return { callerId: "local-development" };
  },
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
