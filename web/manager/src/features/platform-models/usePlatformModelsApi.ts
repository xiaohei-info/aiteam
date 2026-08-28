import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";

export interface PlatformProvider {
  provider_id: string; provider_code: string; display_name: string; status: string; version: number;
}
export interface PlatformRate {
  pricing_version: number; pricing_status: "known" | "unknown";
  input_usd_per_million: string | null; output_usd_per_million: string | null;
  cache_read_usd_per_million: string | null; cache_write_usd_per_million: string | null;
  currency: "USD";
}
export interface PlatformModelItem {
  model: { provider_id: string; model_id: string; display_name: string; status: string; version: number };
  rate: PlatformRate | null;
}
export interface PlatformCatalog { providers: PlatformProvider[]; models: PlatformModelItem[]; }

export function usePlatformModelsApi() {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return ({
    async list(): Promise<PlatformCatalog> {
      return (await client.get<PlatformCatalog>("/api/manager/platform-models")) ?? { providers: [], models: [] };
    },
  });
  }, [token, onUnauthorized]);
}
