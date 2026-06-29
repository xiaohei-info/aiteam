import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { CollabTemplate } from "./types";

export interface CollabApi { get: () => Promise<CollabTemplate | null>; update: (body: Partial<CollabTemplate>) => Promise<CollabTemplate | null>; }

export function useCollabApi(): CollabApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<CollabApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      get() { return client.get<CollabTemplate>("/api/manager/collaboration-template"); },
      update(body) { return client.put<CollabTemplate>("/api/manager/collaboration-template", { body }); },
    };
  }, [token, onUnauthorized]);
}
