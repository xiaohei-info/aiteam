import { fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModelRuntime {
  runtime: ModelRuntime;
  model: Model<any>;
  mode: "provider" | "faux";
}

export async function createConfiguredModelRuntime(options: {
  agentDir: string;
  useFaux?: boolean;
  modelId?: string;
}): Promise<ConfiguredModelRuntime> {
  if (options.useFaux) {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({
      api: "aiteam-dev-faux-api",
      provider: "aiteam-dev-faux",
      models: [{ id: options.modelId ?? "aiteam-dev-faux-1", name: "AI Team Development Faux" }],
    });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("AI Team Pi Agent development response")]);
    return { runtime, model: faux.getModel(), mode: "faux" };
  }

  const runtime = await ModelRuntime.create({
    authPath: `${options.agentDir}/auth.json`,
    modelsPath: `${options.agentDir}/models.json`,
    refreshOnCreate: false,
  });
  const available = await runtime.getAvailable();
  const model = options.modelId
    ? available.find((candidate) => candidate.id === options.modelId)
    : available[0];
  if (!model) throw new Error(options.modelId ? `Configured Pi model is unavailable: ${options.modelId}` : "No authenticated Pi model is configured");
  return { runtime, model, mode: "provider" };
}
