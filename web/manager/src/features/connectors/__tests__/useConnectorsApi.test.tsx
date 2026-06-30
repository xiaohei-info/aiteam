import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useConnectorsApi } from "../useConnectorsApi";
import type { AuthSession } from "@aiteam/shared";

function setup() {
  const sv: SessionContextValue = { session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
  const client = { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue(null), listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }), patch: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>;
  return { client, wrapper };
}

describe("useConnectorsApi", () => {
  it("getPresets 调用 client.get", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useConnectorsApi(), { wrapper }); await result.current.getPresets(); expect(client.get).toHaveBeenCalledWith("/api/manager/connectors/presets"); });
  it("getStatus 调用 client.get", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useConnectorsApi(), { wrapper }); await result.current.getStatus("c1"); expect(client.get).toHaveBeenCalledWith("/api/manager/connectors/c1/status"); });
  it("test 调用 client.post", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useConnectorsApi(), { wrapper }); await result.current.test("c1"); expect(client.post).toHaveBeenCalledWith("/api/manager/connectors/c1/test"); });
  it("setGrants 调用 client.patch", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useConnectorsApi(), { wrapper }); await result.current.setGrants("c1", ["e1"], "grant"); expect(client.patch).toHaveBeenCalledWith("/api/manager/connectors/c1/grants", { body: { employee_ids: ["e1"], action: "grant" } }); });
});
