import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../api/client";
import * as clientMod from "../../api/client";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import type { AuthSession } from "@aiteam/shared";
import { useExpertsApi } from "./useExpertsApi";

describe("useExpertsApi", () => {
  it("lists departments through the Manager endpoint", async () => {
    const sessionValue: SessionContextValue = {
      session: { principal: { id: "u1", tenant_id: "t1", display_name: "Owner", status: "active", roles: ["owner"] }, claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: 9_999_999_999 } } as AuthSession,
      token: "token", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
    };
    const client = { listGet: vi.fn().mockResolvedValue({ items: [{ id: "d1" }], page: { next_cursor: null, has_more: false } }) };
    vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
    const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sessionValue}>{children}</SessionContext.Provider>;
    const { result } = renderHook(() => useExpertsApi(), { wrapper });
    await expect(result.current.listDepartments?.()).resolves.toEqual([{ id: "d1" }]);
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/departments");
  });
});
