import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { SkillCatalog, ConnectorCatalog, MemoryPolicyCatalog } from "./types";
const M = "/api/manager";
export interface CapabilityApi {
  listSkills: () => Promise<SkillCatalog[]>;
  listConnectors: () => Promise<ConnectorCatalog[]>;
  listMemoryPolicies: () => Promise<MemoryPolicyCatalog[]>;
}
export function useCapabilityApi(): CapabilityApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const c = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listSkills() { return (await c.listGet<SkillCatalog>(`${M}/skills`)).items; },
      async listConnectors() { return (await c.listGet<ConnectorCatalog>(`${M}/connectors`)).items; },
      async listMemoryPolicies() { return (await c.listGet<MemoryPolicyCatalog>(`${M}/memory-policies`)).items; },
    };
  }, [token, onUnauthorized]);
}
