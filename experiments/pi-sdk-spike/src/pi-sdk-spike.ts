import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERSION = "0.84.2";

function controlledResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are the AI Team Pi SDK spike assistant. Be concise.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

function settings(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiteam-pi-sdk-spike-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(sessionDir);

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });

    const faux = fauxProvider({
      api: "aiteam-faux-api",
      provider: "aiteam-faux",
      models: [{ id: "aiteam-faux-1", name: "AI Team Faux" }],
      tokensPerSecond: 0,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = faux.getModel();

    const probeTool = defineTool({
      name: "probe_tool",
      label: "Probe tool",
      description: "Returns a deterministic probe result.",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: `probe:${params.value}` }],
        details: { value: params.value },
      }),
    });

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe_tool", { value: "ok" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("spike complete"),
    ]);

    const resourceLoader = controlledResourceLoader();
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const sessionResult = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: settings(),
      tools: [probeTool.name],
      customTools: [probeTool],
    });
    const { session } = sessionResult;
    const events: AgentSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.prompt("Run the probe tool.");

    assert.equal(session.isIdle, true, "session settles after prompt");
    assert.equal(sessionResult.extensionsResult.extensions.length, 0, "ambient extensions are disabled");
    assert.equal(resourceLoader.getSkills().skills.length, 0, "ambient skills are disabled");
    assert(events.some((event) => event.type === "tool_execution_start" && event.toolName === "probe_tool"));
    assert(events.some((event) => event.type === "tool_execution_end" && event.toolName === "probe_tool"));
    assert(
      events.some(
        (event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      ),
      "Pi text deltas reach the host",
    );
    assert(events.some((event) => event.type === "agent_settled"), "Pi settled event reaches the host");

    const sessionFile = session.sessionFile;
    assert(sessionFile, "persistent SessionManager writes a JSONL session");
    const firstSessionId = session.sessionId;
    assert(session.messages.some((message) => message.role === "user"));
    assert(session.messages.some((message) => message.role === "assistant"));
    unsubscribe();
    session.dispose();

    const persistedText = readFileSync(sessionFile, "utf8");
    assert.match(persistedText, /"type":"session"/);
    assert.match(persistedText, /"type":"message"/);

    const reopenedManager = SessionManager.open(sessionFile, sessionDir, cwd);
    const reopened = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager: reopenedManager,
      settingsManager: settings(),
      tools: [probeTool.name],
      customTools: [probeTool],
    });
    assert.equal(reopened.session.sessionId, firstSessionId, "SessionManager reopens the same Pi session");
    assert(reopened.session.messages.some((message) => message.role === "assistant"));
    reopened.session.dispose();

    const abortFaux = fauxProvider({
      api: "aiteam-abort-api",
      provider: "aiteam-abort",
      models: [{ id: "aiteam-abort-1", name: "AI Team Abort Faux" }],
      tokensPerSecond: 1,
    });
    modelRuntime.registerNativeProvider(abortFaux.provider);
    abortFaux.setResponses([fauxAssistantMessage("abort-me ".repeat(200))]);
    const abortSessionResult = await createAgentSession({
      cwd,
      agentDir,
      model: abortFaux.getModel(),
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: settings(),
      tools: [],
    });
    const abortEvents: AgentSessionEvent[] = [];
    abortSessionResult.session.subscribe((event) => abortEvents.push(event));
    const pendingPrompt = abortSessionResult.session.prompt("Start a deliberately slow response.");
    await sleep(20);
    await abortSessionResult.session.abort();
    await Promise.allSettled([pendingPrompt]);
    const abortedAssistant = abortEvents.some(
      (event) =>
        (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") ||
        (event.type === "agent_end" &&
          event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")),
    );
    assert(abortedAssistant, `abort event missing; received: ${abortEvents.map((event) => event.type).join(", ")}`);
    assert.equal(abortSessionResult.session.isIdle, true, "abort returns the session to idle");
    abortSessionResult.session.dispose();

    console.log(
      JSON.stringify(
        {
          package: "@earendil-works/pi-coding-agent",
          version: VERSION,
          checks: [
            "controlled-resource-loader",
            "custom-tool-execution",
            "message-update-text-delta",
            "agent-settled",
            "persistent-session-reopen",
            "abort",
          ],
          sessionFile,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
