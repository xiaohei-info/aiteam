import type { Credential, CredentialInfo, CredentialStore, Model, Api } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModelRuntime {
  runtime: ModelRuntime;
  model?: Model<any>;
  mode: "provider" | "faux";
}

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Credential>();
  async read(providerId: string): Promise<Credential | undefined> { return this.values.get(providerId); }
  async list(): Promise<readonly CredentialInfo[]> { return [...this.values.entries()].map(([providerId, credential]) => ({ providerId, type: credential.type })); }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const next = await fn(this.values.get(providerId));
    if (next) this.values.set(providerId, next);
    return next;
  }
  async delete(providerId: string): Promise<void> { this.values.delete(providerId); }
}

export interface RuntimePricingSnapshot {
  pricing_version: number;
  pricing_status: "known" | "unknown";
  billing_mode: "token" | "request";
  input_usd_per_million: string | null;
  output_usd_per_million: string | null;
  cache_read_usd_per_million: string | null;
  cache_write_usd_per_million: string | null;
  request_usd: string | null;
  currency: "USD";
  effective_from: string;
}

export interface RuntimeProviderConfig {
  base_url: string;
  api_protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  api_key: string;
  model: string;
  provider_ref: string;
  provider_version: number;
  model_version: number;
  pricing: RuntimePricingSnapshot;
  version: number;
}

/** Register one Manager-authorized provider in memory and bind its runtime key. */
export async function registerRuntimeProvider(runtime: ModelRuntime, config: RuntimeProviderConfig, providerId: string): Promise<Model<any>> {
  if (!config.base_url || !config.api_key || !config.model || !config.provider_ref) throw new Error("Manager runtime provider config is incomplete");
  try {
    runtime.registerProvider(providerId, {
      name: config.provider_ref,
      baseUrl: config.base_url,
      api: config.api_protocol as Api,
      authHeader: true,
      models: [{
        id: config.model,
        name: config.model,
        api: config.api_protocol as Api,
        reasoning: true,
        input: ["text"],
        cost: {
          input: Number(config.pricing.input_usd_per_million ?? 0),
          output: Number(config.pricing.output_usd_per_million ?? 0),
          cacheRead: Number(config.pricing.cache_read_usd_per_million ?? 0),
          cacheWrite: Number(config.pricing.cache_write_usd_per_million ?? 0),
        },
        contextWindow: 128_000,
        maxTokens: 32_768,
      }],
    });
    await runtime.setRuntimeApiKey(providerId, config.api_key);
    const model = runtime.getModel(providerId, config.model);
    if (!model) throw new Error(`Manager runtime model is unavailable: ${config.model}`);
    return model;
  } catch (error) {
    await runtime.removeRuntimeApiKey(providerId).catch(() => undefined);
    try { runtime.unregisterProvider(providerId); } catch { /* preserve the registration error */ }
    throw error;
  }
}

export async function createConfiguredModelRuntime(options: {
  useFaux?: boolean;
  modelId?: string;
}): Promise<ConfiguredModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials: new MemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  if (options.useFaux) {
    const faux = fauxProvider({
      api: "aiteam-dev-faux-api",
      provider: "aiteam-dev-faux",
      models: [{ id: options.modelId ?? "aiteam-dev-faux-1", name: "AI Team Development Faux" }],
    });
    runtime.registerNativeProvider(faux.provider);
    // E2E runs share one local faux runtime across tier smoke and cross-tier
    // projects. Keep a bounded response queue so later prompts do not fail just
    // because an earlier test consumed the single seed response.
    faux.setResponses(Array.from({ length: 256 }, () => fauxAssistantMessage("AI Team Pi Agent development response")));
    return { runtime, model: faux.getModel(), mode: "faux" };
  }
  return { runtime, mode: "provider" };
}
