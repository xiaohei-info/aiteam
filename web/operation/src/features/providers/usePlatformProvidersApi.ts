import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { PlatformModel, PlatformModelRate, PlatformModelWithRate, PlatformProvider, PublicPricingSyncResult } from "./types";

const BASE = "/api/operation/providers";

export function usePlatformProvidersApi() {
  const { token } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token });
    return {
      async list(): Promise<PlatformProvider[]> { return (await client.listGet<PlatformProvider>(BASE)).items; },
      create(input: { provider_code: string; display_name: string; api_protocol: string; newapi_channel_id: number }) {
        return client.post<PlatformProvider>(BASE, { body: input });
      },
      async models(providerId: string): Promise<PlatformModelWithRate[]> {
        const data = await client.get<{ items: PlatformModelWithRate[] }>(`${BASE}/${providerId}/models`);
        return data?.items ?? [];
      },
      async sync(providerId: string): Promise<PlatformModel[]> {
        return (await client.post<PlatformModel[]>(`${BASE}/${providerId}/sync-models`)) ?? [];
      },
      syncPublicPrices(providerId: string) {
        return client.post<PublicPricingSyncResult>(`${BASE}/${providerId}/sync-public-prices`);
      },
      publishProvider(providerId: string) { return client.post<PlatformProvider>(`${BASE}/${providerId}/publish`); },
      publishModel(providerId: string, modelId: string) { return client.post<PlatformModel>(`${BASE}/${providerId}/models/publish`, { body: { model_id: modelId } }); },
      publishPricedModels(providerId: string) { return client.post<{ published: number }>(`${BASE}/${providerId}/models/publish-priced`); },
      setRate(providerId: string, input: Record<string, unknown>) { return client.post<PlatformModelRate>(`${BASE}/${providerId}/rates`, { body: input }); },
    };
  }, [token]);
}
