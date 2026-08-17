import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createControlledResourceLoader } from "./pi/resources.js";
import { SessionHost } from "./pi/session-host.js";
import type { ManagerClient } from "./manager-client.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

export async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-agent-test-"));
  const dataRoot = join(root, "data");
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({
    api: "aiteam-test-api",
    provider: "aiteam-test",
    models: [{ id: "aiteam-test-1", name: "AI Team Test" }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const store = new AgentSqliteStore(join(dataRoot, "agent.sqlite"));
  for (const id of ["c1", "conversation-1", "conversation-2"]) {
    store.createConversation({ id, sessionFile: "", workspace: "", tenantId: "tenant-1", memberId: "member-1" });
  }
  const createHost = (model = faux.getModel(), managerClient?: ManagerClient) =>
    new SessionHost({
      cwdRoot: join(dataRoot, "workspaces"),
      agentDir: join(dataRoot, "pi"),
      sessionDir: join(dataRoot, "sessions"),
      store,
      modelRuntime,
      model,
      managerClient,
      resourceLoaderFactory: () => createControlledResourceLoader("test system prompt"),
      sandboxAvailable: () => false,
    });
  const host = createHost();
  return {
    root,
    dataRoot,
    faux,
    modelRuntime,
    host,
    createHost,
    store,
    async close() {
      await host.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
