import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { LlmProvider, LlmModel } from "./types";

export interface LlmApi {
  listProviders: () => Promise<LlmProvider[]>;
  createProvider: (body: { name: string; provider_key: string; base_url?: string }) => Promise<LlmProvider | null>;
  patchProvider: (id: string, body: Partial<LlmProvider>) => Promise<LlmProvider | null>;
  deleteProvider: (id: string) => Promise<unknown>;
  listModels: (providerId?: string) => Promise<LlmModel[]>;
  createModel: (providerId: string, body: { model_uid: string; model_name: string; context_window?: number }) => Promise<LlmModel | null>;
  deleteModel: (id: string) => Promise<unknown>;
}

export function useLlmApi(): LlmApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<LlmApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listProviders() { const r = await client.listGet<LlmProvider>("/api/manager/llm/providers"); return r.items ?? []; },
      createProvider(body) { return client.post<LlmProvider>("/api/manager/llm/providers", { body }); },
      patchProvider(provider_id, body) { return client.patch<LlmProvider>(`/api/manager/llm/providers/${provider_id}`, { body }); },
      deleteProvider(provider_id) { return client.delete(`/api/manager/llm/providers/${provider_id}`); },
      async listModels(provider_id) { const sp = provider_id ? `?provider_id=${provider_id}` : ""; const r = await client.listGet<LlmModel>(`/api/manager/llm/models${sp}`); return r.items ?? []; },
      createModel(provider_id, body) { return client.post<LlmModel>(`/api/manager/llm/providers/${provider_id}/models`, { body }); },
      deleteModel(model_id) { return client.delete(`/api/manager/llm/models/${model_id}`); },
    };
  }, [token, onUnauthorized]);
}
