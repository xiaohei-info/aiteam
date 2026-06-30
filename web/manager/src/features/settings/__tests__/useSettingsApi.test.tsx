import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useSettingsApi } from "../useSettingsApi";
import type { AuthSession } from "@aiteam/shared";

function setup() {
  const sv: SessionContextValue = { session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
  const client = { get: vi.fn().mockResolvedValue(null), patch: vi.fn().mockResolvedValue(null), listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }), post: vi.fn().mockResolvedValue(null), del: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>;
  return { client, wrapper };
}

describe("useSettingsApi", () => {
  it("get 调用 client.get", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.get(); expect(client.get).toHaveBeenCalledWith("/api/manager/settings"); });
  it("update 调用 client.patch", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.update({ enterprise_name: "New" }); expect(client.patch).toHaveBeenCalledWith("/api/manager/settings", { body: { enterprise_name: "New" } }); });
  it("listInvites 调用 listGet", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.listInvites(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/settings/admin-invites"); });
  it("createInvite 调用 client.post", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.createInvite("13800138000", "Admin"); expect(client.post).toHaveBeenCalledWith("/api/manager/settings/admin-invites", { body: { phone: "13800138000", display_name: "Admin" } }); });
  it("createInvite 默认 display_name 为空", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.createInvite("13800138000"); expect(client.post).toHaveBeenCalledWith("/api/manager/settings/admin-invites", { body: { phone: "13800138000", display_name: "" } }); });
  it("deleteInvite 调用 client.del", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useSettingsApi(), { wrapper }); await result.current.deleteInvite("i1"); expect(client.del).toHaveBeenCalledWith("/api/manager/settings/admin-invites/i1"); });
});
