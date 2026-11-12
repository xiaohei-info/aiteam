/**
 * 模型装配：把宿主注入的模型配置注册进一个只活在本进程内存里的 Pi ModelRuntime。
 *
 * worker 不发现模型、不读任何本地凭据文件：`modelsPath: null`，凭据只放内存。
 */
import { fauxProvider, type Api, type Credential, type CredentialInfo, type CredentialStore, type FauxResponseStep, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "./protocol.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelHandle {
  runtime: ModelRuntime;
  model: Model<any>;
  supportsImages: boolean;
  thinkingLevel: ThinkingLevel;
}

const PROVIDER_ID = "aiteam-solution-authoring";

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

function createRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new MemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
}

export async function createProviderModelHandle(config: ProviderModelConfig): Promise<ModelHandle> {
  const runtime = await createRuntime();
  runtime.registerProvider(PROVIDER_ID, {
    name: config.provider_ref,
    baseUrl: config.base_url,
    api: config.api_protocol as Api,
    authHeader: true,
    models: [{
      id: config.model_id,
      name: config.model_id,
      api: config.api_protocol as Api,
      reasoning: config.reasoning ?? false,
      input: config.input,
      // 成本由宿主按用量与平台价格核算，这里不参与计价。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.context_window ?? 128_000,
      maxTokens: config.max_tokens ?? 16_384,
    }],
  });
  await runtime.setRuntimeApiKey(PROVIDER_ID, config.api_key);
  const model = runtime.getModel(PROVIDER_ID, config.model_id);
  if (!model) throw new Error("injected model is unavailable after registration");
  return {
    runtime,
    model,
    supportsImages: config.input.includes("image"),
    thinkingLevel: (config.thinking_level as ThinkingLevel | undefined) ?? "off",
  };
}

/** 脚本化的假模型：自动化测试与本机联调用，不发任何网络请求。 */
export async function createFauxModelHandle(input: readonly ("text" | "image")[], responses: FauxResponseStep[]): Promise<ModelHandle> {
  const runtime = await createRuntime();
  const faux = fauxProvider({
    api: "aiteam-solution-authoring-faux-api",
    provider: "aiteam-solution-authoring-faux",
    models: [{ id: "solution-authoring-faux-1", name: "Solution Authoring Faux", input: [...input] }],
  });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { runtime, model: faux.getModel(), supportsImages: input.includes("image"), thinkingLevel: "off" };
}
