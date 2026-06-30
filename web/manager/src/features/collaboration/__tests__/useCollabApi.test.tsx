import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useCollabApi } from "../useCollabApi";
import type { AuthSession } from "@aiteam/shared";

function setup() {
  const sv: SessionContextValue = { session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
  const client = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>;
  return { client, wrapper };
}

describe("useCollabApi", () => {
  it("get 调用 client.get", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useCollabApi(), { wrapper }); await result.current.get(); expect(client.get).toHaveBeenCalledWith("/api/manager/collaboration-template"); });
  it("update 调用 client.put", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useCollabApi(), { wrapper }); await result.current.update({ title: "T" }); expect(client.put).toHaveBeenCalledWith("/api/manager/collaboration-template", { body: { title: "T" } }); });
});
