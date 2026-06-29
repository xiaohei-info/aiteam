import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { EnterpriseSettings, AdminInvite } from "./types";

export interface SettingsApi {
  get: () => Promise<EnterpriseSettings | null>;
  update: (body: Partial<EnterpriseSettings>) => Promise<EnterpriseSettings | null>;
  listInvites: () => Promise<AdminInvite[]>;
  createInvite: (phone: string, displayName?: string) => Promise<AdminInvite | null>;
  deleteInvite: (id: string) => Promise<unknown>;
}

export function useSettingsApi(): SettingsApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<SettingsApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      get() { return client.get<EnterpriseSettings>("/api/manager/settings"); },
      update(body) { return client.patch<EnterpriseSettings>("/api/manager/settings", { body }); },
      async listInvites() { const r = await client.listGet<AdminInvite>("/api/manager/settings/admin-invites"); return r.items ?? []; },
      createInvite(phone, display_name = "") { return client.post<AdminInvite>("/api/manager/settings/admin-invites", { body: { phone, display_name } }); },
      deleteInvite(invite_id) { return client.delete(`/api/manager/settings/admin-invites/${invite_id}`); },
    };
  }, [token, onUnauthorized]);
}
