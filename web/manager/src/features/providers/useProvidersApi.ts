import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  CreateProviderInput,
  ProviderCredential,
  UpdateProviderInput,
} from "./types";

const BASE = "/api/manager/provider-credentials";

export interface ProvidersApi {
  list: () => Promise<ProviderCredential[]>;
  get: (id: string) => Promise<ProviderCredential | null>;
  create: (input: CreateProviderInput) => Promise<ProviderCredential | null>;
  update: (id: string, input: UpdateProviderInput) => Promise<ProviderCredential | null>;
  del: (id: string) => Promise<void>;
}

export function useProvidersApi(): ProvidersApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list() { return (await client.listGet<ProviderCredential>(BASE)).items; },
      get: (id) => client.get<ProviderCredential>(`${BASE}/${id}`),
      create: (input) => client.post<ProviderCredential>(BASE, { body: input }),
      update: (id, input) => client.put<ProviderCredential>(`${BASE}/${id}`, { body: input }),
      async del(id) { await client.del(`${BASE}/${id}`); },
    };
  }, [token, onUnauthorized]);
}
