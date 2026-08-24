import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { DownloadedSkill, ExternalSkill, InternalSkill } from "./types";

const BASE = "/api/operation/skill-market";

export function useSkillMarketApi() {
  const { token } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token });
    return {
      async listExternal(q?: string): Promise<ExternalSkill[]> {
        const data = await client.get<ExternalSkill[]>(`${BASE}/external`, { query: q ? { q } : undefined });
        return Array.isArray(data) ? data : [];
      },
      async listInternal(): Promise<InternalSkill[]> {
        const items = (await client.listGet<InternalSkill>(`${BASE}/internal`)).items;
        return Array.isArray(items) ? items : [];
      },
      download(owner: string, slug: string, version?: string | null) {
        return client.post<DownloadedSkill>(`${BASE}/external/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/download`, {
          query: version ? { version } : undefined,
          body: {},
        });
      },
      publish(skillId: string) {
        return client.post<InternalSkill>(`${BASE}/internal/${encodeURIComponent(skillId)}/publish`);
      },
      unpublish(skillId: string) {
        return client.post<InternalSkill>(`${BASE}/internal/${encodeURIComponent(skillId)}/unpublish`);
      },
      async getSettings(): Promise<{ auto_publish_downloads: boolean }> {
        return (await client.get<{ auto_publish_downloads: boolean }>(`${BASE}/settings`)) ?? { auto_publish_downloads: true };
      },
      setSettings(auto_publish_downloads: boolean) {
        return client.put<{ auto_publish_downloads: boolean }>(`${BASE}/settings`, { body: { auto_publish_downloads } });
      },
    };
  }, [token]);
}
