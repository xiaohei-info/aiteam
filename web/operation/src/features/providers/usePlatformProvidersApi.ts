import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  GatewayChannel,
  GatewayChannelInput,
  GatewayChannelTestResult,
  GatewayChannelType,
  ModelCapabilitiesInput,
  PlatformModel,
  PlatformModelRate,
  PlatformModelWithRate,
  PlatformProvider,
  PublicPricingSyncResult,
  UpstreamModelPreviewInput,
} from "./types";

const BASE = "/api/operation/providers";

export function usePlatformProvidersApi() {
  const { token } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token });
    const channels = (providerId: string) => `${BASE}/${providerId}/channels`;
    return {
      async list(): Promise<PlatformProvider[]> { return (await client.listGet<PlatformProvider>(BASE)).items; },
      async models(providerId: string): Promise<PlatformModelWithRate[]> {
        const data = await client.get<{ items: PlatformModelWithRate[] }>(`${BASE}/${providerId}/models`);
        return data?.items ?? [];
      },
      syncPublicPrices(providerId: string) {
        return client.post<PublicPricingSyncResult>(`${BASE}/${providerId}/sync-public-prices`);
      },
      publishModel(providerId: string, modelId: string) { return client.post<PlatformModel>(`${BASE}/${providerId}/models/publish`, { body: { model_id: modelId } }); },
      publishPricedModels(providerId: string) { return client.post<{ published: number }>(`${BASE}/${providerId}/models/publish-priced`); },
      setRate(providerId: string, input: Record<string, unknown>) { return client.post<PlatformModelRate>(`${BASE}/${providerId}/rates`, { body: input }); },
      async channelTypes(providerId: string): Promise<GatewayChannelType[]> {
        return (await client.listGet<GatewayChannelType>(`${BASE}/${providerId}/channel-types`)).items;
      },
      async channels(providerId: string): Promise<GatewayChannel[]> { return (await client.listGet<GatewayChannel>(channels(providerId))).items; },
      createChannel(providerId: string, input: GatewayChannelInput) { return client.post<GatewayChannel>(channels(providerId), { body: input }); },
      updateChannel(providerId: string, channelId: number, input: GatewayChannelInput) {
        return client.put<GatewayChannel>(`${channels(providerId)}/${channelId}`, { body: input });
      },
      deleteChannel(providerId: string, channelId: number) { return client.del<null>(`${channels(providerId)}/${channelId}`); },
      setChannelEnabled(providerId: string, channelId: number, enabled: boolean) {
        return client.post<GatewayChannel>(`${channels(providerId)}/${channelId}/status`, { body: { enabled } });
      },
      testChannel(providerId: string, channelId: number, model?: string) {
        return client.post<GatewayChannelTestResult>(`${channels(providerId)}/${channelId}/test`, { body: { model: model || null } });
      },
      async upstreamModels(providerId: string, input: UpstreamModelPreviewInput): Promise<string[]> {
        return (await client.post<{ models: string[] }>(`${channels(providerId)}/upstream-models`, { body: input }))?.models ?? [];
      },
      updateModelCapabilities(providerId: string, modelId: string, input: ModelCapabilitiesInput) {
        return client.put<PlatformModel>(`${BASE}/${providerId}/models/${encodeURIComponent(modelId)}/capabilities`, { body: input });
      },
    };
  }, [token]);
}
