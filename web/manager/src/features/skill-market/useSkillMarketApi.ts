import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { PlatformSkillMarketItem } from "./types";

export function useSkillMarketApi() {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async list(): Promise<PlatformSkillMarketItem[]> {
        return (await client.listGet<PlatformSkillMarketItem>("/api/manager/skill-market")).items;
      },
      install(item: PlatformSkillMarketItem) {
        if (!item.published_version || !item.content_hash) throw new Error("平台技能没有可安装版本");
        return client.post(`/api/manager/skill-market/${encodeURIComponent(item.skill_id)}/install`, {
          body: { skill_id: item.skill_id, version: item.published_version, content_hash: item.content_hash },
        });
      },
    };
  }, [token, onUnauthorized]);
}
