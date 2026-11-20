import { useMemo } from "react";
import { createOperationApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { ClawHubResolve, DownloadedSkill, ExternalSkill, ExternalSkillPreview, InternalSkill } from "./types";

const BASE = "/api/operation/skill-market";

export function useSkillMarketApi() {
  const { token } = useSession();
  return useMemo(() => {
    const client = createOperationApiClient({ getToken: () => token });
    /** 搜索时没有分页；浏览时 nextCursor 非空表示还有下一页。 */
    async function browseExternal(q?: string, cursor?: string | null): Promise<{ items: ExternalSkill[]; nextCursor: string | null }> {
      const query: Record<string, string> = {};
      if (q) query.q = q;
      if (cursor) query.cursor = cursor;
      const result = await client.listGet<ExternalSkill>(`${BASE}/external`, { query: Object.keys(query).length ? query : undefined });
      return { items: Array.isArray(result.items) ? result.items : [], nextCursor: result.page?.next_cursor ?? null };
    }
    return {
      async listExternal(q?: string): Promise<ExternalSkill[]> {
        return (await browseExternal(q)).items;
      },
      browseExternal,
      preview(owner: string, slug: string, version?: string | null) {
        return client.get<ExternalSkillPreview>(`${BASE}/external/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/preview`, {
          query: version ? { version } : undefined,
        });
      },
      resolve(url: string) {
        return client.get<ClawHubResolve>(`${BASE}/external/resolve`, { query: { url } });
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
