import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { ConnectorStatus, ConnectorTestResult, ConnectorPreset } from "./types";

export interface ConnectorsApi {
  getPresets: () => Promise<ConnectorPreset[]>;
  getStatus: (id: string) => Promise<ConnectorStatus | null>;
  test: (id: string) => Promise<ConnectorTestResult | null>;
  setGrants: (id: string, employeeIds: string[], action: string) => Promise<unknown>;
}

export function useConnectorsApi(): ConnectorsApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<ConnectorsApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async getPresets() { return (await client.get<ConnectorPreset[]>("/api/manager/connectors/presets")) ?? []; },
      getStatus(connector_id) { return client.get<ConnectorStatus>(`/api/manager/connectors/${connector_id}/status`); },
      test(connector_id) { return client.post<ConnectorTestResult>(`/api/manager/connectors/${connector_id}/test`); },
      setGrants(connector_id, employee_ids, action) { return client.patch(`/api/manager/connectors/${connector_id}/grants`, { body: { employee_ids, action } }); },
    };
  }, [token, onUnauthorized]);
}
